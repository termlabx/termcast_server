import type { AgentEvent, AgentQuestionOutcome, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentQuestionInfo } from './types.js';
import type { HerdrAgentCli } from './herdr-agent-cli.js';
import type { DeskRegistry } from './desk-target.js';
import { parseDeskDialog, type DeskDialog } from './desk-dialog.js';
import { correlateDialog, type Correlated } from './desk-correlate.js';
import type { ParsedQuestion } from './ask-user-question.js';

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
  /**
   * The correlated view, when correlation succeeded. Absent means the pane's
   * own labels and highlighted row are all there is.
   */
  correlated?: Correlated;
  onEvent: (event: AgentEvent) => void;
}

export interface DeskQuestionOptions {
  pollMs?: number;
  /**
   * The newest unanswered AskUserQuestion in this session's transcript, when
   * the adapter can see one.
   *
   * Supplies what the pane cannot: descriptions, the untruncated labels, and
   * the real question text rather than whatever fit on screen.
   */
  latestAskUserQuestion?: (
    sessionId: string,
  ) => ParsedQuestion | null | Promise<ParsedQuestion | null>;
  /**
   * The session's current tail seq. Desk questions used to ship `seq: -1`,
   * which sorts them above the entire transcript once the phone places cards
   * inline by seq.
   */
  seqFor?: (sessionId: string) => number;
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
  private readonly latestAskUserQuestion?: DeskQuestionOptions['latestAskUserQuestion'];
  private readonly seqFor?: (sessionId: string) => number;

  constructor(
    private readonly cli: HerdrAgentCli,
    private readonly desk: DeskRegistry,
    opts: DeskQuestionOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? DESK_POLL_MS;
    this.latestAskUserQuestion = opts.latestAskUserQuestion;
    this.seqFor = opts.seqFor;
  }

  /** Where a card belongs in a transcript ordered by seq. */
  private seqOf(sessionId: string): number {
    return this.seqFor?.(sessionId) ?? 0;
  }

  private resolve(
    entry: PendingQuestion,
    outcome: AgentQuestionOutcome,
    extra: { answers?: string[]; detail?: string } = {},
  ): void {
    entry.onEvent({
      kind: 'questionResolved',
      sessionId: entry.sessionId,
      seq: this.seqOf(entry.sessionId),
      requestId: entry.info.requestId,
      outcome,
      ...extra,
    });
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
      // A pending approval must not outlive the phone that could answer it —
      // and it must say so. Dropping it silently leaves a card that looks live
      // and swallows the next tap.
      for (const [requestId, entry] of this.pending) {
        if (entry.sessionId !== sessionId) continue;
        this.pending.delete(requestId);
        this.resolve(entry, 'unavailable', {
          detail: 'The chat was closed before this was answered.',
        });
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

    // Structured first: the transcript has the real labels and descriptions,
    // the pane only has whatever fit on screen. Correlation refuses rather than
    // blending when the two disagree, so a null here is a safety result, not a
    // failure — the pane options below are still correct, just plainer.
    const structured = (await this.latestAskUserQuestion?.(sessionId)) ?? null;
    const merged = structured ? correlateDialog(structured, dialog) : null;

    const requestId = `desk:${target.paneId}:${dialog.fingerprint}`;
    const info: AgentQuestionInfo = {
      requestId,
      sessionId,
      agent,
      prompt: merged && structured ? structured.prompt : dialog.prompt,
      header: merged && structured ? structured.header : undefined,
      kind: dialog.kind,
      options: merged?.options ?? dialog.options.map((option) => ({
        label: option.label,
        index: option.index,
      })),
      // Deliberately not inherited from the structured question even when it
      // says multiSelect. A desk dialog is answered with one keystroke; ticking
      // two boxes would send whichever label the set happened to order first.
      multiSelect: undefined,
      // Likewise: there is nowhere to type free text unless the dialog drew an
      // input of its own, which is exactly the freeform case.
      allowsOther: dialog.kind === 'freeform' ? true : undefined,
      createdAt: new Date().toISOString(),
      origin: 'desk',
    };

    this.pending.set(requestId, {
      info,
      sessionId,
      paneId: target.paneId,
      dialog,
      stateChangeSeq: (await this.cli.get(target.paneId))?.stateChangeSeq ?? null,
      correlated: merged ?? undefined,
      onEvent,
    });
    onEvent({ kind: 'question', sessionId, seq: this.seqOf(sessionId), request: info });
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
    // Claimed before delivery, so a double tap cannot send a second keystroke
    // into a dialog the first tap already closed.
    this.pending.delete(requestId);

    try {
      await this.deliver(entry, answers, rejected);
    } catch (err) {
      const message = (err as Error).message;
      // index.ts swallows a rejected respondQuestion, and has no session id to
      // report against anyway. The watcher has both, so it reports here: a
      // phone that says "approved" while the dialog is still up is worse than
      // one that says nothing.
      entry.onEvent({
        kind: 'status', sessionId: entry.sessionId, seq: -1,
        status: 'error', detail: message,
      });
      this.resolve(entry, message.includes('already answered') ? 'answered_elsewhere' : 'unavailable', {
        detail: message,
      });
      throw err;
    }

    this.resolve(entry, rejected ? 'rejected' : 'answered', {
      answers: rejected ? undefined : answers,
    });
    return true;
  }

  private async deliver(
    entry: PendingQuestion, answers?: string[], rejected?: boolean,
  ): Promise<void> {
    const keys = answerKeys(entry.dialog, answers, rejected, entry.correlated);
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
   * The correlated view of this dialog, when there is one.
   *
   * Both halves matter. Its labels are the untruncated ones the phone actually
   * displayed, so matching the answer against the pane's clipped text would
   * fail — and on a windowed list the chosen option may not be on screen at
   * all, so only its absolute index can locate it. Its cursor is likewise
   * absolute, where the dialog's own `selected` counts within the window.
   */
  correlated?: Correlated,
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

  // Answers come back as the labels the phone showed, which are the correlated
  // ones when correlation succeeded.
  const targetIndex = correlated
    ? correlated.options.find((option) => option.label === answer)?.index
    : dialog.options.find((option) => option.label === answer)?.index;
  if (targetIndex === undefined) return null;

  // A digit key selects only 1..9. Sending "1" "0" for option 10 selects
  // option 1 and looks like it worked, so anything past 9 walks instead.
  // A windowed list is excluded too: its digits address the window, not the list.
  if (dialog.input === 'numbered' && targetIndex <= 9 && !dialog.windowed) {
    return [String(targetIndex)];
  }

  const cursor = correlated?.cursorIndex ?? dialog.options.find((option) => option.selected)?.index;
  // No cursor row and no correlation means there is no confirmed position to
  // walk from, and guessing one picks an arbitrary option.
  if (cursor === undefined) return null;

  const delta = targetIndex - cursor;
  return [...Array<string>(Math.abs(delta)).fill(delta >= 0 ? 'down' : 'up'), 'enter'];
}
