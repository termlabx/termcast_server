import type { AgentEvent, PermissionBehavior } from './adapter.js';
import type { AgentQuestionInfo, MessageBlock } from './types.js';

const MAX_BLOCK_CHARS = 2048;

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
            const prompt = typeof input.question === 'string' ? input.question :
              typeof input.prompt === 'string' ? input.prompt :
              summarise(toolName, input);
            const rawOptions = Array.isArray(input.options) ? input.options :
              Array.isArray(input.suggestions) ? input.suggestions : [];
            const options = rawOptions.map((o: unknown) => {
              const opt = o as Record<string, unknown>;
              return {
                label: typeof opt.label === 'string' ? opt.label : String(opt),
                description: typeof opt.description === 'string' ? opt.description : undefined,
              };
            });
            const kind = options.length > 0 ? 'select' : 'freeform';
            const info: AgentQuestionInfo = {
              requestId,
              sessionId: this.sessionId,
              agent: 'claude',
              prompt,
              kind,
              options,
              createdAt: new Date().toISOString(),
            };
            this.emit({ kind: 'question', sessionId: this.sessionId, seq: this.nextSeq(), request: info });

            const answers = await new Promise<string[] | undefined>((resolve) => {
              this.pendingQuestions.set(requestId, (a, r) => resolve(r ? undefined : a));
            });
            if (answers === undefined) {
              return { behavior: 'deny' as const, message: 'Question rejected from phone' };
            }
            return { behavior: 'allow' as const, updatedInput: { ...input, answer: answers.join(', ') } };
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
