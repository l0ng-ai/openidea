/**
 * Changed / unchanged ranges between two sequences (IntelliJ's DiffIterable
 * and DiffIterableUtil, ported; Apache-2.0, Copyright JetBrains s.r.o. and
 * contributors). Changes are kept as a sorted list; "fair" iterables, whose
 * unchanged ranges have equal lengths on both sides, use the same shape.
 */
import { diffKeys, isEmptyRange, range, type Range } from "./lcs";

export interface DiffIterable {
  readonly length1: number;
  readonly length2: number;
  readonly changes: readonly Range[];
}

export const create = (changes: readonly Range[], length1: number, length2: number): DiffIterable => ({
  length1,
  length2,
  changes,
});

/** The ranges between the changes (ChangeDiffIterableBase.UnchangedIterator). */
export function unchanged(it: DiffIterable): Range[] {
  const out: Range[] = [];
  let last1 = 0;
  let last2 = 0;
  let i = 0;
  const { changes } = it;
  if (changes.length && changes[0]!.start1 === 0 && changes[0]!.start2 === 0) {
    last1 = changes[0]!.end1;
    last2 = changes[0]!.end2;
    i = 1;
  }
  for (; i < changes.length; i++) {
    const c = changes[i]!;
    out.push(range(last1, c.start1, last2, c.start2));
    last1 = c.end1;
    last2 = c.end2;
  }
  if (last1 !== it.length1 || last2 !== it.length2) out.push(range(last1, it.length1, last2, it.length2));
  return out;
}

export const invert = (it: DiffIterable): DiffIterable => create(unchanged(it), it.length1, it.length2);

export const createUnchanged = (ranges: readonly Range[], length1: number, length2: number) =>
  invert(create(ranges, length1, length2));

/** Changes of sequences of keys compared by equality (DiffIterableUtil.diff). */
export const diffSequences = <T>(a: readonly T[], b: readonly T[]): DiffIterable =>
  create(diffKeys(a, b), a.length, b.length);

/** The part of `changed` inside the given ranges, relative to their starts (SubiterableDiffIterable). */
export function subIterable(
  changed: readonly Range[],
  start1: number,
  end1: number,
  start2: number,
  end2: number,
  firstIndex: number,
): DiffIterable {
  const out: Range[] = [];
  for (let i = firstIndex; i < changed.length; i++) {
    const r = changed[i]!;
    if (r.end1 < start1 || r.end2 < start2) continue;
    if (r.start1 > end1 || r.start2 > end2) break;
    const sub = range(
      Math.max(start1, r.start1) - start1,
      Math.min(end1, r.end1) - start1,
      Math.max(start2, r.start2) - start2,
      Math.min(end2, r.end2) - start2,
    );
    if (!isEmptyRange(sub)) out.push(sub);
  }
  return create(out, end1 - start1, end2 - start2);
}

/** Collects changes from the equal ranges marked in order (DiffIterableUtil.ChangeBuilder). */
export class ChangeBuilder {
  index1 = 0;
  index2 = 0;
  protected readonly changes: Range[] = [];

  constructor(
    readonly length1: number,
    readonly length2: number,
  ) {}

  markEqual(index1: number, index2: number, end1 = index1 + 1, end2 = index2 + 1) {
    if (index1 === end1 && index2 === end2) return;
    if (this.index1 !== index1 || this.index2 !== index2) this.addChange(this.index1, this.index2, index1, index2);
    this.index1 = end1;
    this.index2 = end2;
  }

  markEqualCount(index1: number, index2: number, count: number) {
    this.markEqual(index1, index2, index1 + count, index2 + count);
  }

  finish(): DiffIterable {
    if (this.length1 !== this.index1 || this.length2 !== this.index2) {
      this.addChange(this.index1, this.index2, this.length1, this.length2);
      this.index1 = this.length1;
      this.index2 = this.length2;
    }
    return create(this.changes, this.length1, this.length2);
  }

  protected addChange(start1: number, start2: number, end1: number, end2: number) {
    this.changes.push(range(start1, end1, start2, end2));
  }
}

/** A ChangeBuilder that shrinks each change by its equal ends (ExpandChangeBuilder). */
export class ExpandChangeBuilder<T> extends ChangeBuilder {
  constructor(
    private readonly objects1: readonly T[],
    private readonly objects2: readonly T[],
  ) {
    super(objects1.length, objects2.length);
  }

  protected override addChange(start1: number, start2: number, end1: number, end2: number) {
    const r = expandEqual(this.objects1, this.objects2, start1, start2, end1, end2);
    if (!isEmptyRange(r)) super.addChange(r.start1, r.start2, r.end1, r.end2);
  }
}

/** Shrinks `[start, end)` by the equal elements at both ends (TrimUtil.expand). */
export function expandEqual<T>(
  a: ArrayLike<T>,
  b: ArrayLike<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): Range {
  const forward = expandForward(a, b, start1, start2, end1, end2);
  start1 += forward;
  start2 += forward;
  const backward = expandBackward(a, b, start1, start2, end1, end2);
  return range(start1, end1 - backward, start2, end2 - backward);
}

export function expandForward<T>(
  a: ArrayLike<T>,
  b: ArrayLike<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): number {
  const old = start1;
  while (start1 < end1 && start2 < end2 && a[start1] === b[start2]) {
    start1++;
    start2++;
  }
  return start1 - old;
}

export function expandBackward<T>(
  a: ArrayLike<T>,
  b: ArrayLike<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): number {
  const old = end1;
  while (start1 < end1 && start2 < end2 && a[end1 - 1] === b[end2 - 1]) {
    end1--;
    end2--;
  }
  return old - end1;
}
