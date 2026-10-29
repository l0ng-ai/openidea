/**
 * Line-level comparison (IntelliJ's ByLineRt with SmartLineChangeCorrector,
 * ported; Apache-2.0, Copyright JetBrains s.r.o. and contributors): lines are
 * first matched ignoring whitespace and "unimportant" lines (blank, `}`), the
 * gaps are filled, boundaries optimized, then whitespace-only matches that
 * the policy doesn't allow are corrected.
 */
import { optimizeLineChunks, UNIMPORTANT_LINE_CHAR_COUNT, type LineInfo } from "./chunkOptimizer";
import {
  ChangeBuilder,
  create,
  type DiffIterable,
  diffSequences,
  expandEqual,
  ExpandChangeBuilder,
  unchanged,
} from "./iterables";
import { isEmptyRange, type Range } from "./lcs";
import { type ComparisonPolicy, isSpace, lineKey } from "./text";

interface Line extends LineInfo {
  readonly content: string;
  /** The key ignoring whitespace. */
  readonly iwKey: string;
}

function toLine(content: string, policy: ComparisonPolicy): Line {
  let nonSpaceChars = 0;
  for (let i = 0; i < content.length; i++) if (!isSpace(content[i])) nonSpaceChars++;
  const iwKey = lineKey(content, "ignore");
  return { content, key: policy === "ignore" ? iwKey : lineKey(content, policy), iwKey, nonSpaceChars };
}

/** Line changes between two lists of line texts (without line breaks). */
export function compareLines(
  lines1: readonly string[],
  lines2: readonly string[],
  policy: ComparisonPolicy,
): DiffIterable {
  const l1 = lines1.map((l) => toLine(l, policy));
  const l2 = lines2.map((l) => toLine(l, policy));
  const iw1 = l1.map((l) => l.iwKey);
  const iw2 = l2.map((l) => l.iwKey);
  if (policy === "ignore") {
    const changes = optimizeLineChunks(l1, l2, compareSmart(l1, l2, iw1, iw2));
    const keys1 = l1.map((l) => l.key);
    const keys2 = l2.map((l) => l.key);
    const expanded: Range[] = [];
    for (const c of changes.changes) {
      const r = expandEqual(keys1, keys2, c.start1, c.start2, c.end1, c.end2);
      if (!isEmptyRange(r)) expanded.push(r);
    }
    return create(expanded, l1.length, l2.length);
  }
  const iwChanges = optimizeLineChunks(l1, l2, compareSmart(l1, l2, iw1, iw2));
  return correctChangesSecondStep(l1, l2, iwChanges);
}

/**
 * Matches lines ignoring the unimportant ones, then compares the gaps between
 * the matches with all lines (compareSmart + SmartLineChangeCorrector).
 */
function compareSmart(
  lines1: readonly Line[],
  lines2: readonly Line[],
  keys1: string[],
  keys2: string[],
): DiffIterable {
  const big = (lines: readonly Line[]) => {
    const indexes: number[] = [];
    lines.forEach((l, i) => l.nonSpaceChars > UNIMPORTANT_LINE_CHAR_COUNT && indexes.push(i));
    return indexes;
  };
  const indexes1 = big(lines1);
  const indexes2 = big(lines2);
  const changes = diffSequences(
    indexes1.map((i) => keys1[i]!),
    indexes2.map((i) => keys2[i]!),
  );
  const builder = new ChangeBuilder(lines1.length, lines2.length);
  const matchGap = (start1: number, end1: number, start2: number, end2: number) => {
    const expand = expandEqual(keys1, keys2, start1, start2, end1, end2);
    const inner = diffSequences(keys1.slice(expand.start1, expand.end1), keys2.slice(expand.start2, expand.end2));
    builder.markEqual(start1, start2, expand.start1, expand.start2);
    for (const r of unchanged(inner))
      builder.markEqualCount(expand.start1 + r.start1, expand.start2 + r.start2, r.end1 - r.start1);
    builder.markEqual(expand.end1, expand.end2, end1, end2);
  };
  let last1 = 0;
  let last2 = 0;
  for (const r of unchanged(changes)) {
    for (let i = 0; i < r.end1 - r.start1; i++) {
      const start1 = indexes1[r.start1 + i]!;
      const start2 = indexes2[r.start2 + i]!;
      matchGap(last1, start1, last2, start2);
      builder.markEqual(start1, start2, start1 + 1, start2 + 1);
      last1 = start1 + 1;
      last2 = start2 + 1;
    }
  }
  matchGap(last1, lines1.length, last2, lines2.length);
  return builder.finish();
}

/**
 * Fixes lines matched ignoring whitespace but not equal under the policy
 * (ByLineRt.correctChangesSecondStep). Equal lines stay matched, unmatched
 * stay unmatched; for whitespace-equal runs the alignment with the most equal
 * pairs wins, so ".{ ..{ ...{" vs "..{ ...{" matches the last two.
 */
function correctChangesSecondStep(
  lines1: readonly Line[],
  lines2: readonly Line[],
  changes: DiffIterable,
): DiffIterable {
  const builder = new ExpandChangeBuilder(
    lines1.map((l) => l.key),
    lines2.map((l) => l.key),
  );
  const equal = (i1: number, i2: number) => lines1[i1]!.key === lines2[i2]!.key;
  let sample: string | null = null;
  let last1 = 0;
  let last2 = 0;

  const alignExactMatching = (sub1: number[], sub2: number[]) => {
    const n = Math.max(sub1.length, sub2.length);
    // brute force over the combinations: limit the search space
    if (n > 10 || sub1.length === sub2.length) {
      for (let i = 0; i < Math.min(sub1.length, sub2.length); i++)
        if (equal(sub1[i]!, sub2[i]!)) builder.markEqual(sub1[i]!, sub2[i]!);
      return;
    }
    if (sub1.length < sub2.length) {
      const matching = bestMatchingAlignment(sub1, sub2, equal);
      for (let i = 0; i < sub1.length; i++) {
        const index2 = sub2[matching[i]!]!;
        if (equal(sub1[i]!, index2)) builder.markEqual(sub1[i]!, index2);
      }
    } else {
      const matching = bestMatchingAlignment(sub2, sub1, (i2, i1) => equal(i1, i2));
      for (let i = 0; i < sub2.length; i++) {
        const index1 = sub1[matching[i]!]!;
        if (equal(index1, sub2[i]!)) builder.markEqual(index1, sub2[i]!);
      }
    }
  };

  const flush = (line1: number, line2: number) => {
    if (sample === null) return;
    const start1 = Math.max(last1, builder.index1);
    const start2 = Math.max(last2, builder.index2);
    const sub1: number[] = [];
    const sub2: number[] = [];
    for (let i = start1; i < line1; i++)
      if (lines1[i]!.iwKey === sample) {
        sub1.push(i);
        last1 = i + 1;
      }
    for (let i = start2; i < line2; i++)
      if (lines2[i]!.iwKey === sample) {
        sub2.push(i);
        last2 = i + 1;
      }
    alignExactMatching(sub1, sub2);
    sample = null;
  };

  for (const r of unchanged(changes)) {
    for (let i = 0; i < r.end1 - r.start1; i++) {
      const index1 = r.start1 + i;
      const index2 = r.start2 + i;
      if (sample === lines1[index1]!.iwKey) continue;
      flush(index1, index2);
      if (equal(index1, index2)) builder.markEqual(index1, index2);
      else sample = lines1[index1]!.iwKey;
    }
  }
  flush(changes.length1, changes.length2);
  return builder.finish();
}

/** The combination of `sub2` positions for `sub1` with the most equal pairs (getBestMatchingAlignment). */
function bestMatchingAlignment(sub1: number[], sub2: number[], equal: (i1: number, i2: number) => boolean): number[] {
  const size = sub1.length;
  const comb = new Array<number>(size).fill(0);
  let best = Array.from({ length: size }, (_, i) => i);
  let bestWeight = 0;
  const combinations = (start: number, n: number, k: number) => {
    if (k === size) {
      let weight = 0;
      for (let i = 0; i < size; i++) if (equal(sub1[i]!, sub2[comb[i]!]!)) weight++;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = [...comb];
      }
      return;
    }
    for (let i = start; i <= n; i++) {
      comb[k] = i;
      combinations(i + 1, n, k + 1);
    }
  };
  combinations(0, sub2.length - 1, 0);
  return best;
}
