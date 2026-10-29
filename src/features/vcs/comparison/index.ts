/**
 * IntelliJ's text comparison (ComparisonManagerImpl.compareLinesInner and
 * processBlocks, ported; Apache-2.0, Copyright JetBrains s.r.o. and
 * contributors): lines are compared, each changed block is compared by words
 * and split into line blocks, then adjoining blocks are squashed back and,
 * when ignoring whitespace and empty lines, whitespace-only blocks trimmed.
 */
import { compareLines } from "./byLine";
import { compareAndSplit } from "./byWord";
import { DiffTooBigError, type Range } from "./lcs";
import { type ComparisonPolicy, isEqualTexts, stripSpaces } from "./text";

export type { ComparisonPolicy } from "./text";
export type { Range } from "./lcs";
export { compareWords } from "./byWord";

export interface LineFragment {
  readonly startLine1: number;
  readonly endLine1: number;
  readonly startLine2: number;
  readonly endLine2: number;
  /** Text offsets; the end includes the last line's line break, when it has one. */
  readonly startOffset1: number;
  readonly endOffset1: number;
  readonly startOffset2: number;
  readonly endOffset2: number;
  /**
   * Changed ranges inside the fragment, relative to its start offsets; null
   * when not computed (by-line highlighting, or a block too big to compare).
   */
  readonly inner: readonly Range[] | null;
}

export interface CompareOptions {
  policy: ComparisonPolicy;
  /** Compare changed blocks by words ("Highlight words"). */
  words: boolean;
  /** Drop leading / trailing whitespace-only blocks ("Ignore whitespaces and empty lines"). */
  trimChunks?: boolean;
  /** Keep the line blocks words split a change into ("Highlight split changes"). */
  split?: boolean;
}

/** Do not compare by words after that many blocks were too big (DiffConfig.MAX_BAD_LINES). */
const MAX_BAD_LINES = 3;

class LineOffsets {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) this.starts.push(i + 1);
  }

  get lineCount() {
    return this.starts.length;
  }

  lineStart(line: number) {
    return this.starts[line]!;
  }

  lineEnd(line: number, includeNewline = false) {
    if (line === this.starts.length - 1) return this.text.length;
    return this.starts[line + 1]! - (includeNewline ? 0 : 1);
  }

  lines(): string[] {
    return this.starts.map((_, i) => this.text.slice(this.lineStart(i), this.lineEnd(i)));
  }

  /** Offsets of lines `[start, end)` (ComparisonManagerImpl.getOffsets). */
  offsets(start: number, end: number): [number, number] {
    if (start === end) {
      const offset = start < this.lineCount ? this.lineStart(start) : this.lineEnd(this.lineCount - 1, true);
      return [offset, offset];
    }
    return [this.lineStart(start), this.lineEnd(end - 1, true)];
  }
}

/** Line fragments of two texts with their inner word changes, as IDEA's diff viewer computes them. */
export function compareTexts(text1: string, text2: string, options: CompareOptions): LineFragment[] {
  const { policy } = options;
  const fragments = options.words
    ? compareLinesInner(text1, text2, policy)
    : compareLineFragments(text1, text2, policy);
  return processBlocks(fragments, text1, text2, policy, !options.split, !!options.trimChunks);
}

/** Changed lines (ComparisonManagerImpl.compareLines). */
export function compareLineFragments(text1: string, text2: string, policy: ComparisonPolicy): LineFragment[] {
  const offsets1 = new LineOffsets(text1);
  const offsets2 = new LineOffsets(text2);
  return compareLines(offsets1.lines(), offsets2.lines(), policy).changes.map((r) => {
    const [startOffset1, endOffset1] = offsets1.offsets(r.start1, r.end1);
    const [startOffset2, endOffset2] = offsets2.offsets(r.start2, r.end2);
    return {
      startLine1: r.start1,
      endLine1: r.end1,
      startLine2: r.start2,
      endLine2: r.end2,
      startOffset1,
      endOffset1,
      startOffset2,
      endOffset2,
      inner: null,
    };
  });
}

/** Changed lines split into line blocks with their word changes (ComparisonManagerImpl.compareLinesInner). */
export function compareLinesInner(text1: string, text2: string, policy: ComparisonPolicy): LineFragment[] {
  return innerFragments(compareLineFragments(text1, text2, policy), text1, text2, policy);
}

function innerFragments(
  fragments: readonly LineFragment[],
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
): LineFragment[] {
  const out: LineFragment[] = [];
  let tooBig = 0;
  for (const f of fragments) {
    const sub1 = text1.slice(f.startOffset1, f.endOffset1);
    const sub2 = text2.slice(f.startOffset2, f.endOffset2);
    if (f.startLine1 === f.endLine1 || f.startLine2 === f.endLine2) {
      // insertion / deletion
      out.push(isEqualTexts(sub1, sub2, policy) ? { ...f, inner: [] } : f);
      continue;
    }
    if (tooBig >= MAX_BAD_LINES) {
      out.push(f);
      continue;
    }
    try {
      const blocks = compareAndSplit(sub1, sub2, policy);
      let line1 = f.startLine1;
      let line2 = f.startLine2;
      blocks.forEach((block, i) => {
        // the last block ends with the fragment, whatever its last line
        const last = i === blocks.length - 1;
        const endLine1 = last ? f.endLine1 : line1 + block.newlines1;
        const endLine2 = last ? f.endLine2 : line2 + block.newlines2;
        out.push({
          startLine1: line1,
          endLine1,
          startLine2: line2,
          endLine2,
          startOffset1: f.startOffset1 + block.offsets.start1,
          endOffset1: f.startOffset1 + block.offsets.end1,
          startOffset2: f.startOffset2 + block.offsets.start2,
          endOffset2: f.startOffset2 + block.offsets.end2,
          inner: block.fragments,
        });
        line1 = endLine1;
        line2 = endLine2;
      });
    } catch (e) {
      if (!(e instanceof DiffTooBigError)) throw e;
      out.push(f);
      tooBig++;
    }
  }
  return out;
}

const adjoining = (before: LineFragment, after: LineFragment) =>
  before.endLine1 === after.startLine1 &&
  before.endLine2 === after.startLine2 &&
  before.endOffset1 === after.startOffset1 &&
  before.endOffset2 === after.startOffset2;

/** Squashes adjoining fragments and trims whitespace-only ones at their edges (processBlocks). */
export function processBlocks(
  fragments: LineFragment[],
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  squash: boolean,
  trim: boolean,
): LineFragment[] {
  if ((!squash && !trim) || !fragments.length) return fragments;
  const out: LineFragment[] = [];
  let start = 0;
  for (let i = 1; i <= fragments.length; i++) {
    if (i < fragments.length && adjoining(fragments[i - 1]!, fragments[i]!)) continue;
    out.push(...processAdjoining(fragments.slice(start, i), text1, text2, policy, squash, trim));
    start = i;
  }
  return out;
}

function processAdjoining(
  fragments: LineFragment[],
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  squash: boolean,
  trim: boolean,
): LineFragment[] {
  let start = 0;
  let end = fragments.length;
  if (trim && policy === "ignore") {
    const ignorable = (f: LineFragment) =>
      (f.inner !== null && f.inner.length === 0) ||
      stripSpaces(text1.slice(f.startOffset1, f.endOffset1)) === stripSpaces(text2.slice(f.startOffset2, f.endOffset2));
    while (start < end && ignorable(fragments[start]!)) start++;
    while (start < end && ignorable(fragments[end - 1]!)) end--;
  }
  if (start === end) return [];
  return squash ? [doSquash(fragments.slice(start, end))] : fragments.slice(start, end);
}

function doSquash(fragments: LineFragment[]): LineFragment {
  if (fragments.length === 1) return fragments[0]!;
  const first = fragments[0]!;
  const last = fragments[fragments.length - 1]!;
  const inner: Range[] = [];
  for (const f of fragments) {
    const shift1 = f.startOffset1 - first.startOffset1;
    const shift2 = f.startOffset2 - first.startOffset2;
    const own = f.inner ?? [
      { start1: 0, end1: f.endOffset1 - f.startOffset1, start2: 0, end2: f.endOffset2 - f.startOffset2 },
    ];
    for (const r of own) {
      const prev = inner[inner.length - 1];
      if (prev && prev.end1 === r.start1 + shift1 && prev.end2 === r.start2 + shift2)
        inner[inner.length - 1] = {
          start1: prev.start1,
          end1: r.end1 + shift1,
          start2: prev.start2,
          end2: r.end2 + shift2,
        };
      else
        inner.push({
          start1: r.start1 + shift1,
          end1: r.end1 + shift1,
          start2: r.start2 + shift2,
          end2: r.end2 + shift2,
        });
    }
  }
  return {
    startLine1: first.startLine1,
    endLine1: last.endLine1,
    startLine2: first.startLine2,
    endLine2: last.endLine2,
    startOffset1: first.startOffset1,
    endOffset1: last.endOffset1,
    startOffset2: first.startOffset2,
    endOffset2: last.endOffset2,
    inner,
  };
}
