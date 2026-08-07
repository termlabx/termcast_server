/**
 * Reading Claude Code's `AskUserQuestion` tool input.
 *
 * The shape is `{ questions: [{ question, header, options, multiSelect }] }` —
 * a *list*, because one call may ask up to four things at once. The previous
 * reader in `claude-sdk-session.ts` looked for `input.question` and
 * `input.options`, which the tool has never sent, so it produced an empty
 * option list and every question reached the phone as a bare text box.
 *
 * Options also carry a `preview` block, deliberately dropped here: it is
 * multi-line sample output meant for a desktop pane, and a phone card has
 * nowhere to put it.
 */

export interface ParsedQuestionOption {
  label: string;
  description?: string;
}

export interface ParsedQuestion {
  prompt: string;
  header?: string;
  options: ParsedQuestionOption[];
  multiSelect: boolean;
}

export function parseAskUserQuestion(input: unknown): ParsedQuestion[] {
  if (typeof input !== 'object' || input === null) return [];
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];

  const parsed: ParsedQuestion[] = [];
  for (const raw of questions) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const prompt = typeof entry.question === 'string' ? entry.question.trim() : '';
    // A member with no question text is not answerable. The rest of the call
    // still is, so drop the member rather than the call.
    if (!prompt) continue;

    parsed.push({
      prompt,
      header: typeof entry.header === 'string' && entry.header ? entry.header : undefined,
      options: readOptions(entry.options),
      multiSelect: entry.multiSelect === true,
    });
  }
  return parsed;
}

function readOptions(raw: unknown): ParsedQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ParsedQuestionOption[] = [];
  for (const item of raw) {
    // A bare string is still a usable label. Dropping it would silently remove
    // a choice the user was offered.
    if (typeof item === 'string') {
      if (item) options.push({ label: item });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const option = item as Record<string, unknown>;
    const label = typeof option.label === 'string' ? option.label : '';
    if (!label) continue;
    options.push({
      label,
      description: typeof option.description === 'string' && option.description
        ? option.description
        : undefined,
    });
  }
  return options;
}
