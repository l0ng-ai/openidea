/**
 * Character classes, whitespace trimming and text equality under a
 * comparison policy (IntelliJ's TrimUtil, ComparisonUtil and CharacterUtils,
 * ported; Apache-2.0, Copyright JetBrains s.r.o. and contributors).
 */
import { range, type Range } from "./lcs";

export type ComparisonPolicy = "default" | "trim" | "ignore";

/** Whitespace for comparison purposes: space, tab and line break only (Strings.isWhiteSpace). */
export const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n";

const isSpaceCode = (c: number) => c === 32 || c === 9 || c === 10;

/** ASCII punctuation, except `_`. */
export function isPunctuation(c: number): boolean {
  if (c === 95) return false;
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

export const isWhiteSpaceCodePoint = (c: number) => c < 128 && isSpaceCode(c);

export const isAlpha = (c: number) => !isWhiteSpaceCodePoint(c) && !isPunctuation(c);

const DECIMAL_DIGIT = /\p{Nd}/u;
const IDEOGRAPHIC = /\p{Ideographic}/u;
const ALPHABETIC = /\p{Alphabetic}/u;
const SPACELESS_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Javanese}]/u;

/** Characters that are words on their own: CJK, Thai, symbols, anything outside the BMP. */
export function isContinuousScript(c: number): boolean {
  if (c < 128) return false;
  const s = String.fromCodePoint(c);
  if (DECIMAL_DIGIT.test(s)) return false;
  if (c > 0xffff) return true;
  if (IDEOGRAPHIC.test(s)) return true;
  if (!ALPHABETIC.test(s)) return true;
  return SPACELESS_SCRIPT.test(s);
}

export const charCount = (codePoint: number) => (codePoint >= 0x10000 ? 2 : 1);

export function trimStart(text: string, start: number, end: number): number {
  while (start < end && isSpace(text[start])) start++;
  return start;
}

export function trimEnd(text: string, start: number, end: number): number {
  while (start < end && isSpace(text[end - 1])) end--;
  return end;
}

/** Both sides of a range without their surrounding whitespace. */
export function trimRange(text1: string, text2: string, r: Range): Range {
  const start1 = trimStart(text1, r.start1, r.end1);
  const start2 = trimStart(text2, r.start2, r.end2);
  return range(start1, trimEnd(text1, start1, r.end1), start2, trimEnd(text2, start2, r.end2));
}

/** Shrinks a range by the equal whitespace at both ends (TrimUtil.expandWhitespaces). */
export function expandWhitespaces(text1: string, text2: string, r: Range): Range {
  const forward = expandWhitespacesForward(text1, text2, r.start1, r.start2, r.end1, r.end2);
  const start1 = r.start1 + forward;
  const start2 = r.start2 + forward;
  const backward = expandWhitespacesBackward(text1, text2, start1, start2, r.end1, r.end2);
  return range(start1, r.end1 - backward, start2, r.end2 - backward);
}

export function expandWhitespacesForward(
  text1: string,
  text2: string,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): number {
  const old = start1;
  while (start1 < end1 && start2 < end2 && text1[start1] === text2[start2] && isSpace(text1[start1])) {
    start1++;
    start2++;
  }
  return start1 - old;
}

export function expandWhitespacesBackward(
  text1: string,
  text2: string,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): number {
  const old = end1;
  while (start1 < end1 && start2 < end2 && text1[end1 - 1] === text2[end2 - 1] && isSpace(text1[end1 - 1])) {
    end1--;
    end2--;
  }
  return old - end1;
}

/** The text without whitespace (StringsKmp.equalsIgnoreWhitespaces compares these). */
export const stripSpaces = (s: string) => s.replace(/[ \t\n]+/g, "");

/** The text without surrounding whitespace. */
export function trimSpaces(s: string): string {
  const start = trimStart(s, 0, s.length);
  return s.slice(start, trimEnd(s, start, s.length));
}

/** A line's identity under a policy: equal keys are equal lines (ComparisonUtil.isEquals). */
export function lineKey(s: string, policy: ComparisonPolicy): string {
  return policy === "default" ? s : policy === "trim" ? trimSpaces(s) : stripSpaces(s);
}

/** Texts equal under a policy, trimming every line for "trim" (ComparisonUtil.isEqualTexts). */
export function isEqualTexts(text1: string, text2: string, policy: ComparisonPolicy): boolean {
  if (policy === "default") return text1 === text2;
  if (policy === "ignore") return stripSpaces(text1) === stripSpaces(text2);
  const lines1 = text1.split("\n");
  const lines2 = text2.split("\n");
  return lines1.length === lines2.length && lines1.every((l, i) => trimSpaces(l) === trimSpaces(lines2[i]!));
}

export const isEqualsRange = (text1: string, text2: string, r: Range) =>
  text1.slice(r.start1, r.end1) === text2.slice(r.start2, r.end2);

export const isEqualsIgnoreWhitespacesRange = (text1: string, text2: string, r: Range) =>
  stripSpaces(text1.slice(r.start1, r.end1)) === stripSpaces(text2.slice(r.start2, r.end2));
