import { readFile } from 'node:fs/promises';
import type { AgentMessage } from './types.js';
import { parseTranscript } from './claude-transcript.js';

/**
 * Messages on lines strictly after `sinceSeq`. Pass -1 for the whole file.
 *
 * The whole file is read and re-parsed rather than seeking to a byte offset:
 * seq is a LINE index, and a byte offset cannot be recovered from it without
 * tracking state that would go stale whenever the file is rewritten.
 */
export async function readMessagesSince(path: string, sinceSeq: number): Promise<AgentMessage[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return parseTranscript(text.split('\n')).filter((m) => m.seq > sinceSeq);
}

const DEFAULT_POLL_MS = 400;

/**
 * Follows a transcript, emitting each newly appended message once.
 *
 * Polls rather than using fs.watch: watch is unreliable across editors and
 * network filesystems, and on macOS it fires duplicate events that would
 * double-emit messages.
 */
export class TranscriptTail {
  private timer: NodeJS.Timeout | null = null;
  private lastSeq: number;
  private reading = false;

  constructor(
    private readonly path: string,
    sinceSeq: number,
    private readonly onMessage: (message: AgentMessage) => void,
    private readonly pollMs: number = DEFAULT_POLL_MS,
  ) {
    this.lastSeq = sinceSeq;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    // Do not block start() on the first read; the interval covers it.
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    // A slow read must not overlap itself and emit the same message twice.
    if (this.reading || !this.timer) return;
    this.reading = true;
    try {
      const messages = await readMessagesSince(this.path, this.lastSeq);
      for (const message of messages) {
        if (!this.timer) return;   // stopped mid-drain
        this.lastSeq = message.seq;
        this.onMessage(message);
      }
    } finally {
      this.reading = false;
    }
  }
}
