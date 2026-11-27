/**
 * CamelHumps word boundaries (IDEA "Use CamelHumps words"): `parseHTMLDocument`
 * stops at parse|HTML|Document, `snake_case_name` at snake_|case_|name,
 * digits form their own humps, punctuation runs and whitespace are skipped like
 * IDEA's word movement.
 */
type Kind = "upper" | "lower" | "digit" | "under" | "space" | "punct";

function kindOf(ch: string | undefined): Kind | null {
  if (ch === undefined) return null;
  if (ch === "_" || ch === "$") return "under";
  if (/\s/.test(ch)) return "space";
  if (/\p{Lu}/u.test(ch)) return "upper";
  if (/[\p{Ll}\p{Lo}\p{Lm}\p{Lt}]/u.test(ch)) return "lower";
  if (/\p{N}/u.test(ch)) return "digit";
  return "punct";
}

const wordy = (k: Kind | null) => k === "upper" || k === "lower" || k === "digit";

/** Whether there is a hump boundary between `text[i-1]` and `text[i]`. */
export function isHumpBoundary(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return true;
  const a = kindOf(text[i - 1]);
  const b = kindOf(text[i]);
  if (a !== b) {
    if (a === "upper" && b === "lower") return false;
    if (a === "under" && wordy(b)) return true;
    if (wordy(a) && b === "under") return false; // `snake_` keeps its underscore
    return true;
  }
  // HTMLParser: boundary before the last capital that starts a lowercase hump.
  if (a === "upper" && kindOf(text[i + 1]) === "lower") return true;
  return false;
}

/** Next caret stop to the right of `pos` within a line (end of the next hump, macOS style). */
export function humpRight(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && kindOf(text[i]) === "space") i++;
  if (i >= text.length) return text.length;
  i++;
  while (i < text.length && !isHumpBoundary(text, i)) i++;
  return i;
}

/** Next caret stop to the left of `pos` within a line (start of the previous hump). */
export function humpLeft(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && kindOf(text[i - 1]) === "space") i--;
  if (i <= 0) return 0;
  i--;
  while (i > 0 && !isHumpBoundary(text, i)) i--;
  return i;
}

/**
 * Word start to the left of `pos` within a line without CamelHumps: the
 * whitespace before `pos`, then a run of word characters or of punctuation.
 */
export function wordStartLeft(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && kindOf(text[i - 1]) === "space") i--;
  if (i <= 0) return 0;
  const punct = kindOf(text[i - 1]) === "punct";
  while (i > 0 && kindOf(text[i - 1]) !== "space" && (kindOf(text[i - 1]) === "punct") === punct) i--;
  return i;
}

/** Word end to the right of `pos` without CamelHumps: the whitespace after `pos`, then a run of word characters or of punctuation. */
export function wordEndRight(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && kindOf(text[i]) === "space") i++;
  if (i >= text.length) return text.length;
  const punct = kindOf(text[i]) === "punct";
  while (i < text.length && kindOf(text[i]) !== "space" && (kindOf(text[i]) === "punct") === punct) i++;
  return i;
}
