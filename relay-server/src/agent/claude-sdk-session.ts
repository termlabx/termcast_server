import type { AgentEvent, PermissionBehavior } from './adapter.js';
import type { AgentQuestionInfo, MessageBlock } from './types.js';
import { parseAskUserQuestion } from './ask-user-question.js';

const MAX_BLOCK_CHARS = 2048;

/**
 * How long a question may hold the agent.
 *
 * Matches PermissionBroker, which solved the same problem for tool approvals: a
 * `canUseTool` promise nobody settles blocks the turn forever, and an agent
 * wedged behind a card the user never saw is indistinguishable from a hung one.
 */
export const QUESTION_TIMEOUT_MS = 540_000;

/**
 * One AskUserQuestion call fans out into one card per member question.
 *
 * The call carries up to four questions, each with its own options and its own
 * multiSelect. Collapsing them into a single card — which is what the previous
 * reader's shape implied — loses every question after the first.
 */
export function buildQuestionEvents(
  input: unknown,
  ctx: { sessionId: string; requestId: string },
): AgentQuestionInfo[] {
  const parsed = parseAskUserQuestion(input);
  const groupId = ctx.requestId;
  const createdAt = new Date().toISOString();

  return parsed.map((question, index) => ({
    // Distinct per member: a shared id would let one answer resolve them all.
    requestId: `${groupId}#${index}`,
    sessionId: ctx.sessionId,
    agent: 'claude' as const,
    prompt: question.prompt,
    header: question.header,
    kind: question.options.length > 0 ? ('select' as const) : ('freeform' as const),
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    // Absent rather than false: the phone reads absent as "not multi-select",
    // and spelling out false on every question bloats every frame for no gain.
    multiSelect: question.multiSelect ? true : undefined,
    // AskUserQuestion always accepts an answer that is not on the list.
    allowsOther: true,
    groupId,
    groupIndex: index,
    groupCount: parsed.length,
    createdAt,
    origin: 'agent' as const,
  }));
}

/**
 * The result shape the tool expects: each question echoed back with the labels
 * chosen for it.
 *
 * The previous code returned `{...input, answer: 'a, b'}`, which the tool does
 * not read — so a correct tap on the phone still produced a wrong answer.
 */
export function askUserQuestionResult(
  input: unknown,
  chosen: string[][],
): { answers: { header?: string; question: string; selected: string[] }[] } {
  return {
    answers: parseAskUserQuestion(input).map((question, index) => ({
      header: question.header,
      question: question.prompt,
      selected: chosen[index] ?? [],
    })),
  };
}

function clamp(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_BLOCK_CHARS
    ? { text: text.slice(0, MAX_BLOCK_CHARS), truncated: true }
    : { text, truncated: false };
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

function summarise(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name;
  const fields = input as Record<string, unknown>;
  if (typeof fields.command === 'string') return oneLine(fields.command);
  if (typeof fields.file_path === 'string') return `${name} ${fields.file_path.split('/').pop()}`;
  return name;
}

/**
 * Map one SDK message's content blocks onto the normalized schema.
 *
 * Kept separate from process management because this is the part with real
 * behavior worth testing; anything unrecognised is skipped so a newer SDK
 * cannot break rendering.
 */
export function sdkMessageToBlocks(raw: unknown): MessageBlock[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const blocks: MessageBlock[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const part = item as Record<string, unknown>;

    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      blocks.push({ kind: 'text', text: part.text });
    } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking) {
      blocks.push({ kind: 'thinking', text: part.thinking });
    } else if (part.type === 'tool_use') {
      const name = typeof part.name === 'string' ? part.name : 'tool';
      const input = clamp(JSON.stringify(part.input ?? {}));
      blocks.push({
        kind: 'toolUse',
        toolUseId: typeof part.id === 'string' ? part.id : '',
        name,
        summary: summarise(name, part.input),
        input: input.text,
        truncated: input.truncated,
      });
    } else if (part.type === 'tool_result') {
      const preview = clamp(typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? ''));
      blocks.push({
        kind: 'toolResult',
        toolUseId: typeof part.tool_use_id === 'string' ? part.tool_use_id : '',
        ok: part.is_error !== true,
        preview: preview.text,
        truncated: preview.truncated,
      });
    }
  }
  return blocks;
}

type PermissionResolver = (behavior: PermissionBehavior) => void;
type QuestionResolver = (answers?: string[], rejected?: boolean) => void;

/**
 * A headless Claude Code session driven by the phone.
 *
 * Uses the SDK rather than spawning the CLI with stream-json so tool approval
 * arrives through canUseTool as a structured callback — no TUI anywhere in the
 * loop, which is what makes a native chat UI possible for resumed sessions.
 */
export class ClaudeSdkSession {
  private queue: string[] = [];
  private notify: (() => void) | null = null;
  private running = false;
  private seq = 0;
  private listener: ((event: AgentEvent) => void) | null = null;
  private readonly pending = new Map<string, PermissionResolver>();
  private readonly pendingQuestions = new Map<string, QuestionResolver>();

  constructor(private readonly sessionId: string, private readonly cwd: string) {}

  onEvent(callback: (event: AgentEvent) => void): void {
    this.listener = callback;
  }

  private emit(event: AgentEvent): void {
    this.listener?.(event);
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Resolve a permission this session is blocked on. */
  resolvePermission(requestId: string, behavior: PermissionBehavior): boolean {
    const resolver = this.pending.get(requestId);
    if (!resolver) return false;
    this.pending.delete(requestId);
    resolver(behavior);
    return true;
  }

  /** Resolve a question this session is blocked on. */
  resolveQuestion(requestId: string, answers?: string[], rejected?: boolean): boolean {
    const resolver = this.pendingQuestions.get(requestId);
    if (!resolver) return false;
    this.pendingQuestions.delete(requestId);
    resolver(answers, rejected);
    return true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const inputs = async function* (this: ClaudeSdkSession) {
      while (this.running) {
        while (this.queue.length === 0 && this.running) {
          await new Promise<void>((resolve) => { this.notify = resolve; });
        }
        const text = this.queue.shift();
        if (text === undefined) continue;
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: text },
          parent_tool_use_id: null,
        };
      }
    }.bind(this)();

    const stream = query({
      prompt: inputs,
      options: {
        resume: this.sessionId,
        cwd: this.cwd,
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          const requestId = `${this.sessionId}:${this.nextSeq()}`;

          if (toolName === 'AskUserQuestion') {
            const infos = buildQuestionEvents(input, { sessionId: this.sessionId, requestId });
            if (infos.length === 0) {
              // Nothing answerable in the call. Let it through untouched rather
              // than holding the turn behind a card that would render empty.
              return { behavior: 'allow' as const, updatedInput: input };
            }

            const chosen: string[][] = infos.map(() => []);
            let outstanding = infos.length;
            let rejectedAll = false;

            const settled = new Promise<void>((resolve) => {
              for (const [index, info] of infos.entries()) {
                this.pendingQuestions.set(info.requestId, (answers, rejected) => {
                  // Rejecting one member cancels the whole call: the tool has no
                  // notion of a partially declined question.
                  if (rejected) { rejectedAll = true; resolve(); return; }
                  chosen[index] = answers ?? [];
                  outstanding -= 1;
                  if (outstanding === 0) resolve();
                });
                this.emit({
                  kind: 'question', sessionId: this.sessionId, seq: this.nextSeq(), request: info,
                });
              }
            });

            let timer: NodeJS.Timeout | undefined;
            const timedOut = await Promise.race([
              settled.then(() => false),
              new Promise<boolean>((resolve) => {
                // unref: a question nobody is going to answer must not be the
                // reason the daemon stays alive.
                timer = setTimeout(() => resolve(true), QUESTION_TIMEOUT_MS);
                timer.unref();
              }),
            ]);
            clearTimeout(timer);

            for (const info of infos) {
              this.pendingQuestions.delete(info.requestId);
              this.emit({
                kind: 'questionResolved',
                sessionId: this.sessionId,
                seq: this.nextSeq(),
                requestId: info.requestId,
                outcome: timedOut ? 'expired' : rejectedAll ? 'rejected' : 'answered',
                answers: timedOut || rejectedAll ? undefined : chosen[info.groupIndex ?? 0],
                detail: timedOut ? 'Nobody answered in time, so the agent moved on.' : undefined,
              });
            }

            if (timedOut || rejectedAll) {
              return { behavior: 'deny' as const, message: 'Question rejected from phone' };
            }
            return {
              behavior: 'allow' as const,
              updatedInput: askUserQuestionResult(input, chosen) as unknown as Record<string, unknown>,
            };
          }

          const clamped = clamp(JSON.stringify(input ?? {}));
          this.emit({
            kind: 'permission',
            sessionId: this.sessionId,
            seq: this.nextSeq(),
            request: {
              requestId,
              sessionId: this.sessionId,
              agent: 'claude',
              toolName,
              toolUseId: requestId,
              summary: summarise(toolName, input),
              input: clamped.text,
              truncated: clamped.truncated,
              createdAt: new Date().toISOString(),
            },
          });

          const behavior = await new Promise<PermissionBehavior>((resolve) => {
            this.pending.set(requestId, resolve);
          });
          return behavior === 'allow'
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: 'Denied from phone' };
        },
      },
    });

    void (async () => {
      try {
        for await (const message of stream) {
          const raw = message as Record<string, unknown>;
          if (raw.type !== 'assistant' && raw.type !== 'user') continue;
          const blocks = sdkMessageToBlocks(raw.message);
          if (blocks.length === 0) continue;
          const seq = this.nextSeq();
          this.emit({
            kind: 'message',
            sessionId: this.sessionId,
            seq,
            message: {
              id: `sdk-${seq}`,
              seq,
              role: raw.type === 'assistant' ? 'assistant' : 'user',
              timestamp: new Date().toISOString(),
              blocks,
            },
          });
        }
        this.emit({ kind: 'status', sessionId: this.sessionId, seq: this.nextSeq(), status: 'turn_end' });
      } catch (err) {
        this.emit({
          kind: 'status', sessionId: this.sessionId, seq: this.nextSeq(),
          status: 'error', detail: (err as Error).message,
        });
      }
    })();
  }

  send(text: string): void {
    this.queue.push(text);
    this.notify?.();
    this.notify = null;
  }

  stop(): void {
    this.running = false;
    this.notify?.();
    this.notify = null;
    for (const [requestId, resolve] of this.pending) {
      this.pending.delete(requestId);
      resolve('deny');
    }
    for (const [requestId, resolve] of this.pendingQuestions) {
      this.pendingQuestions.delete(requestId);
      resolve(undefined, true);
    }
  }
}
