import type { AgentEvent, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentQuestionInfo } from './types.js';
import type { HerdrAgentCli } from './herdr-agent-cli.js';
import type { DeskRegistry } from './desk-target.js';
import { parseDeskDialog, type DeskDialog } from './desk-dialog.js';

/**
 * Only runs while a phone is attached to the session, so this is a cost per
 * open chat rather than a standing background one. Fast enough that a dialog
 * reaches the phone about as soon as it is drawn on screen.
 */
export const DESK_POLL_MS = 1_500;

/**
 * How long herdr may take to show the pane leaving `blocked` after keys land.
 * Generous, because an answer usually starts a turn and herdr has to observe
 * the transition; short enough that a wedged dialog is reported rather than
 * left spinning on the phone.
 */
const CONFIRM_TIMEOUT_MS = 8_000;

interface PendingQuestion {
  info: AgentQuestionInfo;
  sessionId: string;
  paneId: string;
  dialog: DeskDialog;
  /** herdr's own change counter, the other half of the race fingerprint. */
  stateChangeSeq: number | null;
  onEvent: (event: AgentEvent) => void;
}

/**
 * Turns a dialog an agent has drawn in a pane at the desk into a question the
 * phone can answer.
 *
 * This covers what `PermissionBroker` cannot. That path is a hook on the Claude
 * process: it intercepts a *tool call* before Claude renders its own dialog. It
 * has no answer for opencode, which has no such hook, and none for anything
 * that is not a tool permission — a `/model` picker, a plan presented for
 * approval, an AskUserQuestion list. Those are TUI dialogs; no API exposes them.
 *
 * Deliberately reuses `AgentEvent`'s existing `question` shape rather than
 * growing a new one, so the phone's QuestionCard renders it with no client
 * change at all.
 */
export class DeskQuestionWatcher {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly pollMs: number;

  constructor(
    private readonly cli: HerdrAgentCli,
    private readonly desk: DeskRegistry,
    opts: { pollMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? DESK_POLL_MS;
  }

  watch(agent: AgentKind, sessionId: string, onEvent: (event: AgentEvent) => void): Unsubscribe {
    let stopped = false;
    let timer: NodeJS.Timeout;

    const tick = async (): Promise<void> => {
      try {
        await this.poll(agent, sessionId, onEvent);
      } catch {
        // herdr down, or a pane that vanished. The next tick retries; a failing
        // poll must never tear down the transcript stream it rides alongside.
      }
      if (!stopped) timer = setTimeout(tick, this.pollMs).unref();
    };
    // unref: a poller that only mirrors somebody else's dialog has no business
    // keeping the daemon alive on its own.
    timer = setTimeout(tick, 0).unref();

    return () => {
      stopped = true;
      clearTimeout(timer);
      // A pending approval must not outlive the phone that could answer it.
      for (const [requestId, entry] of this.pending) {
        if (entry.sessionId === sessionId) this.pending.delete(requestId);
      }
    };
  }

  private async poll(
    agent: AgentKind, sessionId: string, onEvent: (event: AgentEvent) => void,
  ): Promise<void> {
    const target = await this.desk.lookup(agent, sessionId);
    // tmux publishes no status, so there is no signal that a dialog is up and
    // nothing to poll. Those sessions keep the PermissionBroker hook path.
    if (!target || target.mux !== 'herdr') return;
    if (target.status !== 'blocked') return;

    const rendered = await this.cli.read(target.paneId);
    if (!rendered) return;
    const dialog = parseDeskDialog(rendered);
    if (!dialog) return;

    const existing = [...this.pending.values()].find((entry) => entry.sessionId === sessionId);
    if (existing?.dialog.fingerprint === dialog.fingerprint) return;
    if (existing) this.pending.delete(existing.info.requestId);

    const requestId = `desk:${target.paneId}:${dialog.fingerprint}`;
    const info: AgentQuestionInfo = {
      requestId,
      sessionId,
      agent,
      prompt: dialog.prompt,
      kind: dialog.kind,
      options: dialog.options.map((option) => ({ label: option.label })),
      createdAt: new Date().toISOString(),
      // The phone renders this as a radio group rather than checkboxes: the
      // answer is one keystroke, and a second tick would silently pick whichever
      // label happened to come first.
      origin: 'desk',
    };

    this.pending.set(requestId, {
      info,
      sessionId,
      paneId: target.paneId,
      dialog,
      stateChangeSeq: (await this.cli.get(target.paneId))?.stateChangeSeq ?? null,
      onEvent,
    });
    onEvent({ kind: 'question', sessionId, seq: -1, request: info });
  }

  /**
   * Answer a desk dialog.
   *
   * Returns false — rather than throwing — when the id belongs to somebody
   * else, so the caller can fall through to the SDK sessions that hold their
   * own resolvers.
   */
  async respond(requestId: string, answers?: string[], rejected?: boolean): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    try {
      await this.deliver(entry, answers, rejected);
    } catch (err) {
      // index.ts swallows a rejected respondQuestion, and has no session id to
      // report against anyway. The watcher has both, so it reports here: a
      // phone that says "approved" while the dialog is still up is worse than
      // one that says nothing.
      entry.onEvent({
        kind: 'status', sessionId: entry.sessionId, seq: -1,
        status: 'error', detail: (err as Error).message,
      });
      throw err;
    } finally {
      this.pending.delete(requestId);
    }
    return true;
  }

  private async deliver(
    entry: PendingQuestion, answers?: string[], rejected?: boolean,
  ): Promise<void> {
    const keys = answerKeys(entry.dialog, answers, rejected);
    if (!keys) throw new Error('That answer is not one of the options shown.');

    // Re-check immediately before the keys go out. The user may have answered
    // at the keyboard while the phone was deciding, and sending "2" into
    // whatever dialog came next types a literal 2.
    const now = await this.cli.get(entry.paneId);
    const rendered = now?.status === 'blocked' ? await this.cli.read(entry.paneId) : null;
    const current = rendered ? parseDeskDialog(rendered) : null;
    if (
      !now
      || now.status !== 'blocked'
      || now.stateChangeSeq !== entry.stateChangeSeq
      || current?.fingerprint !== entry.dialog.fingerprint
    ) {
      throw new Error('That prompt was already answered at your desk.');
    }

    await this.cli.sendKeys(entry.paneId, keys);

    // Accepted is not delivered. Confirm the pane actually left the dialog —
    // either by settling, or by moving on to a different one, which is what a
    // chain of prompts looks like.
    if (await this.cli.wait(entry.paneId, ['idle', 'done', 'working'], CONFIRM_TIMEOUT_MS)) return;

    const after = await this.cli.read(entry.paneId);
    const stillThere = after ? parseDeskDialog(after) : null;
    if (stillThere?.fingerprint === entry.dialog.fingerprint) {
      throw new Error('The prompt is still up at your desk — your answer did not take.');
    }
  }
}

/**
 * The keys that answer `dialog`, or null when the answer does not fit it.
 *
 * The three input mechanisms are genuinely different: a digit selects in a
 * numbered list and is a literal character everywhere else, and an arrow list
 * has to be walked from wherever the cursor currently sits.
 */
export function answerKeys(
  dialog: DeskDialog,
  answers: string[] | undefined,
  rejected: boolean | undefined,
  /**
   * Absolute position of the highlighted row, supplied by correlation.
   *
   * The dialog's own `selected` index counts within the visible window, so on a
   * scrolled list it is short by the window offset and walking from it lands on
   * the wrong option.
   */
  cursorOverride?: number,
): string[] | null {
  if (rejected) return ['esc'];

  const answer = answers?.[0];
  if (typeof answer !== 'string' || !answer) return null;

  if (dialog.kind === 'freeform') {
    // Only ever emitted when the parser found no option rows at all, so there
    // is no highlighted choice for Enter to confirm by accident. That is what
    // makes typing here an answer rather than an invented approval.
    return [answer, 'enter'];
  }

  const chosen = dialog.options.find((option) => option.label === answer);
  if (!chosen) return null;

  // A digit key selects only 1..9. Sending "1" "0" for option 10 selects
  // option 1 and looks like it worked, so anything past 9 walks instead.
  if (dialog.input === 'numbered' && chosen.index <= 9 && cursorOverride === undefined) {
    return [String(chosen.index)];
  }

  const cursor = cursorOverride ?? dialog.options.find((option) => option.selected)?.index;
  // No cursor row and no override means there is no confirmed position to walk
  // from, and guessing one picks an arbitrary option.
  if (cursor === undefined) return null;

  const delta = chosen.index - cursor;
  return [...Array<string>(Math.abs(delta)).fill(delta >= 0 ? 'down' : 'up'), 'enter'];
}
