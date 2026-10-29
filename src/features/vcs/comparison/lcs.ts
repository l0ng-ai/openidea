/**
 * Longest common subsequence of two sequences, ported from the IntelliJ
 * Platform (`com.intellij.util.diff`: Diff, Reindexer, MyersLCS,
 * PatienceIntLCS, UniqueLCS; Apache-2.0, Copyright JetBrains s.r.o. and
 * contributors): common prefix / suffix trimmed, elements unique to one side
 * discarded, then Myers' O(ND) diff bounded by a threshold, falling back to
 * patience diff when the sequences differ too much.
 */

/** Half-open index ranges `[start1, end1)` and `[start2, end2)`. */
export interface Range {
  readonly start1: number;
  readonly end1: number;
  readonly start2: number;
  readonly end2: number;
}

export const range = (start1: number, end1: number, start2: number, end2: number): Range => ({
  start1,
  end1,
  start2,
  end2,
});

export const isEmptyRange = (r: Range) => r.start1 === r.end1 && r.start2 === r.end2;

/** The sequences differ too much to be compared (DiffTooBigException). */
export class DiffTooBigError extends Error {
  constructor() {
    super("Diff is too big");
  }
}

/** Thrown inside the LCS when a bounded search gives up (FilesTooBigForDiffException). */
class FilesTooBig extends Error {}

/** Changed ranges between two int sequences (Diff.buildChanges). */
export function diffInts(a: ArrayLike<number>, b: ArrayLike<number>): Range[] {
  const n1 = a.length;
  const n2 = b.length;
  let startShift = 0;
  while (startShift < Math.min(n1, n2) && a[startShift] === b[startShift]) startShift++;
  let endCut = 0;
  while (endCut < Math.min(n1, n2) - startShift && a[n1 - endCut - 1] === b[n2 - endCut - 1]) endCut++;
  const len1 = n1 - startShift - endCut;
  const len2 = n2 - startShift - endCut;
  if (len1 === 0 || len2 === 0)
    return len1 || len2 ? [range(startShift, startShift + len1, startShift, startShift + len2)] : [];
  const ints1 = Int32Array.from({ length: len1 }, (_, i) => a[startShift + i]!);
  const ints2 = Int32Array.from({ length: len2 }, (_, i) => b[startShift + i]!);
  try {
    return buildChanges(ints1, ints2, startShift);
  } catch (e) {
    if (e instanceof FilesTooBig) throw new DiffTooBigError();
    throw e;
  }
}

/** Changed ranges between two sequences of keys, equal keys being equal elements. */
export function diffKeys<T>(a: readonly T[], b: readonly T[]): Range[] {
  const numbers = new Map<T, number>();
  const enumerate = (xs: readonly T[]) =>
    Int32Array.from(xs, (x) => {
      let n = numbers.get(x);
      if (n === undefined) numbers.set(x, (n = numbers.size + 1));
      return n;
    });
  return diffInts(enumerate(a), enumerate(b));
}

function buildChanges(ints1: Int32Array, ints2: Int32Array, startShift: number): Range[] {
  const out: Range[] = [];
  let index1 = startShift;
  let index2 = startShift;
  const builder: LCSBuilder = {
    addEqual(length) {
      index1 += length;
      index2 += length;
    },
    addChange(first, second) {
      out.push(range(index1, index1 + first, index2, index2 + second));
      index1 += first;
      index2 += second;
    },
  };
  const reindexer = new Reindexer();
  const [discarded1, discarded2] = reindexer.discardUnique(ints1, ints2);
  if (discarded1.length === 0 && discarded2.length === 0) {
    builder.addChange(ints1.length, ints2.length);
    return out;
  }
  let changes: [Uint8Array, Uint8Array];
  try {
    const lcs = new MyersLCS(discarded1, discarded2);
    lcs.executeWithThreshold();
    changes = lcs.changes;
  } catch (e) {
    if (!(e instanceof FilesTooBig)) throw e;
    const lcs = new PatienceLCS(discarded1, discarded2);
    lcs.execute(true);
    changes = lcs.changes;
  }
  reindexer.reindex(changes, builder);
  return out;
}

interface LCSBuilder {
  addEqual(length: number): void;
  addChange(first: number, second: number): void;
}

const fill = (bits: Uint8Array, from: number, to: number, value = 1) => {
  if (to > from) bits.fill(value, from, to);
};

/** Myers' O(ND) diff with linear space (MyersLCS); `changes` marks the unmatched elements. */
class MyersLCS {
  private readonly vForward: Int32Array;
  private readonly vBackward: Int32Array;

  constructor(
    private readonly first: Int32Array,
    private readonly second: Int32Array,
    private readonly start1 = 0,
    private readonly count1 = first.length,
    private readonly start2 = 0,
    private readonly count2 = second.length,
    private readonly changes1: Uint8Array = new Uint8Array(first.length),
    private readonly changes2: Uint8Array = new Uint8Array(second.length),
  ) {
    fill(changes1, start1, start1 + count1);
    fill(changes2, start2, start2 + count2);
    this.vForward = new Int32Array(count1 + count2 + 1);
    this.vBackward = new Int32Array(count1 + count2 + 1);
  }

  get changes(): [Uint8Array, Uint8Array] {
    return [this.changes1, this.changes2];
  }

  /** Bounds D by A + B·√N: expected O(N) under common assumptions. */
  executeLinear() {
    this.run(20000 + 10 * Math.floor(Math.sqrt(this.count1 + this.count2)), false);
  }

  executeWithThreshold() {
    this.run(Math.max(20000 + 10 * Math.floor(Math.sqrt(this.count1 + this.count2)), DELTA_THRESHOLD_SIZE), true);
  }

  private run(threshold: number, throwException: boolean) {
    if (this.count1 === 0 || this.count2 === 0) return;
    this.execute(0, this.count1, 0, this.count2, Math.min(threshold, this.count1 + this.count2), throwException);
  }

  // LCS(old[oldStart, oldEnd), new[newStart, newEnd))
  private execute(
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number,
    differenceEstimate: number,
    throwException: boolean,
  ) {
    if (!(oldStart < oldEnd && newStart < newEnd)) return;
    const { vForward: VF, vBackward: VB } = this;
    const oldLength = oldEnd - oldStart;
    const newLength = newEnd - newStart;
    VF[newLength + 1] = 0;
    VB[newLength + 1] = 0;
    const halfD = (differenceEstimate + 1) >> 1;
    let xx = -1;
    let kk = -1;
    let td = -1;

    loop: for (let d = 0; d <= halfD; d++) {
      const L = newLength + Math.max(-d, -newLength + ((d ^ newLength) & 1));
      const R = newLength + Math.min(d, oldLength - ((d ^ oldLength) & 1));
      for (let k = L; k <= R; k += 2) {
        let x = k === L || (k !== R && VF[k - 1]! < VF[k + 1]!) ? VF[k + 1]! : VF[k - 1]! + 1;
        const y = x - k + newLength;
        x += this.commonForward(oldStart + x, newStart + y, Math.min(oldEnd - oldStart - x, newEnd - newStart - y));
        VF[k] = x;
      }

      if ((oldLength - newLength) % 2 !== 0) {
        for (let k = L; k <= R; k += 2) {
          if (oldLength - (d - 1) <= k && k <= oldLength + (d - 1)) {
            if (VF[k]! + VB[newLength + oldLength - k]! >= oldLength) {
              xx = VF[k]!;
              kk = k;
              td = 2 * d - 1;
              break loop;
            }
          }
        }
      }

      for (let k = L; k <= R; k += 2) {
        let x = k === L || (k !== R && VB[k - 1]! < VB[k + 1]!) ? VB[k + 1]! : VB[k - 1]! + 1;
        const y = x - k + newLength;
        x += this.commonBackward(
          oldEnd - 1 - x,
          newEnd - 1 - y,
          Math.min(oldEnd - oldStart - x, newEnd - newStart - y),
        );
        VB[k] = x;
      }

      if ((oldLength - newLength) % 2 === 0) {
        for (let k = L; k <= R; k += 2) {
          if (oldLength - d <= k && k <= oldLength + d) {
            if (VF[oldLength + newLength - k]! + VB[k]! >= oldLength) {
              xx = oldLength - VB[k]!;
              kk = oldLength + newLength - k;
              td = 2 * d;
              break loop;
            }
          }
        }
      }
    }

    if (td > 1) {
      const yy = xx - kk + newLength;
      const oldDiff = (td + 1) >> 1;
      if (0 < xx && 0 < yy) this.execute(oldStart, oldStart + xx, newStart, newStart + yy, oldDiff, throwException);
      if (oldStart + xx < oldEnd && newStart + yy < newEnd)
        this.execute(oldStart + xx, oldEnd, newStart + yy, newEnd, td - oldDiff, throwException);
    } else if (td >= 0) {
      let x = oldStart;
      let y = newStart;
      while (x < oldEnd && y < newEnd) {
        const common = this.commonForward(x, y, Math.min(oldEnd - x, newEnd - y));
        if (common > 0) {
          fill(this.changes1, this.start1 + x, this.start1 + x + common, 0);
          fill(this.changes2, this.start2 + y, this.start2 + y + common, 0);
          x += common;
          y += common;
        } else if (oldEnd - oldStart > newEnd - newStart) x++;
        else y++;
      }
    } else if (throwException) {
      // The difference is more than the given estimate.
      throw new FilesTooBig();
    }
  }

  private commonForward(oldIndex: number, newIndex: number, maxLength: number): number {
    let x = oldIndex;
    let y = newIndex;
    maxLength = Math.min(maxLength, this.count1 - oldIndex, this.count2 - newIndex);
    while (x - oldIndex < maxLength && this.first[this.start1 + x] === this.second[this.start2 + y]) {
      x++;
      y++;
    }
    return x - oldIndex;
  }

  private commonBackward(oldIndex: number, newIndex: number, maxLength: number): number {
    let x = oldIndex;
    let y = newIndex;
    maxLength = Math.min(maxLength, Math.min(oldIndex, newIndex) + 1);
    while (oldIndex - x < maxLength && this.first[this.start1 + x] === this.second[this.start2 + y]) {
      x--;
      y--;
    }
    return oldIndex - x;
  }
}

const DELTA_THRESHOLD_SIZE = 20000;

/** Patience diff (PatienceIntLCS): unique common elements anchor the match, Myers fills the gaps. */
class PatienceLCS {
  private readonly changes1: Uint8Array;
  private readonly changes2: Uint8Array;

  constructor(
    private readonly first: Int32Array,
    private readonly second: Int32Array,
  ) {
    this.changes1 = new Uint8Array(first.length);
    this.changes2 = new Uint8Array(second.length);
  }

  get changes(): [Uint8Array, Uint8Array] {
    return [this.changes1, this.changes2];
  }

  execute(failOnSmallReduction = false) {
    this.run(0, this.first.length, 0, this.second.length, failOnSmallReduction ? 2 : -1);
  }

  private run(start1: number, count1: number, start2: number, count2: number, thresholdCheckCounter: number) {
    if (count1 === 0 && count2 === 0) return;
    if (count1 === 0 || count2 === 0) return this.addChange(start1, count1, start2, count2);

    let startOffset = 0;
    while (
      startOffset < Math.min(count1, count2) &&
      this.first[start1 + startOffset] === this.second[start2 + startOffset]
    )
      startOffset++;
    start1 += startOffset;
    start2 += startOffset;
    count1 -= startOffset;
    count2 -= startOffset;
    let endOffset = 0;
    while (
      endOffset < Math.min(count1, count2) &&
      this.first[start1 + count1 - endOffset - 1] === this.second[start2 + count2 - endOffset - 1]
    )
      endOffset++;
    count1 -= endOffset;
    count2 -= endOffset;

    if (count1 === 0 || count2 === 0) return this.addChange(start1, count1, start2, count2);

    if (thresholdCheckCounter === 0) this.checkReduction(count1, count2);
    thresholdCheckCounter = Math.max(-1, thresholdCheckCounter - 1);

    const matching = uniqueLCS(this.first, this.second, start1, count1, start2, count2);
    if (!matching) {
      if (thresholdCheckCounter >= 0) this.checkReduction(count1, count2);
      new MyersLCS(
        this.first,
        this.second,
        start1,
        count1,
        start2,
        count2,
        this.changes1,
        this.changes2,
      ).executeLinear();
      return;
    }
    const [m1, m2] = matching;
    const matched = m1.length;
    this.run(start1, m1[0]!, start2, m2[0]!, thresholdCheckCounter);
    for (let i = 1; i < matched; i++) {
      const s1 = m1[i - 1]! + 1;
      const s2 = m2[i - 1]! + 1;
      const c1 = m1[i]! - s1;
      const c2 = m2[i]! - s2;
      if (c1 > 0 || c2 > 0) this.run(start1 + s1, c1, start2 + s2, c2, thresholdCheckCounter);
    }
    let s1: number, c1: number, s2: number, c2: number;
    if (m1[matched - 1] === count1 - 1) [s1, c1] = [count1 - 1, 0];
    else [s1, c1] = [m1[matched - 1]! + 1, count1 - m1[matched - 1]! - 1];
    if (m2[matched - 1] === count2 - 1) [s2, c2] = [count2 - 1, 0];
    else [s2, c2] = [m2[matched - 1]! + 1, count2 - m2[matched - 1]! - 1];
    this.run(start1 + s1, c1, start2 + s2, c2, thresholdCheckCounter);
  }

  private addChange(start1: number, count1: number, start2: number, count2: number) {
    fill(this.changes1, start1, start1 + count1);
    fill(this.changes2, start2, start2 + count2);
  }

  private checkReduction(count1: number, count2: number) {
    if (count1 * 2 < this.first.length) return;
    if (count2 * 2 < this.second.length) return;
    throw new FilesTooBig();
  }
}

/** Longest increasing run of the elements unique on both sides (UniqueLCS), as relative indexes; null if none. */
function uniqueLCS(
  first: Int32Array,
  second: Int32Array,
  start1: number,
  count1: number,
  start2: number,
  count2: number,
): [Int32Array, Int32Array] | null {
  // key -> (offset1 + 1), or -1 when repeated; match: offset1 -> (offset2 + 1)
  const map = new Map<number, number>();
  const match = new Int32Array(count1);
  for (let i = 0; i < count1; i++) {
    const key = first[start1 + i]!;
    const value = map.get(key) ?? 0;
    if (value === -1) continue;
    map.set(key, value === 0 ? i + 1 : -1);
  }
  let count = 0;
  for (let i = 0; i < count2; i++) {
    const key = second[start2 + i]!;
    const value = map.get(key) ?? 0;
    if (value === 0 || value === -1) continue;
    if (match[value - 1] === 0) {
      match[value - 1] = i + 1;
      count++;
    } else {
      match[value - 1] = 0;
      map.set(key, -1);
      count--;
    }
  }
  if (count === 0) return null;

  const sequence = new Int32Array(count);
  const lastElement = new Int32Array(count);
  const predecessor = new Int32Array(count1);
  let length = 0;
  for (let i = 0; i < count1; i++) {
    const m = match[i]!;
    if (m === 0) continue;
    // first j with sequence[j] > m (elements are distinct)
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sequence[mid]! < m) lo = mid + 1;
      else hi = mid;
    }
    sequence[lo] = m;
    lastElement[lo] = i;
    predecessor[i] = lo > 0 ? lastElement[lo - 1]! : -1;
    if (lo === length) length++;
  }
  const ret: [Int32Array, Int32Array] = [new Int32Array(length), new Int32Array(length)];
  for (let i = length - 1, curr = lastElement[length - 1]!; curr !== -1; i--, curr = predecessor[curr]!) {
    ret[0][i] = curr;
    ret[1][i] = match[curr]! - 1;
  }
  return ret;
}

/** Drops elements that can't be matched and maps the result back (Reindexer). */
class Reindexer {
  private readonly oldIndices: [Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0)];
  private readonly originalLengths = [-1, -1];
  private readonly discardedLengths = [-1, -1];

  discardUnique(ints1: Int32Array, ints2: Int32Array): [Int32Array, Int32Array] {
    const discarded1 = this.discard(ints2, ints1, 0);
    return [discarded1, this.discard(discarded1, ints2, 1)];
  }

  private discard(needed: Int32Array, toDiscard: Int32Array, arrayIndex: 0 | 1): Int32Array {
    this.originalLengths[arrayIndex] = toDiscard.length;
    const present = new Set(needed);
    const discarded: number[] = [];
    const oldIndices: number[] = [];
    for (let i = 0; i < toDiscard.length; i++) {
      if (present.has(toDiscard[i]!)) {
        discarded.push(toDiscard[i]!);
        oldIndices.push(i);
      }
    }
    this.oldIndices[arrayIndex] = Int32Array.from(oldIndices);
    this.discardedLengths[arrayIndex] = discarded.length;
    return Int32Array.from(discarded);
  }

  reindex(discardedChanges: [Uint8Array, Uint8Array], builder: LCSBuilder) {
    const [orig1, orig2] = this.originalLengths as [number, number];
    const [disc1, disc2] = this.discardedLengths as [number, number];
    const [old1, old2] = this.oldIndices;
    let changes1: Uint8Array;
    let changes2: Uint8Array;
    if (disc1 === orig1 && disc2 === orig2) {
      [changes1, changes2] = discardedChanges;
    } else {
      changes1 = new Uint8Array(orig1);
      changes2 = new Uint8Array(orig2);
      const increment = (indexes: Int32Array, i: number, set: Uint8Array, length: number) => {
        fill(set, indexes[i]! + 1, i + 1 < indexes.length ? indexes[i + 1]! : length);
        return i + 1;
      };
      let x = 0;
      let y = 0;
      while (x < disc1 || y < disc2) {
        if (x < disc1 && y < disc2 && !discardedChanges[0][x] && !discardedChanges[1][y]) {
          x = increment(old1, x, changes1, orig1);
          y = increment(old2, y, changes2, orig2);
        } else if (discardedChanges[0][x]) {
          changes1[old1[x]!] = 1;
          x = increment(old1, x, changes1, orig1);
        } else if (discardedChanges[1][y]) {
          changes2[old2[y]!] = 1;
          y = increment(old2, y, changes2, orig2);
        }
      }
      fill(changes1, 0, disc1 === 0 ? orig1 : old1[0]!);
      fill(changes2, 0, disc2 === 0 ? orig2 : old2[0]!);
    }

    let x = 0;
    let y = 0;
    while (x < orig1 && y < orig2) {
      const startX = x;
      while (x < orig1 && y < orig2 && !changes1[x] && !changes2[y]) {
        x++;
        y++;
      }
      if (x > startX) builder.addEqual(x - startX);
      let dx = 0;
      let dy = 0;
      while (x < orig1 && changes1[x]) {
        dx++;
        x++;
      }
      while (y < orig2 && changes2[y]) {
        dy++;
        y++;
      }
      if (dx !== 0 || dy !== 0) builder.addChange(dx, dy);
    }
    if (x !== orig1 || y !== orig2) builder.addChange(orig1 - x, orig2 - y);
  }
}
