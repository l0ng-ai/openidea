/**
 * Find in console output (Run, Debug): every occurrence in every line, with IDEA's
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
  /** Index into the console's current lines. */
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

/**
 * Like `findInLines` over output whose long lines are cut into several rows: `continues(row)` says
 * the next row carries on the same line. Rows are searched joined, and a match is reported on the
 * row where it starts, its `end` running past that row when it crosses a cut.
 */
export function findInCutLines<T extends { id: number; text: string }>(
  rows: readonly T[],
  continues: (row: T) => boolean,
  query: string,
  options: FindOptions,
): FindResult {
  const joined: { id: number; text: string }[] = [];
  const firstRow: number[] = [];
  rows.forEach((row, i) => {
    const prev = joined.length - 1;
    if (i > 0 && continues(rows[i - 1]!)) joined[prev] = { id: joined[prev]!.id, text: joined[prev]!.text + row.text };
    else {
      joined.push(row);
      firstRow.push(i);
    }
  });
  const res = findInLines(joined, query, options);
  const matches = res.matches.map((m) => {
    let row = firstRow[m.line]!;
    let offset = 0;
    while (continues(rows[row]!) && m.start >= offset + rows[row]!.text.length) offset += rows[row++]!.text.length;
    return { line: row, lineId: rows[row]!.id, start: m.start - offset, end: m.end - offset };
  });
  return { ...res, matches };
}

/** Highlights per row for `findInCutLines` matches: a match across a cut is marked on each row it covers. */
export function marksByRow<T extends { text: string }>(
  matches: readonly ConsoleMatch[],
  activeIndex: number,
  rows: readonly T[],
  continues: (row: T) => boolean,
): Map<number, { start: number; end: number; current: boolean }[]> {
  const byRow = new Map<number, { start: number; end: number; current: boolean }[]>();
  const add = (row: number, mark: { start: number; end: number; current: boolean }) => {
    const marks = byRow.get(row);
    if (marks) marks.push(mark);
    else byRow.set(row, [mark]);
  };
  matches.forEach((match, i) => {
    const current = i === activeIndex;
    let { line, start, end } = match;
    while (rows[line] && continues(rows[line]!) && end > rows[line]!.text.length) {
      const len = rows[line]!.text.length;
      add(line, { start, end: len, current });
      start = 0;
      end -= len;
      line++;
    }
    add(line, { start, end, current });
  });
  return byRow;
}
