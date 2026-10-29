/**
 * Visible columns: the column model of every column-based editing operation
 * (block selection, clone caret, ↑/↓ goal column, caret column after
 * commenting, Tab stops). East Asian Wide / Fullwidth characters and emoji
 * count 2, combining marks and other zero-width characters 0, a tab runs to
 * the next tab stop, everything else 1. Measured per grapheme cluster, so a
 * ZWJ emoji sequence or a base letter with accents is one unit.
 *
 * UI-side only: offsets in and out are UTF-16 offsets into the line text.
 */
import { findClusterBreak } from "@codemirror/state";

// East Asian Width W / F ranges outside emoji (Unicode 15.1), sorted, inclusive.
// prettier-ignore
const WIDE: readonly number[] = [
  0x1100, 0x115f, 0x2329, 0x232a, 0x2e80, 0x303e, 0x3041, 0x33ff, 0x3400, 0x4dbf, 0x4e00, 0x9fff,
  0xa000, 0xa4cf, 0xa960, 0xa97f, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe6f,
  0xff00, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x18cff, 0x18d00, 0x18d08,
  0x1aff0, 0x1b2ff, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265,
  0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

const ZERO = /[\p{Mn}\p{Me}\p{Cf}ᅠ-ᇿ]/u;
const EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function inWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid * 2]!) hi = mid - 1;
    else if (cp > WIDE[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns one code point takes on its own (a tab is not handled here). */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1;
  const ch = String.fromCodePoint(cp);
  if (ZERO.test(ch)) return 0;
  if (inWide(cp) || EMOJI.test(ch)) return 2;
  return 1;
}

/** Columns one grapheme cluster takes: its widest code point, 2 for a pictograph in emoji presentation (U+FE0F). */
export function clusterWidth(text: string, from = 0, to = text.length): number {
  let width = 0;
  let pictographic = false;
  for (let i = from; i < to;) {
    const cp = text.codePointAt(i)!;
    if (cp === 0xfe0f && pictographic) return 2;
    if (i === from) pictographic = PICTOGRAPHIC.test(String.fromCodePoint(cp));
    width = Math.max(width, codePointWidth(cp));
    if (width === 2) return 2;
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/** Width of the cluster starting at `i` (at visible column `col`) and where it ends. */
function step(text: string, i: number, col: number, tabSize: number): [width: number, next: number] {
  const c = text.charCodeAt(i);
  if (c === 9) return [tabSize - (col % tabSize), i + 1];
  // Plain ASCII never extends a cluster except before a combining mark / ZWJ / variation selector.
  const next = c < 0x80 && (i + 1 >= text.length || text.charCodeAt(i + 1) < 0x300) ? i + 1 : findClusterBreak(text, i);
  return [c >= 0x20 && c < 0x7f ? 1 : clusterWidth(text, i, next), next];
}

/** The visible column at UTF-16 `offset` of `text` (a cluster `offset` falls inside counts whole). */
export function visibleColumn(text: string, offset: number, tabSize: number): number {
  let col = 0;
  for (let i = 0; i < offset && i < text.length;) {
    const [w, next] = step(text, i, col, tabSize);
    col += w;
    i = next;
  }
  return col;
}

/** The visible width of `text`. */
export function visibleWidth(text: string, tabSize: number): number {
  return visibleColumn(text, text.length, tabSize);
}

export type ColumnBias = "nearest" | "before" | "after";

/**
 * The UTF-16 offset in `text` at visible column `col`. A column inside a wide
 * character or a tab snaps to the nearer side (a tie goes after) unless `bias`
 * says otherwise. Past the end: `text.length`, or -1 when `strict`.
 */
export function offsetAtVisibleColumn(
  text: string,
  col: number,
  tabSize: number,
  bias: ColumnBias = "nearest",
  strict = false,
): number {
  let n = 0;
  for (let i = 0; ;) {
    if (n >= col) return i;
    if (i >= text.length) break;
    const [w, next] = step(text, i, n, tabSize);
    if (n + w > col) {
      if (bias === "before") return i;
      if (bias === "after") return next;
      return col - n < n + w - col ? i : next;
    }
    n += w;
    i = next;
  }
  return strict ? -1 : text.length;
}

/** The visible column one cluster left / right of `col` in `text`; past the line end, one column. */
export function stepVisibleColumn(text: string, col: number, d: number, tabSize: number): number {
  if (!d) return col;
  const width = visibleWidth(text, tabSize);
  if (d > 0 ? col >= width : col > width) return Math.max(0, col + d);
  if (d > 0) return visibleColumn(text, offsetAtVisibleColumn(text, col + 1, tabSize, "after"), tabSize);
  const pos = offsetAtVisibleColumn(text, col, tabSize, "before");
  if (visibleColumn(text, pos, tabSize) < col) return visibleColumn(text, pos, tabSize);
  return pos === 0 ? 0 : visibleColumn(text, offsetAtVisibleColumn(text, col - 1, tabSize, "before"), tabSize);
}
