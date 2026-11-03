/**
 * Three-way merge behind the merge editor, ported from IntelliJ's merge tool
 * (`MergeRangeUtil.getMergeType`, `SimpleHelper`): the changes between the sides at line
 * level, each classified as one-sided, identical or conflicting, and the word-level merge
 * that resolves a conflict whose sides touched different words.
 */
import { diff } from "@codemirror/merge";
import { changesBetween, optimizeLineChunks, unchangedBetween } from "./chunkOptimizer";

/** A change between the base (A) and a side (B), in tokens. */
interface Delta {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** A half-open token range. */
type Span = readonly [from: number, to: number];

/** What the sides hold in place of one stretch of the base. */
export interface Cluster {
  left: Span;
  base: Span;
  right: Span;
}

// Tokens are interned into BMP characters so the string diff of @codemirror/merge can
// compare them. Control characters and the surrogate range stay unused.
const FIRST_CHAR = 0x100;
const SURROGATES = 0x800;
const MAX_TOKENS = 0x10000 - FIRST_CHAR - SURROGATES;

const charFor = (id: number) => {
  const code = FIRST_CHAR + id;
  return String.fromCharCode(code < 0xd800 ? code : code + SURROGATES);
};

/**
 * The stretches of the base that either side changed. Changes of the two sides that
 * overlap or touch form one cluster, so two edits next to each other conflict, as in
 * IntelliJ. `null` when there are too many distinct tokens to compare.
 */
export function diff3(
  left: readonly string[],
  base: readonly string[],
  right: readonly string[],
  key: (token: string) => string = (token) => token,
  timeout?: number,
  /** The tokens are lines: move the changes to where a reader expects their boundaries. */
  optimizeLines = false,
): Cluster[] | null {
  const ids = new Map<string, string>();
  const encode = (tokens: readonly string[]): string | null => {
    let out = "";
    for (const token of tokens) {
      const k = key(token);
      let c = ids.get(k);
      if (c === undefined) {
        if (ids.size >= MAX_TOKENS) return null;
        c = charFor(ids.size);
        ids.set(k, c);
      }
      out += c;
    }
    return out;
  };
  const b = encode(base);
  const l = encode(left);
  const r = encode(right);
  if (b === null || l === null || r === null) return null;
  const config = timeout === undefined ? undefined : { timeout };
  const weights = (tokens: readonly string[]) => tokens.map((t) => t.replace(/\s/g, "").length);
  const against = (side: string, sideTokens: readonly string[]): readonly Delta[] => {
    const found = diff(b, side, config);
    if (!optimizeLines) return found;
    const moved = optimizeLineChunks(
      b,
      side,
      weights(base),
      weights(sideTokens),
      unchangedBetween(
        found.map((c) => [c.fromA, c.toA, c.fromB, c.toB]),
        b.length,
        side.length,
      ),
    );
    return changesBetween(moved, b.length, side.length).map(([fromA, toA, fromB, toB]) => ({ fromA, toA, fromB, toB }));
  };
  const lc = against(l, left);
  const rc = against(r, right);

  const clusters: Cluster[] = [];
  let i = 0;
  let j = 0;
  // How far each side's tokens are shifted from the base's by the changes before the cluster.
  let shiftL = 0;
  let shiftR = 0;
  while (i < lc.length || j < rc.length) {
    const fromLeft = i < lc.length && (j >= rc.length || lc[i]!.fromA <= rc[j]!.fromA);
    const first = fromLeft ? lc[i]! : rc[j]!;
    const start = first.fromA;
    let end = first.toA;
    let growL = 0;
    let growR = 0;
    if (fromLeft) {
      growL += first.toB - first.fromB - (first.toA - first.fromA);
      i++;
    } else {
      growR += first.toB - first.fromB - (first.toA - first.fromA);
      j++;
    }
    for (let progressed = true; progressed;) {
      progressed = false;
      while (i < lc.length && lc[i]!.fromA <= end) {
        const c = lc[i++]!;
        end = Math.max(end, c.toA);
        growL += c.toB - c.fromB - (c.toA - c.fromA);
        progressed = true;
      }
      while (j < rc.length && rc[j]!.fromA <= end) {
        const c = rc[j++]!;
        end = Math.max(end, c.toA);
        growR += c.toB - c.fromB - (c.toA - c.fromA);
        progressed = true;
      }
    }
    clusters.push({
      base: [start, end],
      left: [start + shiftL, end + shiftL + growL],
      right: [start + shiftR, end + shiftR + growR],
    });
    shiftL += growL;
    shiftR += growR;
  }
  return clusters;
}

/** Which sides changed a stretch, and whether the changes agree. */
export type ChangeKind = "left" | "right" | "both" | "conflict";

/**
 * Classifies a stretch from its texts in each version (`MergeRangeUtil.getMergeType`).
 * `same` compares texts; `null` when neither side changed it.
 */
function classify(
  left: string,
  base: string,
  right: string,
  same: (a: string, b: string) => boolean,
): ChangeKind | null {
  if (base === "") {
    if (left === "") return "right";
    if (right === "") return "left";
    return same(left, right) ? "both" : "conflict";
  }
  if (left === "" && right === "") return "both";
  const unchangedLeft = same(base, left);
  const unchangedRight = same(base, right);
  if (unchangedLeft && unchangedRight) return null;
  if (unchangedLeft) return "right";
  if (unchangedRight) return "left";
  return same(left, right) ? "both" : "conflict";
}

/** Lines of `text`, each with its terminator, so joining them gives `text` back. */
export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];

/** One stretch the sides changed, with the text each version has there. */
export interface TextChange {
  /** Offsets of the stretch in the base. */
  baseFrom: number;
  baseTo: number;
  /** Offsets of the stretch in the left and the right version. */
  leftFrom: number;
  leftTo: number;
  rightFrom: number;
  rightTo: number;
  left: string;
  base: string;
  right: string;
  kind: ChangeKind;
  /** The word-level merge of a conflict, when the sides changed different words. */
  auto: string | null;
}

/** The changes between the versions line by line; `null` when the files are too different to compare. */
export function mergeChanges(left: string, base: string, right: string): TextChange[] | null {
  const lines = [splitLines(left), splitLines(base), splitLines(right)] as const;
  const clusters = diff3(lines[0], lines[1], lines[2], undefined, 3000, true);
  if (!clusters) return null;
  const offsets = (ls: readonly string[]) => {
    const out = [0];
    for (const line of ls) out.push(out[out.length - 1]! + line.length);
    return out;
  };
  const at = [offsets(lines[0]), offsets(lines[1]), offsets(lines[2])] as const;
  const slice = (text: string, side: 0 | 1 | 2, [from, to]: Span) => text.slice(at[side][from], at[side][to]);
  const out: TextChange[] = [];
  for (const c of clusters) {
    const l = slice(left, 0, c.left);
    const b = slice(base, 1, c.base);
    const r = slice(right, 2, c.right);
    const kind = classify(l, b, r, (x, y) => x === y);
    if (!kind) continue;
    out.push({
      baseFrom: at[1][c.base[0]]!,
      baseTo: at[1][c.base[1]]!,
      leftFrom: at[0][c.left[0]]!,
      leftTo: at[0][c.left[1]]!,
      rightFrom: at[2][c.right[0]]!,
      rightTo: at[2][c.right[1]]!,
      left: l,
      base: b,
      right: r,
      kind,
      auto: kind === "conflict" && b !== "" && l !== "" && r !== "" ? tryResolve(l, b, r) : null,
    });
  }
  return out;
}

const WORDS = /[\p{L}\p{N}\p{M}_]+|\r?\n|[^\S\r\n]+|[\s\S]/gu;
const HORIZONTAL_SPACE = /[^\S\r\n]+/g;

/** Words, punctuation, line breaks and runs of blanks of `text`; joined they give `text` back. */
export const splitWords = (text: string): string[] => text.match(WORDS) ?? [];

/**
 * Merges the three versions word by word, when no word was changed by both sides
 * differently (`MergeResolveUtil.tryResolve`). Tried exactly first, then ignoring the
 * width of blanks, which keeps the whitespace of the side that changed it. `null` when
 * the sides really conflict.
 */
export function tryResolve(left: string, base: string, right: string): string | null {
  return mergeWords(left, base, right, false) ?? mergeWords(left, base, right, true);
}

function mergeWords(left: string, base: string, right: string, ignoreBlanks: boolean): string | null {
  const squash = (token: string) => (ignoreBlanks ? token.replace(HORIZONTAL_SPACE, " ") : token);
  const same = (a: string, b: string) => a === b || (ignoreBlanks && squash(a) === squash(b));
  const tokens = [splitWords(left), splitWords(base), splitWords(right)] as const;
  // A conflict can be large; past the timeout the diff is longer than needed, which only
  // makes the merge more careful, never wrong.
  const clusters = diff3(tokens[0], tokens[1], tokens[2], squash, 1000);
  if (!clusters) return null;
  const text = (side: 0 | 1 | 2, from: number, to: number) => tokens[side].slice(from, to).join("");
  let out = "";
  let l = 0;
  let b = 0;
  let r = 0;
  const gap = (lTo: number, bTo: number, rTo: number) => {
    const gl = text(0, l, lTo);
    const gb = text(1, b, bTo);
    const gr = text(2, r, rTo);
    // Equal under the policy; a side that changed only blanks there keeps its version.
    out += gl !== gb ? gl : gr !== gb ? gr : gb;
  };
  for (const c of clusters) {
    gap(c.left[0], c.base[0], c.right[0]);
    const tl = text(0, c.left[0], c.left[1]);
    const tb = text(1, c.base[0], c.base[1]);
    const tr = text(2, c.right[0], c.right[1]);
    const kind = classify(tl, tb, tr, same);
    if (kind === "conflict") return null;
    out += kind === "right" ? tr : tl;
    [l, b, r] = [c.left[1], c.base[1], c.right[1]];
  }
  gap(tokens[0].length, tokens[1].length, tokens[2].length);
  return out;
}
