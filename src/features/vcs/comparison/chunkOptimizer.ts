/**
 * Shifts ambiguous changes to where people expect them (IntelliJ's
 * ChunkOptimizer, ported; Apache-2.0, Copyright JetBrains s.r.o. and
 * contributors): touching changes are merged, and an insertion or deletion
 * that could sit at several places moves to a word boundary (words) or next to
 * an empty line (lines).
 */
import { createUnchanged, expandBackward, expandForward, type DiffIterable, unchanged } from "./iterables";
import { range, type Range } from "./lcs";
import { isSpace } from "./text";

/** `touchLeft`: the changes touch on the left side; returns the shift (> 0 forward, < 0 backward). */
type GetShift = (
  touchLeft: boolean,
  equalForward: number,
  equalBackward: number,
  range1: Range,
  range2: Range,
) => number;

function optimize<T>(data1: readonly T[], data2: readonly T[], iterable: DiffIterable, getShift: GetShift) {
  const ranges: Range[] = [];
  const processLastRanges = (): void => {
    if (ranges.length < 2) return;
    const range1 = ranges[ranges.length - 2]!;
    const range2 = ranges[ranges.length - 1]!;
    // Changes that don't touch can't be optimized (the input would not be an LCS).
    if (range1.end1 !== range2.start1 && range1.end2 !== range2.start2) return;
    const count1 = range1.end1 - range1.start1;
    const count2 = range2.end1 - range2.start1;
    const equalForward = expandForward(
      data1,
      data2,
      range1.end1,
      range1.end2,
      Math.min(range1.end1 + count2, data1.length),
      Math.min(range1.end2 + count2, data2.length),
    );
    const equalBackward = expandBackward(
      data1,
      data2,
      Math.max(range2.start1 - count1, 0),
      Math.max(range2.start2 - count1, 0),
      range2.start1,
      range2.start2,
    );
    if (equalForward === 0 && equalBackward === 0) return;
    // merge chunks left [A]B[B] -> [AB]B
    if (equalForward === count2) {
      ranges.splice(-2, 2, range(range1.start1, range1.end1 + count2, range1.start2, range1.end2 + count2));
      return processLastRanges();
    }
    // merge chunks right [A]A[B] -> A[AB]
    if (equalBackward === count1) {
      ranges.splice(-2, 2, range(range2.start1 - count1, range2.end1, range2.start2 - count1, range2.end2));
      return processLastRanges();
    }
    const shift = getShift(range1.end1 === range2.start1, equalForward, equalBackward, range1, range2);
    if (shift !== 0)
      ranges.splice(
        -2,
        2,
        range(range1.start1, range1.end1 + shift, range1.start2, range1.end2 + shift),
        range(range2.start1 + shift, range2.end1, range2.start2 + shift, range2.end2),
      );
  };
  for (const r of unchanged(iterable)) {
    ranges.push(r);
    processLastRanges();
  }
  return createUnchanged(ranges, data1.length, data2.length);
}

export interface WordChunk {
  readonly offset1: number;
  readonly offset2: number;
  readonly newline: boolean;
}

/**
 * Words: fewer chunks, and fewer changed "sentences" (runs of words not
 * separated by whitespace): "[AX] [AZ]" - "[AX] AY [AZ]", not "[AX A][Z]".
 */
export function optimizeWordChunks(
  keys1: readonly string[],
  keys2: readonly string[],
  words1: readonly WordChunk[],
  words2: readonly WordChunk[],
  text1: string,
  text2: string,
  iterable: DiffIterable,
): DiffIterable {
  const separated = (text: string, word1: WordChunk, word2: WordChunk) => {
    if (word1.newline || word2.newline) return true;
    for (let i = word1.offset2; i < word2.offset1; i++) if (isSpace(text[i])) return true;
    return false;
  };
  const edgeShift = (text: string, words: readonly WordChunk[], offset: number, count: number, ltr: boolean) => {
    for (let i = 0; i < count; i++) {
      const [w1, w2] = ltr
        ? [words[offset + i]!, words[offset + i + 1]!]
        : [words[offset - i - 1]!, words[offset - i]!];
      if (separated(text, w1, w2)) return i + 1;
    }
    return -1;
  };
  return optimize(keys1, keys2, iterable, (touchLeft, equalForward, equalBackward, _range1, range2) => {
    const words = touchLeft ? words1 : words2;
    const text = touchLeft ? text1 : text2;
    const touchStart = touchLeft ? range2.start1 : range2.start2;
    // already separated by whitespace
    if (separated(text, words[touchStart - 1]!, words[touchStart]!)) return 0;
    // shift chunks left [X]A Y[A ZA] -> [XA] YA [ZA]
    const left = edgeShift(text, words, touchStart, equalForward, true);
    if (left > 0) return left;
    // shift chunks right [AX A]Y A[Z] -> [AX] AY [AZ]
    const right = edgeShift(text, words, touchStart - 1, equalBackward, false);
    if (right > 0) return -right;
    return 0;
  });
}

/** Lines with at most this many non-space characters are "unimportant" (`}`, blank). */
export const UNIMPORTANT_LINE_CHAR_COUNT = 3;

export interface LineInfo {
  readonly key: string;
  readonly nonSpaceChars: number;
}

/**
 * Lines: fewer chunks, and insertions / deletions bounded by an empty (or
 * unimportant) line: "ABooYZ [ABuuYZ ]ABzzYZ", not "ABooYZ AB[uuYZ AB]zzYZ".
 */
export function optimizeLineChunks(
  lines1: readonly LineInfo[],
  lines2: readonly LineInfo[],
  iterable: DiffIterable,
): DiffIterable {
  const nextUnimportant = (lines: readonly LineInfo[], offset: number, count: number, threshold: number) => {
    for (let i = 0; i < count; i++) if (lines[offset + i]!.nonSpaceChars <= threshold) return i;
    return -1;
  };
  const prevUnimportant = (lines: readonly LineInfo[], offset: number, count: number, threshold: number) => {
    for (let i = 0; i < count; i++) if (lines[offset - i]!.nonSpaceChars <= threshold) return i;
    return -1;
  };
  const toShift = (forward: number, backward: number): number | null => {
    if (forward === -1 && backward === -1) return null;
    if (forward === 0 || backward === 0) return 0;
    return forward !== -1 ? forward : -backward;
  };
  const keys1 = lines1.map((l) => l.key);
  const keys2 = lines2.map((l) => l.key);
  return optimize(keys1, keys2, iterable, (touchLeft, equalForward, equalBackward, range1, range2) => {
    // an empty line boundary in unchanged lines: the insertion / deletion goes right before / after it
    const unchangedBoundary = (threshold: number) => {
      const lines = touchLeft ? lines1 : lines2;
      const touchStart = touchLeft ? range2.start1 : range2.start2;
      return toShift(
        nextUnimportant(lines, touchStart, equalForward + 1, threshold),
        prevUnimportant(lines, touchStart - 1, equalBackward + 1, threshold),
      );
    };
    // an empty line boundary in changed lines: the insertion / deletion starts / ends with it
    const changedBoundary = (threshold: number) => {
      const lines = touchLeft ? lines2 : lines1;
      const changeStart = touchLeft ? range1.end2 : range1.end1;
      const changeEnd = touchLeft ? range2.start2 : range2.start1;
      return toShift(
        nextUnimportant(lines, changeStart, equalForward + 1, threshold),
        prevUnimportant(lines, changeEnd - 1, equalBackward + 1, threshold),
      );
    };
    return (
      unchangedBoundary(0) ??
      changedBoundary(0) ??
      unchangedBoundary(UNIMPORTANT_LINE_CHAR_COUNT) ??
      changedBoundary(UNIMPORTANT_LINE_CHAR_COUNT) ??
      0
    );
  });
}
