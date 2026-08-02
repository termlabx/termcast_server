import type { AgentMessage, MessageBlock, MessageRole } from './types.js';

/**
 * Parse a Claude Code transcript into normalized messages.
 *
 * The `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` format is not a published
 * contract, so this parser is deliberately forgiving: anything it does not
 * recognise is skipped rather than throwing. A transcript half-written by a
 * live session, or written by a newer Claude Code, must still render.
 */
export function parseTranscript(lines: string[]): AgentMessage[] {
  const messages: AgentMessage[] = [];

  lines.forEach((line, seq) => {
    const entry = parseLine(line);
    if (!entry) return;

    const message = toMessage(entry, seq);
    if (message) messages.push(message);
  });

  return messages;
}

export interface SessionMeta {
  title: string;
  projectPath: string;
  model: string | null;
  lastActiveAt: string | null;
  messageCount: number;
}

/**
 * Everything the session list row needs, in one pass over the transcript.
 *
 * Kept separate from parseTranscript because listing sessions must stay cheap:
 * the list reads metadata for every session on the machine, while the full
 * parse only ever runs for the one session being opened.
 */
export function sessionMetaFromTranscript(lines: string[]): SessionMeta {
  let aiTitle: string | null = null;
  let firstUserText: string | null = null;
  let firstAssistantText: string | null = null;
  let projectPath = '';
  let model: string | null = null;
  let lastActiveAt: string | null = null;
  let messageCount = 0;

  lines.forEach((line, seq) => {
    const entry = parseLine(line);
    if (!entry) return;

    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle) {
      // Later titles supersede earlier ones: Claude Code rewrites the title as
      // the conversation's subject becomes clearer.
      aiTitle = entry.aiTitle;
      return;
    }

    if (typeof entry.cwd === 'string' && entry.cwd) projectPath = entry.cwd;

    const message = toMessage(entry, seq);
    if (!message) return;

    messageCount += 1;
    if (message.timestamp) lastActiveAt = message.timestamp;

    if (message.role === 'assistant') {
      const envelope = entry.message as Record<string, unknown> | undefined;
      // Claude Code tags system-generated turns (rate-limit notices, interrupts)
      // with a bracketed pseudo-model such as "<synthetic>". Those must not
      // become the session's reported model.
      if (envelope && typeof envelope.model === 'string' && !envelope.model.startsWith('<')) {
        model = envelope.model;
      }
      if (firstAssistantText === null) {
        const text = message.blocks.find((b) => b.kind === 'text');
        if (text && text.kind === 'text') firstAssistantText = text.text;
      }
    }

    if (firstUserText === null && message.role === 'user') {
      const text = message.blocks.find((b) => b.kind === 'text');
      if (text && text.kind === 'text') firstUserText = text.text;
    }
  });

  // Automation sessions have no human turns at all, so the assistant's opening
  // line is the only thing that identifies them.
  const fallback = firstUserText ?? firstAssistantText;

  return {
    title: aiTitle ?? (fallback !== null ? oneLine(fallback) : 'Untitled session'),
    projectPath,
    model,
    lastActiveAt,
    messageCount,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A torn final line is normal while a live session is being appended to.
    return null;
  }
}

/**
 * Records that live in the transcript but do not belong in the conversation.
 *
 * Each of these would otherwise render as something the human said or the agent
 * replied, which is worse than dropping it: it misattributes text to a person.
 */
function isHidden(entry: Record<string, unknown>): boolean {
  // Task/Agent subagent turns interleave with the main thread in the same file.
  if (entry.isSidechain === true) return true;
  // system-reminder style injections, written with role "user".
  if (entry.isMeta === true) return true;
  // Text produced by a tool or hook rather than typed by the human.
  if (typeof entry.sourceToolUseID === 'string') return true;
  return false;
}

function toMessage(entry: Record<string, unknown>, seq: number): AgentMessage | null {
  const type = entry.type;
  if (type !== 'user' && type !== 'assistant') return null;
  if (isHidden(entry)) return null;

  const envelope = entry.message;
  if (typeof envelope !== 'object' || envelope === null) return null;

  const blocks = toBlocks((envelope as Record<string, unknown>).content);
  if (blocks.length === 0) return null;

  return {
    id: typeof entry.uuid === 'string' ? entry.uuid : `seq-${seq}`,
    seq,
    role: type as MessageRole,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    blocks,
  };
}

/** `content` is either a bare string or an array of typed blocks. */
function toBlocks(content: unknown): MessageBlock[] {
  if (typeof content === 'string') {
    return content ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: MessageBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = toBlock(raw as Record<string, unknown>);
    if (block) blocks.push(block);
  }
  return blocks;
}

function toBlock(raw: Record<string, unknown>): MessageBlock | null {
  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' && raw.text ? { kind: 'text', text: raw.text } : null;

    case 'thinking':
      return typeof raw.thinking === 'string' && raw.thinking
        ? { kind: 'thinking', text: raw.thinking }
        : null;

    case 'tool_use': {
      const name = typeof raw.name === 'string' ? raw.name : 'tool';
      const input = raw.input ?? {};
      const { text, truncated } = clamp(JSON.stringify(input));
      return {
        kind: 'toolUse',
        toolUseId: typeof raw.id === 'string' ? raw.id : '',
        name,
        summary: summarise(name, input),
        input: text,
        truncated,
      };
    }

    case 'tool_result': {
      const { text, truncated } = clamp(resultText(raw.content));
      return {
        kind: 'toolResult',
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '',
        ok: raw.is_error !== true,
        preview: text,
        truncated,
      };
    }

    default:
      // An unrecognised block type from a newer Claude Code is skipped, not fatal.
      return null;
  }
}

/**
 * Tool results are usually a string, but the file-reading tools return an array
 * of typed parts.
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n');
}

/** Matches the truncation budget the spec puts on the frame path. */
const MAX_BLOCK_CHARS = 2048;

function clamp(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_BLOCK_CHARS
    ? { text: text.slice(0, MAX_BLOCK_CHARS), truncated: true }
    : { text, truncated: false };
}

/**
 * A one-line label for a collapsed tool card. The interesting argument differs
 * per tool: a path for the file tools, the command for Bash. Falling back to the
 * bare tool name is always safe.
 */
function summarise(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name;
  const fields = input as Record<string, unknown>;

  if (typeof fields.command === 'string') return oneLine(fields.command);
  if (typeof fields.file_path === 'string') return `${name} ${basename(fields.file_path)}`;
  if (typeof fields.path === 'string') return `${name} ${basename(fields.path)}`;
  if (typeof fields.pattern === 'string') return `${name} ${oneLine(fields.pattern)}`;
  return name;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}
