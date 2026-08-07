import type { AgentQuestionOption } from './types.js';
import type { ParsedQuestion } from './ask-user-question.js';
import type { DeskDialog } from './desk-dialog.js';

/**
 * Binding a structured question to the dialog currently drawn on the pane.
 *
 * The transcript knows *what* was asked — full labels, descriptions, the real
 * question text. The pane knows *how to answer it* — which keys, from which
 * highlighted row. Neither alone is enough, so they are joined here.
 *
 * The rule that matters is the refusal. When the two do not line up, the
 * assumption that they describe the same dialog is wrong, and a merged list is
 * exactly how somebody taps the wrong option. Returning null costs descriptions;
 * blending costs correctness.
 */

/** The marker a TUI leaves when it cuts a label to fit the pane. */
const ELLIPSIS = /…$|\.\.\.$/;

export interface Correlated {
  /** The full structured list, each option carrying its absolute 1-based row. */
  options: AgentQuestionOption[];
  /**
   * Absolute position of the highlighted row.
   *
   * On a windowed list this is *not* the pane's own index — the pane counts
   * within its window — and walking from the wrong one lands on the wrong
   * option.
   */
  cursorIndex: number;
}

export function correlateDialog(
  structured: ParsedQuestion,
  dialog: DeskDialog,
): Correlated | null {
  if (dialog.kind !== 'select' || dialog.options.length === 0) return null;
  if (structured.options.length === 0) return null;

  const offset = dialog.windowed
    ? contiguousRunStart(structured, dialog)
    : structured.options.length === dialog.options.length && rowsMatch(structured, dialog, 0)
      ? 0
      : null;
  if (offset === null) return null;

  const paneCursor = dialog.options.find((option) => option.selected)?.index;
  return {
    options: structured.options.map((option, i) => ({
      label: option.label,
      description: option.description,
      index: i + 1,
    })),
    // No highlighted row means the cursor sits on the first one, which is what
    // every TUI in scope does with a freshly drawn list.
    cursorIndex: offset + (paneCursor ?? 1),
  };
}

/**
 * Where the visible rows begin inside the full list, or null when they are not
 * a contiguous run of it.
 *
 * A windowed list fails the plain count test by construction, and this is the
 * only thing that makes its absolute indices knowable from the screen.
 */
function contiguousRunStart(structured: ParsedQuestion, dialog: DeskDialog): number | null {
  const limit = structured.options.length - dialog.options.length;
  if (limit < 0) return null;
  for (let start = 0; start <= limit; start++) {
    if (rowsMatch(structured, dialog, start)) return start;
  }
  return null;
}

function rowsMatch(structured: ParsedQuestion, dialog: DeskDialog, start: number): boolean {
  return dialog.options.every((row, i) => {
    const label = structured.options[start + i]?.label;
    return label !== undefined && matches(row.label, label);
  });
}

/**
 * A pane row matches a structured label when it is that label, or a truncated
 * prefix of it.
 *
 * Truncation is the normal case for anything longer than the pane is wide, so
 * exact matching alone would refuse almost every real dialog.
 */
function matches(row: string, label: string): boolean {
  const trimmed = row.trim();
  if (trimmed === label) return true;
  if (!ELLIPSIS.test(trimmed)) return false;
  const prefix = trimmed.replace(ELLIPSIS, '').trimEnd();
  return prefix.length > 0 && label.startsWith(prefix);
}
