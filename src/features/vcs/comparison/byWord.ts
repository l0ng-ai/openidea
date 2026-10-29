/**
 * Word-level comparison of a changed block (IntelliJ's ByWordRt
 * .compareAndSplit with LineFragmentSplitter, ported; Apache-2.0, Copyright
 * JetBrains s.r.o. and contributors): words and line breaks are diffed, the
 * block is split into "logically different" line blocks, punctuation between
 * matched words is matched by character, and whitespace by the policy.
 */
import { comparePunctuation } from "./byChar";
import { optimizeWordChunks, type WordChunk } from "./chunkOptimizer";
import { ChangeBuilder, create, type DiffIterable, diffSequences, subIterable, unchanged } from "./iterables";
import { isEmptyRange, range, type Range } from "./lcs";
import {
  type ComparisonPolicy,
  charCount,
  expandWhitespaces,
  expandWhitespacesBackward,
  expandWhitespacesForward,
  isAlpha,
  isContinuousScript,
  isEqualsIgnoreWhitespacesRange,
  isEqualsRange,
  isSpace,
  trimEnd,
  trimRange,
  trimStart,
} from "./text";

export interface InlineChunk extends WordChunk {
  /** Equal keys are equal chunks: the word itself, or "\n". */
  readonly key: string;
}

/**
 * The words of a text (ByWordRt.getInlineChunks): runs of letters and digits
 * (anything but ASCII whitespace and punctuation), single characters of
 * scripts written without spaces, and line breaks. Punctuation is matched
 * separately.
 */
export function getInlineChunks(text: string): InlineChunk[] {
  const chunks: InlineChunk[] = [];
  const word = (from: number, to: number): InlineChunk => ({
    offset1: from,
    offset2: to,
    newline: false,
    key: text.slice(from, to),
  });
  let wordStart = -1;
  for (let offset = 0; offset < text.length;) {
    const ch = text.codePointAt(offset)!;
    const n = charCount(ch);
    const alpha = isAlpha(ch);
    if (alpha && !isContinuousScript(ch)) {
      if (wordStart === -1) wordStart = offset;
    } else {
      if (wordStart !== -1) {
        chunks.push(word(wordStart, offset));
        wordStart = -1;
      }
      if (alpha) chunks.push(word(offset, offset + n));
      else if (ch === 10) chunks.push({ offset1: offset, offset2: offset + 1, newline: true, key: "\n" });
    }
    offset += n;
  }
  if (wordStart !== -1) chunks.push(word(wordStart, text.length));
  return chunks;
}

/** Word changes of two texts (ByWordRt.compare). */
export function compareWords(text1: string, text2: string, policy: ComparisonPolicy): readonly Range[] {
  const words1 = getInlineChunks(text1);
  const words2 = getInlineChunks(text2);
  const keys1 = words1.map((w) => w.key);
  const keys2 = words2.map((w) => w.key);
  let wordChanges = diffSequences(keys1, keys2);
  wordChanges = optimizeWordChunks(keys1, keys2, words1, words2, text1, text2, wordChanges);
  const delimiters = matchPunctuation(text1, text2, words1, words2, 0, 0, wordChanges);
  return matchWhitespaces(text1, text2, delimiters, policy).changes;
}

export interface LineBlock {
  /** Changed ranges of the block's texts, relative to `offsets`. */
  readonly fragments: readonly Range[];
  readonly offsets: Range;
  readonly newlines1: number;
  readonly newlines2: number;
}

/** Word changes of a changed line block, split into line blocks (ByWordRt.compareAndSplit). */
export function compareAndSplit(text1: string, text2: string, policy: ComparisonPolicy): LineBlock[] {
  const words1 = getInlineChunks(text1);
  const words2 = getInlineChunks(text2);
  const keys1 = words1.map((w) => w.key);
  const keys2 = words2.map((w) => w.key);
  let wordChanges = diffSequences(keys1, keys2);
  wordChanges = optimizeWordChunks(keys1, keys2, words1, words2, text1, text2, wordChanges);
  const wordBlocks = splitLineFragments(text1, text2, words1, words2, wordChanges);

  const changed = wordChanges.changes;
  let index = 0;
  return wordBlocks.map((block) => {
    const { offsets, words } = block;
    while (index < changed.length) {
      const r = changed[index]!;
      if (r.end1 < words.start1 || r.end2 < words.start2) index++;
      else break;
    }
    const sub = subIterable(changed, words.start1, words.end1, words.start2, words.end2, index);
    const subtext1 = text1.slice(offsets.start1, offsets.end1);
    const subtext2 = text2.slice(offsets.start2, offsets.end2);
    const subwords1 = words1.slice(words.start1, words.end1);
    const subwords2 = words2.slice(words.start2, words.end2);
    const delimiters = matchPunctuation(subtext1, subtext2, subwords1, subwords2, offsets.start1, offsets.start2, sub);
    const iterable = matchWhitespaces(subtext1, subtext2, delimiters, policy);
    return {
      fragments: iterable.changes,
      offsets,
      newlines1: subwords1.filter((w) => w.newline).length,
      newlines2: subwords2.filter((w) => w.newline).length,
    };
  });
}

interface WordBlock {
  readonly words: Range;
  readonly offsets: Range;
}

interface PendingChunk {
  readonly block: WordBlock;
  readonly hasEqualWords: boolean;
  readonly hasWordsInside: boolean;
  readonly isEqualIgnoreWhitespaces: boolean;
}

/**
 * Splits a changed block at matched line breaks and at matched first words of
 * lines (LineFragmentSplitter). Word indexes: -1 is the start of the text,
 * `words.length` its end.
 */
function splitLineFragments(
  text1: string,
  text2: string,
  words1: readonly InlineChunk[],
  words2: readonly InlineChunk[],
  iterable: DiffIterable,
): WordBlock[] {
  const result: WordBlock[] = [];
  let last1 = -1;
  let last2 = -1;
  let pending: PendingChunk | null = null;

  const offset = (words: readonly InlineChunk[], text: string, index: number) =>
    index === -1 ? 0 : index === words.length ? text.length : words[index]!.offset2;

  const createChunk = (start1: number, start2: number, end1: number, end2: number, hasEqualWords: boolean) => {
    const offsets = range(
      offset(words1, text1, start1),
      offset(words1, text1, end1),
      offset(words2, text2, start2),
      offset(words2, text2, end2),
    );
    const words = range(
      Math.max(0, start1 + 1),
      Math.min(end1 + 1, words1.length),
      Math.max(0, start2 + 1),
      Math.min(end2 + 1, words2.length),
    );
    const block = { words, offsets };
    let hasWordsInside = false;
    for (let i = words.start1; i < words.end1 && !hasWordsInside; i++) hasWordsInside = !words1[i]!.newline;
    for (let i = words.start2; i < words.end2 && !hasWordsInside; i++) hasWordsInside = !words2[i]!.newline;
    return {
      block,
      hasEqualWords,
      hasWordsInside,
      isEqualIgnoreWhitespaces: isEqualsIgnoreWhitespacesRange(text1, text2, offsets),
    };
  };

  const shouldMerge = (c1: PendingChunk, c2: PendingChunk) =>
    // lines matched only by '\n'
    (!c1.hasEqualWords && !c2.hasEqualWords) ||
    // whitespace-only changed lines
    (c1.isEqualIgnoreWhitespaces && c2.isEqualIgnoreWhitespaces) ||
    // a block without words in it
    !c1.hasWordsInside ||
    !c2.hasWordsInside;

  const merge = (c1: PendingChunk, c2: PendingChunk): PendingChunk => ({
    block: {
      words: range(c1.block.words.start1, c2.block.words.end1, c1.block.words.start2, c2.block.words.end2),
      offsets: range(c1.block.offsets.start1, c2.block.offsets.end1, c1.block.offsets.start2, c2.block.offsets.end2),
    },
    hasEqualWords: c1.hasEqualWords || c2.hasEqualWords,
    hasWordsInside: c1.hasWordsInside || c2.hasWordsInside,
    isEqualIgnoreWhitespaces: c1.isEqualIgnoreWhitespaces && c2.isEqualIgnoreWhitespaces,
  });

  const addLineChunk = (end1: number, end2: number, hasEqualWords: boolean) => {
    if (last1 > end1 || last2 > end2) return;
    const chunk = createChunk(last1, last2, end1, end2, hasEqualWords);
    if (isEmptyRange(chunk.block.offsets)) return;
    if (pending && shouldMerge(pending, chunk)) pending = merge(pending, chunk);
    else {
      if (pending) result.push(pending.block);
      pending = chunk;
    }
    last1 = end1;
    last2 = end2;
  };

  const firstInLine = (words: readonly InlineChunk[], index: number) => index === 0 || words[index - 1]!.newline;

  let hasEqualWords = false;
  for (const r of unchanged(iterable)) {
    for (let i = 0; i < r.end1 - r.start1; i++) {
      const index1 = r.start1 + i;
      const index2 = r.start2 + i;
      if (words1[index1]!.newline && words2[index2]!.newline) {
        // split by matched newlines
        addLineChunk(index1, index2, hasEqualWords);
        hasEqualWords = false;
      } else {
        if (firstInLine(words1, index1) && firstInLine(words2, index2)) {
          // split by matched first word in line
          addLineChunk(index1 - 1, index2 - 1, hasEqualWords);
          hasEqualWords = false;
        }
        hasEqualWords = true;
      }
    }
  }
  addLineChunk(words1.length, words2.length, hasEqualWords);
  if (pending) result.push((pending as PendingChunk).block);
  return result;
}

/**
 * Matches punctuation between words (AdjustmentPunctuationMatcher): the
 * separators around each pair of matched words are compared by character, so
 * "[ X { A ! B } Y ]" vs "( X ... Y )" compares "[" with "(", "{" + "}" with
 * "..." and "]" with ")".
 */
function matchPunctuation(
  text1: string,
  text2: string,
  words1: readonly InlineChunk[],
  words2: readonly InlineChunk[],
  startShift1: number,
  startShift2: number,
  changes: DiffIterable,
): DiffIterable {
  const len1 = text1.length;
  const len2 = text2.length;
  const builder = new ChangeBuilder(len1, len2);
  const startOffset1 = (i: number) => words1[i]!.offset1 - startShift1;
  const startOffset2 = (i: number) => words2[i]!.offset1 - startShift2;
  const endOffset1 = (i: number) => words1[i]!.offset2 - startShift1;
  const endOffset2 = (i: number) => words2[i]!.offset2 - startShift2;
  let lastStart1 = -1;
  let lastStart2 = -1;
  let lastEnd1 = -1;
  let lastEnd2 = -1;

  const matchRange = (start1: number, start2: number, end1: number, end2: number) => {
    if (start1 === end1 && start2 === end2) return;
    const inner = comparePunctuation(text1.slice(start1, end1), text2.slice(start2, end2));
    for (const r of unchanged(inner))
      builder.markEqual(start1 + r.start1, start2 + r.start2, start1 + r.end1, start2 + r.end2);
  };

  // One sequence compared with two others as if they were one (comparePunctuation2Side).
  const compare2Side = (text: string, text21: string, text22: string): [Range[], Range[]] => {
    const changes = comparePunctuation(text, text21 + text22);
    const ranges1: Range[] = [];
    const ranges2: Range[] = [];
    const split = text21.length;
    for (const r of unchanged(changes)) {
      if (r.end2 <= split) ranges1.push(r);
      else if (r.start2 >= split) ranges2.push(range(r.start1, r.end1, r.start2 - split, r.end2 - split));
      else {
        const len = split - r.start2;
        ranges1.push(range(r.start1, r.start1 + len, r.start2, split));
        ranges2.push(range(r.start1 + len, r.end1, 0, r.end2 - split));
      }
    }
    return [ranges1, ranges2];
  };

  const matchComplexRange = (
    start11: number,
    start12: number,
    end11: number,
    end12: number,
    start21: number,
    start22: number,
    end21: number,
    end22: number,
  ) => {
    if (start11 === start21 && end11 === end21) {
      const [first, second] = compare2Side(
        text1.slice(start11, end11),
        text2.slice(start12, end12),
        text2.slice(start22, end22),
      );
      for (const r of first)
        builder.markEqual(start11 + r.start1, start12 + r.start2, start11 + r.end1, start12 + r.end2);
      for (const r of second)
        builder.markEqual(start11 + r.start1, start22 + r.start2, start11 + r.end1, start22 + r.end2);
    } else if (start12 === start22 && end12 === end22) {
      // mirrored: two left sides against one right side
      const [first, second] = compare2Side(
        text2.slice(start12, end12),
        text1.slice(start11, end11),
        text1.slice(start21, end21),
      );
      for (const r of first)
        builder.markEqual(start11 + r.start2, start12 + r.start1, start11 + r.end2, start12 + r.end1);
      for (const r of second)
        builder.markEqual(start21 + r.start2, start12 + r.start1, start21 + r.end2, start12 + r.end1);
    } else {
      throw new Error("unexpected punctuation ranges");
    }
  };

  const matchForward = (index1: number, index2: number) => {
    lastStart1 = index1 === -1 ? 0 : endOffset1(index1);
    lastStart2 = index2 === -1 ? 0 : endOffset2(index2);
    lastEnd1 = index1 + 1 === words1.length ? len1 : startOffset1(index1 + 1);
    lastEnd2 = index2 + 1 === words2.length ? len2 : startOffset2(index2 + 1);
  };

  const matchBackward = (index1: number, index2: number) => {
    const start1 = index1 === 0 ? 0 : endOffset1(index1 - 1);
    const start2 = index2 === 0 ? 0 : endOffset2(index2 - 1);
    const end1 = index1 === words1.length ? len1 : startOffset1(index1);
    const end2 = index2 === words2.length ? len2 : startOffset2(index2);
    if (lastStart1 === start1 && lastStart2 === start2) {
      // adjacent matched words, match the gap between ("A B" - "A B")
      matchRange(start1, start2, end1, end2);
    } else if (lastStart1 < start1 && lastStart2 < start2) {
      // matched words with unmatched ones between ("A X B" - "A Y B")
      matchRange(lastStart1, lastStart2, lastEnd1, lastEnd2);
      matchRange(start1, start2, end1, end2);
    } else {
      // one side adjacent, the other with unmatched words between ("A B" - "A Y B")
      matchComplexRange(lastStart1, lastStart2, lastEnd1, lastEnd2, start1, start2, end1, end2);
    }
    lastStart1 = lastStart2 = lastEnd1 = lastEnd2 = -1;
  };

  matchForward(-1, -1);
  for (const r of unchanged(changes)) {
    for (let i = 0; i < r.end1 - r.start1; i++) {
      const index1 = r.start1 + i;
      const index2 = r.start2 + i;
      matchBackward(index1, index2);
      builder.markEqual(startOffset1(index1), startOffset2(index2), endOffset1(index1), endOffset2(index2));
      matchForward(index1, index2);
    }
  }
  matchBackward(words1.length, words2.length);
  return builder.finish();
}

/** Whitespace handling of the changes by policy (ByWordRt.matchAdjustmentWhitespaces). */
export function matchWhitespaces(text1: string, text2: string, iterable: DiffIterable, policy: ComparisonPolicy) {
  if (policy === "ignore") return ignoreSpaces(iterable, text1, text2);
  const corrected = defaultSpaces(iterable, text1, text2);
  return policy === "trim" ? trimSpaces(corrected, text1, text2) : corrected;
}

/** Equal whitespace at the edges of a change is unchanged (DefaultCorrector). */
function defaultSpaces(iterable: DiffIterable, text1: string, text2: string): DiffIterable {
  const changes: Range[] = [];
  for (const r of iterable.changes) {
    const endCut = expandWhitespacesBackward(text1, text2, r.start1, r.start2, r.end1, r.end2);
    const startCut = expandWhitespacesForward(text1, text2, r.start1, r.start2, r.end1 - endCut, r.end2 - endCut);
    const expanded = range(r.start1 + startCut, r.end1 - endCut, r.start2 + startCut, r.end2 - endCut);
    if (!isEmptyRange(expanded)) changes.push(expanded);
  }
  return create(changes, text1.length, text2.length);
}

/** Whitespace is matched where possible and ignored where not (IgnoreSpacesCorrector). */
function ignoreSpaces(iterable: DiffIterable, text1: string, text2: string): DiffIterable {
  const changes: Range[] = [];
  for (const r of iterable.changes) {
    const trimmed = trimRange(text1, text2, expandWhitespaces(text1, text2, r));
    if (!isEmptyRange(trimmed) && !isEqualsIgnoreWhitespacesRange(text1, text2, trimmed)) changes.push(trimmed);
  }
  return create(changes, text1.length, text2.length);
}

function isLeadingSpace(text: string, start: number): boolean {
  if (start < 0 || start === text.length || !isSpace(text[start])) return false;
  for (let i = start - 1; i >= 0; i--) {
    if (text[i] === "\n") return true;
    if (!isSpace(text[i])) return false;
  }
  return true;
}

function isTrailingSpace(text: string, end: number): boolean {
  if (end < 0 || end === text.length || !isSpace(text[end])) return false;
  for (let i = end; i < text.length; i++) {
    if (text[i] === "\n") return true;
    if (!isSpace(text[i])) return false;
  }
  return true;
}

const isLeadingTrailingSpace = (text: string, i: number) => isLeadingSpace(text, i) || isTrailingSpace(text, i);

/** Leading and trailing whitespace of lines is not a change (TrimSpacesCorrector). */
function trimSpaces(iterable: DiffIterable, text1: string, text2: string): DiffIterable {
  const changes: Range[] = [];
  for (const r of iterable.changes) {
    let { start1, start2, end1, end2 } = r;
    if (isLeadingTrailingSpace(text1, start1)) start1 = trimStart(text1, start1, end1);
    if (isLeadingTrailingSpace(text1, end1 - 1)) end1 = trimEnd(text1, start1, end1);
    if (isLeadingTrailingSpace(text2, start2)) start2 = trimStart(text2, start2, end2);
    if (isLeadingTrailingSpace(text2, end2 - 1)) end2 = trimEnd(text2, start2, end2);
    const trimmed = range(start1, end1, start2, end2);
    if (!isEmptyRange(trimmed) && !isEqualsRange(text1, text2, trimmed)) changes.push(trimmed);
  }
  return create(changes, text1.length, text2.length);
}
