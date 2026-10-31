/**
 * Find in the Run console output: every occurrence in every line, with IDEA's
 * Match Case / Words / Regex options. Matches carry the line's stable id so the
 * bar can keep the current match while output keeps arriving.
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export interface ConsoleMatch {
  /** Index into the model's current lines. */
  line: number;
  /** Stable line id (survives trimming of older lines). */
  lineId: number;
  /** UTF-16 offsets into the line's text. */
  start: number;
  end: number;
}

export interface FindResult {
  matches: ConsoleMatch[];
  /** More matches exist than were collected. */
  overflow: boolean;
  /** The query is an invalid regular expression. */
  invalid: boolean;
}

/** Matches collected per search; the counter shows `N+` beyond this. */
export const MAX_MATCHES = 2000;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

function wholeWord(text: string, start: number, end: number): boolean {
  return !WORD_CHAR.test(text[start - 1] ?? "") && !WORD_CHAR.test(text[end] ?? "");
}

/** All matches of `query` in `lines`, in document order. */
export function findInLines(
  lines: readonly { id: number; text: string }[],
  query: string,
  options: FindOptions,
  limit = MAX_MATCHES,
): FindResult {
  if (!query) return { matches: [], overflow: false, invalid: false };
  const source = options.regex ? query : query.replace(REGEX_SPECIALS, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(source, options.caseSensitive ? "gu" : "giu");
  } catch {
    return { matches: [], overflow: false, invalid: true };
  }
  const matches: ConsoleMatch[] = [];
  for (let line = 0; line < lines.length; line++) {
    const { id, text } = lines[line]!;
    re.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = re.exec(text))) {
      const start = found.index;
      const end = start + found[0].length;
      // Empty matches (e.g. `x*`) would otherwise loop forever.
      if (end === start) {
        re.lastIndex = start + 1;
        continue;
      }
      if (options.wholeWord && !wholeWord(text, start, end)) continue;
      if (matches.length >= limit) return { matches, overflow: true, invalid: false };
      matches.push({ line, lineId: id, start, end });
    }
  }
  return { matches, overflow: false, invalid: false };
}
