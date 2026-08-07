import { createHash } from 'node:crypto';

/**
 * Reading a dialog an agent has drawn in a pane at the desk.
 *
 * This parses rendered terminal text, which is a contract nobody signed: any
 * Claude Code or opencode release can move it. herdr exposes no structured
 * blocker (`herdr agent read --source detection` returns the same rendered text
 * as `--source visible`), so there is nothing better to consume.
 *
 * The mitigation is to key on the *same* strings herdr's detection manifests
 * key on. When an upstream release moves them, herdr stops reporting `blocked`
 * and this stops finding a dialog at the same moment — the phone shows nothing
 * rather than showing a wrong option list.
 */

/**
 * How a parsed dialog is answered. The three are genuinely different input
 * mechanisms, and conflating them sends the wrong keys: a digit selects in a
 * numbered list and is a literal character everywhere else, and an arrow list
 * has to be walked from wherever the cursor currently sits.
 */
export type DeskDialogInput = 'numbered' | 'arrows' | 'text';

export interface DeskDialogOption {
  label: string;
  /** 1-based position, which is exactly what a digit key selects. */
  index: number;
  /** The row the TUI has highlighted with `❯`; arrow answers count from it. */
  selected: boolean;
}

export interface DeskDialog {
  prompt: string;
  kind: 'select' | 'freeform';
  input: DeskDialogInput;
  options: DeskDialogOption[];
  /**
   * Stable hash of the dialog region only. Deliberately excludes the transcript
   * above it: an agent that streams a token while the dialog is up must not
   * look to the race guard like a different dialog.
   */
  fingerprint: string;
  /**
   * True when the pane shows only part of the list.
   *
   * A row index read off the screen is then a position *within the window*, not
   * within the list, so index-based keying is invalid and correlation has to
   * recover the offset before it can be trusted.
   */
  windowed: boolean;
}

/**
 * The two signals herdr's `live_blocked_form` rule (priority 980) requires. A
 * cancel hint alone is not enough — `esc to close` is the /btw overlay, which
 * herdr calls *working*.
 */
const CANCEL_HINTS = ['esc to cancel', 'esc dismiss', 'esc to dismiss'];
const CONFIRM_HINTS = ['enter to confirm', 'enter to select', 'enter confirm', 'enter submit'];

/**
 * A dialog is drawn at the bottom of the pane. Bounding the lookback keeps a
 * numbered list quoted earlier in the transcript from being read as options on
 * a pane that happens to have no horizontal rule.
 */
const MAX_DIALOG_LINES = 40;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const RULE = /^[─━═]{8,}$/;
const NUMBERED = /^\s*(?:❯|>)?\s*(\d+)[.)]\s+(\S.*)$/;
const BULLET = /^\s*(?:❯|>)\s+(\S.*)$/;

/**
 * The row a TUI draws when its list outruns the space it has ("↓ 3 more").
 *
 * Its presence is the only on-screen evidence that the visible rows are a
 * window rather than the whole list.
 */
const SCROLL_HINT = /^\s*[↑↓]\s*\d+\s+more\b/;

export function parseDeskDialog(rendered: string): DeskDialog | null {
  const lines = rendered.split('\n').map(cleanLine);

  const footer = lastIndexWhere(lines, (line) => {
    const lower = line.toLowerCase();
    return CANCEL_HINTS.some((hint) => lower.includes(hint));
  });
  if (footer < 0) return null;
  const footerLower = lines[footer].toLowerCase();
  if (!CONFIRM_HINTS.some((hint) => footerLower.includes(hint))) return null;

  // herdr's region is `after_last_horizontal_rule`; the bounded lookback is the
  // fallback for a dialog drawn without one.
  const floor = Math.max(0, footer - MAX_DIALOG_LINES);
  let start = floor;
  for (let i = footer - 1; i >= floor; i--) {
    if (RULE.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }

  const region = lines.slice(start, footer);
  const fingerprint = createHash('sha256')
    .update(region.map((line) => line.trim()).filter(Boolean).join('\n'))
    .update('\n')
    .update(lines[footer].trim())
    .digest('hex')
    .slice(0, 16);

  const windowed = region.some((line) => SCROLL_HINT.test(line));
  // Dropped before options are read: the hint sits in the option column and
  // would otherwise be offered as a choice that selects nothing.
  const rows = region.filter((line) => !SCROLL_HINT.test(line));

  const numbered = readNumbered(rows);
  const options = numbered ?? readArrows(rows);
  if (!options) {
    return { prompt: joinText(rows), kind: 'freeform', input: 'text', options: [], fingerprint, windowed };
  }

  const matcher = numbered ? NUMBERED : BULLET;
  const firstOption = rows.findIndex((line) => matcher.test(line));
  return {
    prompt: joinText(rows.slice(0, firstOption)) || joinText(rows),
    kind: 'select',
    input: numbered ? 'numbered' : 'arrows',
    options,
    fingerprint,
    windowed,
  };
}

/**
 * Digits must run 1..N without a gap. A transcript quoting "1." and "3." is
 * prose, not a dialog, and offering it as two options would have the phone send
 * a digit that selects something else entirely.
 */
function readNumbered(region: string[]): DeskDialogOption[] | null {
  const rows: DeskDialogOption[] = [];
  for (const line of region) {
    const match = NUMBERED.exec(line);
    if (!match) continue;
    rows.push({
      label: match[2].trim(),
      index: Number(match[1]),
      selected: /^\s*(?:❯|>)/.test(line),
    });
  }
  if (rows.length < 2) return null;
  if (rows.some((row, i) => row.index !== i + 1)) return null;
  // Deliberately no "nothing highlighted means row 1" fallback. A digit selects
  // 1..9 without needing a cursor at all, and inventing one would let an option
  // past 9 be answered by walking from a position the TUI never confirmed.
  return rows;
}

/**
 * An arrow list has one `❯` row; its siblings are the contiguous non-empty
 * lines around it whose text starts in the same column. Requiring contiguity
 * and a shared column is what keeps the prompt above the list out of the
 * options — it is indented differently, because the cursor gutter is not there.
 */
function readArrows(region: string[]): DeskDialogOption[] | null {
  const cursor = region.findIndex((line) => BULLET.test(line));
  if (cursor < 0) return null;

  const label = BULLET.exec(region[cursor])![1].trim();
  const column = region[cursor].indexOf(label);

  const before: string[] = [];
  for (let i = cursor - 1; i >= 0; i--) {
    const sibling = siblingLabel(region[i], column);
    if (sibling === null) break;
    before.unshift(sibling);
  }
  const after: string[] = [];
  for (let i = cursor + 1; i < region.length; i++) {
    const sibling = siblingLabel(region[i], column);
    if (sibling === null) break;
    after.push(sibling);
  }

  const labels = [...before, label, ...after];
  if (labels.length < 2) return null;
  return labels.map((text, i) => ({
    label: text,
    index: i + 1,
    selected: i === before.length,
  }));
}

/** A list sibling: non-empty, not itself a cursor row, same text column. */
function siblingLabel(line: string, column: number): string | null {
  const text = line.trim();
  if (!text) return null;
  if (BULLET.test(line)) return null;
  if (line.indexOf(text) !== column) return null;
  return text;
}

/** Strip ANSI and CR, then the box gutters a framed dialog draws down each side. */
function cleanLine(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(/[│┃]/g, ' ')
    .replace(/\s+$/, '');
}

function joinText(lines: string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join('\n');
}

function lastIndexWhere(lines: string[], match: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (match(lines[i])) return i;
  return -1;
}
