import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeSessions } from './claude-discovery.js';

function transcript(cwd: string, opts: { title?: string; text?: string } = {}): string {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-02T10:00:00.000Z',
      cwd,
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'text', text: opts.text ?? 'hello' }] },
    }),
  ];
  if (opts.title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId: 's' }));
  return lines.join('\n') + '\n';
}

/** Builds a fake ~/.claude/projects tree and returns its root. */
function projectsRoot(files: Array<{ dir: string; name: string; body: string; mtime?: Date }>): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-projects-'));
  for (const f of files) {
    mkdirSync(join(root, f.dir), { recursive: true });
    const path = join(root, f.dir, f.name);
    writeFileSync(path, f.body);
    if (f.mtime) utimesSync(path, f.mtime, f.mtime);
  }
  return root;
}

test('discoverClaudeSessions: one summary per transcript, id taken from the filename', async () => {
  const root = projectsRoot([
    { dir: '-Users-me-repo', name: 'aaaa-1111.jsonl', body: transcript('/Users/me/repo') },
  ]);

  const sessions = await discoverClaudeSessions(root);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'aaaa-1111');
  assert.equal(sessions[0].agent, 'claude');
});

test('discoverClaudeSessions: project path comes from the transcript, not the directory name', async () => {
  // The directory name is a LOSSY encoding: "/", "_" and "." all collapse to
  // "-", so /Users/me/ttyd_mobile and /Users/me/ttyd-mobile share a directory
  // name. Decoding it back would report the wrong repo to the user.
  const root = projectsRoot([
    { dir: '-Users-me-Projects-ttyd-mobile', name: 's1.jsonl', body: transcript('/Users/me/Projects/ttyd_mobile') },
  ]);

  const [session] = await discoverClaudeSessions(root);

  assert.equal(session.projectPath, '/Users/me/Projects/ttyd_mobile');
});

test('discoverClaudeSessions: newest session sorts first', async () => {
  const at = (ts: string) => JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: ts,
    cwd: '/repo',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
  const root = projectsRoot([
    { dir: 'a', name: 'old.jsonl', body: at('2026-01-01T00:00:00.000Z') },
    { dir: 'b', name: 'new.jsonl', body: at('2026-08-01T00:00:00.000Z') },
  ]);

  const sessions = await discoverClaudeSessions(root);

  assert.deepEqual(sessions.map((s) => s.id), ['new', 'old']);
});

test('discoverClaudeSessions: last activity falls back to file mtime when the transcript has no timestamps', async () => {
  // Transcripts that are all metadata (or whose tail slice happens to contain
  // no timestamped record) still need to sort sensibly in the list.
  const untimed = JSON.stringify({ type: 'ai-title', aiTitle: 'No timestamps here', sessionId: 's' });
  const root = projectsRoot([
    { dir: 'a', name: 's1.jsonl', body: untimed, mtime: new Date('2026-03-04T05:06:07Z') },
  ]);

  const [session] = await discoverClaudeSessions(root);

  assert.equal(session.lastActiveAt, '2026-03-04T05:06:07.000Z');
});

test('discoverClaudeSessions: messageCount is null rather than a guess from a partial read', async () => {
  // Listing reads only a slice of each transcript, so an exact count is not
  // available. Reporting a number derived from the slice would be a lie.
  const root = projectsRoot([{ dir: 'a', name: 's1.jsonl', body: transcript('/repo') }]);

  const [session] = await discoverClaudeSessions(root);

  assert.equal(session.messageCount, null);
});

test('discoverClaudeSessions: sessions start idle until liveness says otherwise', async () => {
  const root = projectsRoot([{ dir: 'a', name: 's1.jsonl', body: transcript('/repo') }]);

  const [session] = await discoverClaudeSessions(root);

  assert.equal(session.isLive, false);
  assert.equal(session.needsAttention, false);
});

test('discoverClaudeSessions: non-transcript files are ignored', async () => {
  const root = projectsRoot([
    { dir: 'a', name: 's1.jsonl', body: transcript('/repo') },
    { dir: 'a', name: 'notes.txt', body: 'not a transcript' },
    { dir: 'a', name: 's2.jsonl.tmp', body: 'partial write' },
  ]);

  const sessions = await discoverClaudeSessions(root);

  assert.deepEqual(sessions.map((s) => s.id), ['s1']);
});

test('discoverClaudeSessions: an unreadable transcript does not sink the whole listing', async () => {
  const root = projectsRoot([
    { dir: 'a', name: 'good.jsonl', body: transcript('/repo') },
    { dir: 'a', name: 'broken.jsonl', body: 'not json at all\nstill not json\n' },
  ]);

  const sessions = await discoverClaudeSessions(root);

  // The broken one still lists — it just has no metadata to show.
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((s) => s.id === 'good'));
});

test('discoverClaudeSessions: a missing projects directory yields no sessions rather than throwing', async () => {
  const sessions = await discoverClaudeSessions(join(tmpdir(), 'definitely-not-here-9e3f'));

  assert.deepEqual(sessions, []);
});

test('discoverClaudeSessions: the agent-written title wins over the first message', async () => {
  const root = projectsRoot([
    { dir: 'a', name: 's1.jsonl', body: transcript('/repo', { title: 'Fix the parser', text: 'some opening' }) },
  ]);

  const [session] = await discoverClaudeSessions(root);

  assert.equal(session.title, 'Fix the parser');
});

test('discoverClaudeSessions: project path is where the session started, not where it wandered', async () => {
  // cwd is recorded per entry and changes when the agent works in a
  // subdirectory. Taking the last one filed this very session under
  // server/relay-server instead of the repo it belongs to.
  const entry = (cwd: string, ts: string) => JSON.stringify({
    type: 'user',
    uuid: 'u',
    timestamp: ts,
    cwd,
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
  const root = projectsRoot([{
    dir: 'a',
    name: 's1.jsonl',
    body: [
      entry('/Users/me/Projects/repo', '2026-08-01T00:00:00.000Z'),
      entry('/Users/me/Projects/repo/server/nested', '2026-08-02T00:00:00.000Z'),
    ].join('\n'),
  }]);

  const [session] = await discoverClaudeSessions(root);

  assert.equal(session.projectPath, '/Users/me/Projects/repo');
});
