import type { AgentMessage, AgentSessionSummary, MessageBlock, MessageRole } from './types.js';

const MAX_BLOCK_CHARS = 2048;
const REQUEST_TIMEOUT_MS = 5000;

interface RawSession {
  id?: unknown; title?: unknown; model?: unknown;
  time?: { created?: unknown; updated?: unknown };
  location?: { directory?: unknown };
}

/**
 * Typed HTTP client for a running `opencode serve`.
 *
 * Every method degrades to an empty result instead of throwing: opencode may
 * not be installed, and an absent agent must contribute nothing rather than
 * breaking the whole session list.
 */
export class OpencodeClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Probes `/api/session` rather than a dedicated health route: session listing
   * is a route the server is known to expose, so a 200 here proves both that
   * something is listening and that it speaks the API we need.
   */
  async health(): Promise<boolean> {
    return (await this.get('/api/session')) !== null;
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    const body = await this.get('/api/session');
    const rows = asArray((body as { data?: unknown } | null)?.data);
    return rows.map((row) => this.toSummary(row as RawSession));
  }

  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    const body = await this.get(`/api/session/${encodeURIComponent(sessionId)}/message`);
    const rows = asArray((body as { data?: unknown } | null)?.data);
    return rows.map((row, seq) => this.toMessage(row as Record<string, unknown>, seq));
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.post(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      parts: [{ type: 'text', text }],
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.post(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {});
  }

  private toSummary(raw: RawSession): AgentSessionSummary {
    const updated = raw.time?.updated;
    const created = raw.time?.created;
    const stamp = typeof updated === 'number' ? updated : typeof created === 'number' ? created : null;
    const model = raw.model;
    return {
      id: str(raw.id) ?? '',
      agent: 'opencode',
      title: str(raw.title) ?? 'Untitled session',
      projectPath: str(raw.location?.directory) ?? '',
      lastActiveAt: stamp === null ? null : new Date(stamp).toISOString(),
      isLive: false,
      messageCount: null,
      model: typeof model === 'object' && model !== null ? str((model as { id?: unknown }).id) : null,
      needsAttention: false,
    };
  }

  private toMessage(raw: Record<string, unknown>, seq: number): AgentMessage {
    const info = (raw.info ?? {}) as Record<string, unknown>;
    const role = info.role === 'assistant' ? 'assistant' : info.role === 'system' ? 'system' : 'user';
    const blocks: MessageBlock[] = [];
    for (const part of asArray(raw.parts)) blocks.push(...toBlocks(part as Record<string, unknown>));
    return {
      id: str(info.id) ?? `seq-${seq}`,
      seq,
      role: role as MessageRole,
      timestamp: null,
      blocks,
    };
  }

  private async get(path: string): Promise<unknown | null> {
    return this.request(path, { method: 'GET' });
  }

  private async post(path: string, body: unknown): Promise<unknown | null> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      // Not installed, not running, or too slow. Caller degrades.
      return null;
    }
  }
}

/** A tool part carries both the call and its result; emit both blocks. */
function toBlocks(part: Record<string, unknown>): MessageBlock[] {
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    return [{ kind: 'text', text: part.text }];
  }
  if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
    return [{ kind: 'thinking', text: part.text }];
  }
  if (part.type !== 'tool') return [];

  const state = (part.state ?? {}) as Record<string, unknown>;
  const toolUseId = str(part.callID) ?? '';
  const name = str(part.tool) ?? 'tool';
  const input = clamp(JSON.stringify(state.input ?? {}));
  const blocks: MessageBlock[] = [{
    kind: 'toolUse',
    toolUseId,
    name,
    summary: summarise(name, state.input),
    input: input.text,
    truncated: input.truncated,
  }];

  if (typeof state.output === 'string') {
    const output = clamp(state.output);
    blocks.push({
      kind: 'toolResult',
      toolUseId,
      ok: state.status !== 'error',
      preview: output.text,
      truncated: output.truncated,
    });
  }
  return blocks;
}

function summarise(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name;
  const fields = input as Record<string, unknown>;
  const command = str(fields.command);
  if (command) return oneLine(command);
  const path = str(fields.filePath) ?? str(fields.file_path) ?? str(fields.path);
  if (path) return `${name} ${path.split('/').pop()}`;
  return name;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

function clamp(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_BLOCK_CHARS
    ? { text: text.slice(0, MAX_BLOCK_CHARS), truncated: true }
    : { text, truncated: false };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
