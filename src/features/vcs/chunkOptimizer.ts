/**
 * Moves the boundaries of a line diff to where a reader expects them, ported from
 * IntelliJ's `ChunkOptimizer.LineChunkOptimizer`. A diff has several equally short answers
 * when an inserted or deleted block repeats the lines around it (an added method can be
 * said to start at its first line or to end at its closing brace); the shortest diff does not
 * say which, and this picks the one that starts or ends at a blank or near-blank line.
 */

/** An unchanged stretch: lines `s1`–`e1` of the first text are lines `s2`–`e2` of the second. */
export interface Unchanged {
  s1: number;
  e1: number;
  s2: number;
  e2: number;
}

/** Lines with this many characters or fewer, apart from blanks, count as unimportant (`{`, `}`, `);`). */
const UNIMPORTANT = 3;

/** The unchanged stretches between `changes` (each `[from1, to1, from2, to2]`) of two texts of the given lengths. */
export function unchangedBetween(
  changes: readonly (readonly [number, number, number, number])[],
  length1: number,
  length2: number,
): Unchanged[] {
  const out: Unchanged[] = [];
  let p1 = 0;
  let p2 = 0;
  for (const [f1, t1, f2, t2] of changes) {
    if (f1 > p1) out.push({ s1: p1, e1: f1, s2: p2, e2: f2 });
    p1 = t1;
    p2 = t2;
  }
  if (length1 > p1) out.push({ s1: p1, e1: length1, s2: p2, e2: length2 });
  return out;
}

/** The changes between `unchanged` stretches of two texts of the given lengths. */
export function changesBetween(
  unchanged: readonly Unchanged[],
  length1: number,
  length2: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let p1 = 0;
  let p2 = 0;
  for (const u of unchanged) {
    if (u.s1 > p1 || u.s2 > p2) out.push([p1, u.s1, p2, u.s2]);
    p1 = u.e1;
    p2 = u.e2;
  }
  if (length1 > p1 || length2 > p2) out.push([p1, length1, p2, length2]);
  return out;
}

/**
 * Optimizes the changes between two texts. `a` and `b` hold one character per line (equal
 * characters are equal lines); `weightA` and `weightB` the number of characters other than
 * whitespace of each line.
 */
export function optimizeLineChunks(
  a: string,
  b: string,
  weightA: readonly number[],
  weightB: readonly number[],
  unchanged: readonly Unchanged[],
): Unchanged[] {
  const ranges: Unchanged[] = [];

  /** How many lines from (`i1`, `i2`) on are equal, at most `max`. */
  const equalForward = (i1: number, i2: number, max: number) => {
    let n = 0;
    while (n < max && i1 + n < a.length && i2 + n < b.length && a[i1 + n] === b[i2 + n]) n++;
    return n;
  };
  /** How many lines before (`i1`, `i2`) are equal, at most `max`. */
  const equalBackward = (i1: number, i2: number, max: number) => {
    let n = 0;
    while (n < max && i1 - 1 - n >= 0 && i2 - 1 - n >= 0 && a[i1 - 1 - n] === b[i2 - 1 - n]) n++;
    return n;
  };

  const nextUnimportant = (weights: readonly number[], offset: number, count: number, limit: number) => {
    for (let i = 0; i < count; i++) if (weights[offset + i]! <= limit) return i;
    return -1;
  };
  const previousUnimportant = (weights: readonly number[], offset: number, count: number, limit: number) => {
    for (let i = 0; i < count; i++) if (weights[offset - i]! <= limit) return i;
    return -1;
  };
  /** A stretch already at a boundary stays; else forward if one is found there, else backward. */
  const pick = (forward: number, backward: number): number | null => {
    if (forward === -1 && backward === -1) return null;
    if (forward !== 0 && backward !== 0) return forward !== -1 ? forward : -backward;
    return 0;
  };

  /** How far the change between `r1` and `r2` moves; `touchA` when the lines of `a` touch (the change only adds to `b`). */
  const shiftOf = (touchA: boolean, forward: number, backward: number, r1: Unchanged, r2: Unchanged) => {
    const touch = touchA ? weightA : weightB;
    const other = touchA ? weightB : weightA;
    const touchStart = touchA ? r2.s1 : r2.s2;
    const changeStart = touchA ? r1.e2 : r1.e1;
    const changeEnd = touchA ? r2.s2 : r2.s1;
    const atTouch = (limit: number) =>
      pick(
        nextUnimportant(touch, touchStart, forward + 1, limit),
        previousUnimportant(touch, touchStart - 1, backward + 1, limit),
      );
    const atChange = (limit: number) =>
      pick(
        nextUnimportant(other, changeStart, forward + 1, limit),
        previousUnimportant(other, changeEnd - 1, backward + 1, limit),
      );
    return atTouch(0) ?? atChange(0) ?? atTouch(UNIMPORTANT) ?? atChange(UNIMPORTANT) ?? 0;
  };

  const processLast = () => {
    if (ranges.length < 2) return;
    const r1 = ranges[ranges.length - 2]!;
    const r2 = ranges[ranges.length - 1]!;
    // Only a change that adds or removes lines (touching on one side) can move.
    if (r1.e1 !== r2.s1 && r1.e2 !== r2.s2) return;
    const count1 = r1.e1 - r1.s1;
    const count2 = r2.e1 - r2.s1;
    const forward = equalForward(r1.e1, r1.e2, count2);
    const backward = equalBackward(r2.s1, r2.s2, count1);
    if (forward === 0 && backward === 0) return;
    if (forward === count2) {
      // The change slides all the way to the next stretch, and disappears into it.
      ranges.splice(-2, 2, { s1: r1.s1, e1: r1.e1 + count2, s2: r1.s2, e2: r1.e2 + count2 });
      processLast();
    } else if (backward === count1) {
      ranges.splice(-2, 2, { s1: r2.s1 - count1, e1: r2.e1, s2: r2.s2 - count1, e2: r2.e2 });
      processLast();
    } else {
      const shift = shiftOf(r1.e1 === r2.s1, forward, backward, r1, r2);
      if (shift !== 0)
        ranges.splice(
          -2,
          2,
          { s1: r1.s1, e1: r1.e1 + shift, s2: r1.s2, e2: r1.e2 + shift },
          { s1: r2.s1 + shift, e1: r2.e1, s2: r2.s2 + shift, e2: r2.e2 },
        );
    }
  };

  for (const u of unchanged) {
    ranges.push(u);
    processLast();
  }
  return ranges;
}
