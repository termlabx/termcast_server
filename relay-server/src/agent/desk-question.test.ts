import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskQuestionWatcher, answerKeys } from './desk-question.js';
import { parseDeskDialog } from './desk-dialog.js';
import type { AgentEvent } from './adapter.js';
import type { HerdrAgentCli } from './herdr-agent-cli.js';
import type { DeskRegistry, DeskTarget } from './desk-target.js';

const NUMBERED_DIALOG = [
  '─'.repeat(60),
  '  Do you want to proceed?',
  '',
  '  ❯ 1. Yes',
  '    2. No, and tell Claude what to do',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

const ARROW_DIALOG = [
  '─'.repeat(60),
  '  Select Model',
  '',
  '  ❯ Default',
  '    Opus',
  '    Sonnet',
  '',
  '  Enter to select · Esc to cancel · ↑/↓ to navigate',
].join('\n');

interface FakeState {
  status: string;
  seq: number | null;
  pane: string;
  keys: string[][];
}

/** herdr stands still unless a test moves it, so a poll is deterministic. */
function fakeCli(state: FakeState): HerdrAgentCli {
  return {
    get: async () => ({
      agent: 'claude', sessionId: 's1', status: state.status,
      paneId: 'w3:p2', cwd: '', stateChangeSeq: state.seq,
    }),
    read: async () => state.pane,
    sendKeys: async (_pane: string, keys: readonly string[]) => { state.keys.push([...keys]); },
    // Mirrors herdr: a match returns the agent, a timeout returns null.
    wait: async () => (state.status === 'blocked' ? null : {
      agent: 'claude', sessionId: 's1', status: state.status,
      paneId: 'w3:p2', cwd: '', stateChangeSeq: state.seq,
    }),
  } as unknown as HerdrAgentCli;
}

function fakeDesk(target: DeskTarget | null): DeskRegistry {
  return { lookup: async () => target, list: async () => [] };
}

const herdrTarget = (status: DeskTarget['status']): DeskTarget =>
  ({ paneId: 'w3:p2', mux: 'herdr', status });

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function questionsIn(events: AgentEvent[]): Extract<AgentEvent, { kind: 'question' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { kind: 'question' }> => e.kind === 'question');
}

/**
 * Runs the watcher long enough to poll and returns what it emitted, still
 * watching. Tests that want to move the desk under a pending question pass a
 * `pollMs` longer than the test, so the first tick is the only one and a later
 * mutation is not simply re-polled into a fresh question.
 */
async function collect(cli: HerdrAgentCli, desk: DeskRegistry, pollMs = 5): Promise<{
  watcher: DeskQuestionWatcher; events: AgentEvent[]; stop: () => void;
}> {
  const watcher = new DeskQuestionWatcher(cli, desk, { pollMs });
  const events: AgentEvent[] = [];
  const stop = watcher.watch('claude', 's1', (event) => events.push(event));
  await flush();
  return { watcher, events, stop };
}

/** Long enough that only the immediate first tick runs during a test. */
const ONE_POLL = 10_000;

test('emits one question when the desk agent is blocked, and does not repeat it', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')));
  stop();

  const questions = questionsIn(events);
  // Several polls elapsed; an unchanged dialog is the same question, not a new one.
  assert.equal(questions.length, 1);
  const { request } = questions[0];
  assert.equal(request.kind, 'select');
  assert.equal(request.sessionId, 's1');
  assert.equal(request.agent, 'claude');
  assert.deepEqual(request.options.map((o) => o.label), ['Yes', 'No, and tell Claude what to do']);
  assert.match(request.prompt, /Do you want to proceed\?/);
  // The phone keys its radio-vs-checkbox presentation off this. A desk dialog
  // is answered with one keystroke, so a multi-select card would let the user
  // tick two options and send whichever the set happened to order first.
  assert.equal(request.origin, 'desk');
});

test('emits nothing while the desk agent is working', async () => {
  // working means wait; only blocked means the agent is waiting on you.
  const state: FakeState = { status: 'working', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('working')));
  stop();
  assert.equal(questionsIn(events).length, 0);
});

test('tmux targets are never watched', async () => {
  // tmux publishes no status, so there is no signal that a dialog is up at all.
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const desk = fakeDesk({ paneId: '%1', mux: 'tmux', status: 'unknown' });
  const { events, stop } = await collect(fakeCli(state), desk);
  stop();
  assert.equal(events.length, 0);
});

test('a pane whose text does not parse emits nothing', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: 'just some output\n', keys: [] };
  const { events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')));
  stop();
  assert.equal(events.length, 0);
});

test('a new dialog replaces the old question', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const watcher = new DeskQuestionWatcher(fakeCli(state), fakeDesk(herdrTarget('blocked')), { pollMs: 5 });
  const events: AgentEvent[] = [];
  const stop = watcher.watch('claude', 's1', (event) => events.push(event));
  await flush();
  state.pane = ARROW_DIALOG;
  state.seq = 8;
  await flush();
  stop();

  const questions = questionsIn(events);
  assert.equal(questions.length, 2);
  assert.notEqual(questions[0].request.requestId, questions[1].request.requestId);
  assert.deepEqual(questions[1].request.options.map((o) => o.label), ['Default', 'Opus', 'Sonnet']);
});

test('answering a numbered dialog sends the digit', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { watcher, events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')));
  const { request } = questionsIn(events)[0];

  // The desk reacts the moment the keys land.
  const answered = watcher.respond(request.requestId, ['No, and tell Claude what to do']);
  state.status = 'working';
  assert.equal(await answered, true);
  assert.deepEqual(state.keys, [['2']]);
  stop();
});

test('rejecting sends escape', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { watcher, events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')));
  const { request } = questionsIn(events)[0];

  const answered = watcher.respond(request.requestId, undefined, true);
  state.status = 'idle';
  assert.equal(await answered, true);
  assert.deepEqual(state.keys, [['esc']]);
  stop();
});

test('an answer the desk already gave is dropped, not applied to the next dialog', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { watcher, events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')), ONE_POLL);
  const { request } = questionsIn(events)[0];

  // Someone answered at the keyboard: herdr's counter moved and a new dialog
  // is up. Sending "2" now would type a literal 2 into a fresh prompt.
  state.seq = 8;
  state.pane = ARROW_DIALOG;
  await assert.rejects(
    () => watcher.respond(request.requestId, ['Yes']),
    /already answered at your desk/,
  );
  assert.deepEqual(state.keys, []);
  stop();
});

test('a dialog whose text changed under an unchanged counter is also dropped', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { watcher, events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')), ONE_POLL);
  const { request } = questionsIn(events)[0];

  state.pane = ARROW_DIALOG;
  await assert.rejects(() => watcher.respond(request.requestId, ['Yes']), /already answered at your desk/);
  assert.deepEqual(state.keys, []);
  stop();
});

test('a dialog still up after the keys land is reported as unanswered', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { watcher, events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')), ONE_POLL);
  const { request } = questionsIn(events)[0];

  // Keys sent, but nothing moved: same status, same counter, same dialog. A
  // phone that says "approved" here is worse than one that says nothing.
  await assert.rejects(() => watcher.respond(request.requestId, ['Yes']), /still up at your desk/);
  assert.deepEqual(state.keys, [['1']]);
  const errors = events.filter((e) => e.kind === 'status' && e.status === 'error');
  assert.equal(errors.length, 1);
  stop();
});

test('answering into a dialog that moved on to a different one succeeds', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const cli = fakeCli(state);
  const { watcher, events, stop } = await collect(cli, fakeDesk(herdrTarget('blocked')), ONE_POLL);
  const { request } = questionsIn(events)[0];

  // A chain of dialogs: still blocked, but on something else. That is a
  // delivered answer, not a stuck one.
  const original = cli.sendKeys.bind(cli);
  (cli as { sendKeys: HerdrAgentCli['sendKeys'] }).sendKeys = async (pane, keys) => {
    await original(pane, keys);
    state.pane = ARROW_DIALOG;
  };
  assert.equal(await watcher.respond(request.requestId, ['Yes']), true);
  stop();
});

test('respond returns false for an id it does not own', async () => {
  // The adapters fall through to their SDK sessions on false, so this must not
  // throw and must not consume the id.
  const state: FakeState = { status: 'idle', seq: 1, pane: '', keys: [] };
  const watcher = new DeskQuestionWatcher(fakeCli(state), fakeDesk(null));
  assert.equal(await watcher.respond('sdk-request-1', ['Yes']), false);
});

test('stopping the watch drops its pending questions', async () => {
  const state: FakeState = { status: 'blocked', seq: 7, pane: NUMBERED_DIALOG, keys: [] };
  const { watcher, events, stop } = await collect(fakeCli(state), fakeDesk(herdrTarget('blocked')));
  const { request } = questionsIn(events)[0];
  stop();
  // A pending approval must not outlive the phone that could answer it.
  assert.equal(await watcher.respond(request.requestId, ['Yes']), false);
});

test('answerKeys maps arrow selections to Down presses from the cursor', () => {
  const dialog = parseDeskDialog(ARROW_DIALOG)!;
  assert.deepEqual(answerKeys(dialog, ['Sonnet'], false), ['down', 'down', 'enter']);
  assert.deepEqual(answerKeys(dialog, ['Default'], false), ['enter']);
  assert.deepEqual(answerKeys(dialog, undefined, true), ['esc']);
});

test('answerKeys walks up when the target sits above the cursor', () => {
  const dialog = parseDeskDialog([
    '─'.repeat(40), '  Select Model', '', '    Default', '    Opus', '  ❯ Sonnet', '',
    '  Enter to select · Esc to cancel · ↑/↓ to navigate',
  ].join('\n'))!;
  assert.deepEqual(answerKeys(dialog, ['Default'], false), ['up', 'up', 'enter']);
});

test('answerKeys refuses an answer that is not one of the options', () => {
  // Never invent a selection: a wrong index approves the wrong thing.
  const dialog = parseDeskDialog(NUMBERED_DIALOG)!;
  assert.equal(answerKeys(dialog, ['Not an option'], false), null);
  assert.equal(answerKeys(dialog, [], false), null);
  assert.equal(answerKeys(dialog, undefined, false), null);
});

test('answerKeys types a freeform answer and submits it', () => {
  // freeform is only emitted when no option rows were found at all, so there is
  // no highlighted choice for Enter to confirm by accident.
  const dialog = parseDeskDialog([
    '─'.repeat(40), '  Tell Claude what to do differently:', '', '  Enter to confirm · Esc to cancel',
  ].join('\n'))!;
  assert.equal(dialog.kind, 'freeform');
  assert.deepEqual(answerKeys(dialog, ['use tabs'], false), ['use tabs', 'enter']);
});

// --- long and scrolled lists ----------------------------------------------

const TWELVE = [
  '─'.repeat(60),
  '  Pick one',
  ...Array.from({ length: 12 }, (_, i) => `  ${i === 0 ? '❯' : ' '} ${i + 1}. Option ${i + 1}`),
  '  Enter to confirm · Esc to cancel',
].join('\n');

test('answerKeys: options 1-9 of a long numbered list key by digit', () => {
  const dialog = parseDeskDialog(TWELVE);
  assert.ok(dialog);
  assert.deepEqual(answerKeys(dialog, ['Option 7'], false), ['7']);
});

// Sending "1" then "0" selects option 1 — the worst available failure, because
// it looks like it worked.
test('answerKeys: option 10+ keys by arrow walk rather than by two digits', () => {
  const dialog = parseDeskDialog(TWELVE);
  assert.ok(dialog);
  assert.deepEqual(answerKeys(dialog, ['Option 11'], false),
    [...Array<string>(10).fill('down'), 'enter']);
});

test('answerKeys: option 10+ is refused when there is no cursor to walk from', () => {
  const dialog = parseDeskDialog(TWELVE.replace('❯', ' '));
  assert.ok(dialog);
  assert.equal(answerKeys(dialog, ['Option 11'], false), null);
  // A digit still works without a cursor, so 1..9 must stay answerable.
  assert.deepEqual(answerKeys(dialog, ['Option 3'], false), ['3']);
});

test('answerKeys: an explicit cursor override wins over the pane row', () => {
  const dialog = parseDeskDialog(TWELVE);
  assert.ok(dialog);
  // Correlation supplies the absolute position on a windowed list, where the
  // pane's own index counts only within the visible window.
  assert.deepEqual(answerKeys(dialog, ['Option 11'], false, 10), ['down', 'enter']);
});
