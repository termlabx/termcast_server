import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentSessionSummary } from './types.js';
import { sessionMetaFromTranscript } from './claude-transcript.js';

/** Default location of Claude Code's per-project transcript directories. */
export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Bytes read from each end of a transcript when listing.
 *
 * Measured against a real corpus: the first user message lands within 8–31 KB
 * of the head and the first assistant turn within 19–61 KB, so a 128 KB head
 * captures cwd, opening message and model. `ai-title` is rewritten as the
 * conversation develops, so the freshest one sits at the very end — hence the
 * tail slice. Reading whole files is not an option: 279 transcripts totalling
 * 163 MB on one developer machine, re-read on every list request.
 */
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;

/**
 * Enumerate Claude Code sessions, newest first.
 *
 * Sessions are discovered from the filesystem rather than from any registry, so
 * this works whether or not the phone hooks were ever installed. Liveness is
 * layered on separately by the session registry; everything here is idle.
 */
export async function discoverClaudeSessions(
  root: string = defaultProjectsRoot(),
): Promise<AgentSessionSummary[]> {
  let dirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No projects directory means Claude Code has never run here. Not an error:
    // the registry simply contributes no sessions.
    return [];
  }

  const found = await Promise.all(dirs.map((dir) => sessionsInDir(root, dir)));

  return found
    .flat()
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
}

async function sessionsInDir(root: string, dir: string): Promise<AgentSessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(join(root, dir));
  } catch {
    return [];
  }

  const transcripts = names.filter((n) => n.endsWith('.jsonl'));
  const summaries = await Promise.all(
    transcripts.map((name) => summarise(join(root, dir, name), name.slice(0, -'.jsonl'.length))),
  );

  return summaries.filter((s): s is AgentSessionSummary => s !== null);
}

async function summarise(path: string, id: string): Promise<AgentSessionSummary | null> {
  let slice: string;
  let mtime: Date;
  try {
    const info = await stat(path);
    mtime = info.mtime;
    slice = await readEnds(path, info.size);
  } catch {
    // Deleted between readdir and stat, or unreadable. Skip it.
    return null;
  }

  const meta = sessionMetaFromTranscript(slice.split('\n'));

  return {
    id,
    agent: 'claude',
    title: meta.title,
    // Read from inside the transcript, never decoded from the directory name:
    // that encoding maps "/", "_" and "." all onto "-" and cannot be reversed.
    projectPath: meta.projectPath,
    lastActiveAt: meta.lastActiveAt ?? mtime.toISOString(),
    isLive: false,
    // A partial read cannot produce an exact count, and an estimate would be
    // worse than an honest absence. Filled in when the session is opened.
    messageCount: null,
    model: meta.model,
    needsAttention: false,
  };
}

/**
 * Read the head and tail of a file, joined. Whole small files are read once
 * rather than twice.
 */
async function readEnds(path: string, size: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      return buf.toString('utf8');
    }

    const head = Buffer.alloc(HEAD_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);

    // The newline guarantees the truncated head line and the partial tail line
    // are parsed as separate (and therefore individually discardable) records.
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    await handle.close();
  }
}
