/**
 * Diff viewer settings (IDEA's diff toolbar): viewer kind, whitespace policy,
 * highlighting, collapsed unchanged fragments and synchronized scrolling, plus
 * the whitespace-ignoring diff algorithm and per-chunk transfer helpers.
 */
import { Change, diff, type Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";

export type DiffMode = "split" | "unified";
export type IgnorePolicy = "none" | "trim" | "whitespace" | "whitespaceAndLines";
export type HighlightPolicy = "words" | "lines" | "none";

export interface DiffViewOptions {
  mode: DiffMode;
  ignore: IgnorePolicy;
  highlight: HighlightPolicy;
  collapse: boolean;
  /** Side-by-side panes scroll together. */
  syncScroll: boolean;
  /**
   * Side-by-side panes are padded so that unchanged lines line up. Off, each pane
   * keeps its own height and a curved divider joins the changes (IDEA's default).
   */
  alignChanges: boolean;
}

export const IGNORE_OPTIONS: ReadonlyArray<{ value: IgnorePolicy; label: string }> = [
  { value: "none", label: "Do not ignore" },
  { value: "trim", label: "Trim whitespaces" },
  { value: "whitespace", label: "Ignore whitespaces" },
  { value: "whitespaceAndLines", label: "Ignore whitespaces and empty lines" },
];

export const HIGHLIGHT_OPTIONS: ReadonlyArray<{ value: HighlightPolicy; label: string }> = [
  { value: "words", label: "Highlight words" },
  { value: "lines", label: "Highlight lines" },
  { value: "none", label: "Do not highlight" },
];

export const DEFAULT_DIFF_OPTIONS: DiffViewOptions = {
  mode: "split",
  ignore: "none",
  highlight: "words",
  collapse: true,
  syncScroll: true,
  alignChanges: false,
};

const KEY = "openidea.vcs.diffOptions";

const oneOf = <T extends string>(v: unknown, values: readonly { value: T }[], fallback: T): T =>
  values.some((o) => o.value === v) ? (v as T) : fallback;

/** Parses stored options, falling back to defaults per field. */
export function parseDiffOptions(raw: unknown): DiffViewOptions {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_DIFF_OPTIONS;
  return {
    mode: o.mode === "unified" ? "unified" : "split",
    ignore: oneOf(o.ignore, IGNORE_OPTIONS, d.ignore),
    highlight: oneOf(o.highlight, HIGHLIGHT_OPTIONS, d.highlight),
    collapse: typeof o.collapse === "boolean" ? o.collapse : d.collapse,
    syncScroll: typeof o.syncScroll === "boolean" ? o.syncScroll : d.syncScroll,
    alignChanges: typeof o.alignChanges === "boolean" ? o.alignChanges : d.alignChanges,
  };
}

export function loadDiffOptions(): DiffViewOptions {
  try {
    const raw = localStorage.getItem(KEY);
    return parseDiffOptions(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_DIFF_OPTIONS;
  }
}

export function saveDiffOptions(o: DiffViewOptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // ignore
  }
}

interface Line {
  /** Start offset. */
  from: number;
  /** End offset including the line break. */
  to: number;
  key: string;
}

function lineKey(text: string, policy: IgnorePolicy): string {
  if (policy === "trim") return text.trim();
  if (policy === "none") return text;
  return text.replace(/\s+/g, "");
}

function splitLines(s: string, policy: IgnorePolicy): Line[] {
  const out: Line[] = [];
  let from = 0;
  for (;;) {
    const nl = s.indexOf("\n", from);
    const end = nl < 0 ? s.length : nl;
    const key = lineKey(s.slice(from, end), policy) + (policy === "none" && nl >= 0 ? "\n" : "");
    if (!(policy === "whitespaceAndLines" && key === "")) out.push({ from, to: nl < 0 ? s.length : nl + 1, key });
    if (nl < 0) return out;
    from = nl + 1;
  }
}

/** First char code used to encode lines (skips control chars), and the surrogate gap. */
const BASE = 0x21;

function encoder() {
  const codes = new Map<string, string>();
  let next = BASE;
  return (key: string): string | null => {
    let c = codes.get(key);
    if (c === undefined) {
      if (next === 0xd800) next = 0xe000;
      if (next > 0xffff) return null;
      c = String.fromCharCode(next++);
      codes.set(key, c);
    }
    return c;
  };
}

/** Bounds the expensive diff search; larger inputs fall back to a cheaper, coarser match. */
const DIFF_CONFIG = { scanLimit: 500 };

/**
 * Diff of encoded lines (one char per line). Lines that occur exactly once on
 * each side anchor the match (patience diff), and only the gaps between the
 * anchors get a regular diff, so distant edits in long files stay separate
 * without a quadratic search.
 */
function diffLines(a: string, b: string): Change[] {
  const seen = new Map<string, { inA: number; inB: number; at: number }>();
  for (let i = 0; i < a.length; i++) {
    const e = seen.get(a[i]!);
    if (e) e.inA++;
    else seen.set(a[i]!, { inA: 1, inB: 0, at: i });
  }
  for (const c of b) {
    const e = seen.get(c);
    if (e) e.inB++;
  }
  // Unique common lines as [indexA, indexB] in A order, then their longest increasing run in B.
  const pairs: [number, number][] = [];
  for (let j = 0; j < b.length; j++) {
    const e = seen.get(b[j]!);
    if (e && e.inA === 1 && e.inB === 1) pairs.push([e.at, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < pairs[i]![1]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const anchors: [number, number][] = [];
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) anchors.push(pairs[i]!);
  anchors.reverse().push([a.length, b.length]);
  const out: Change[] = [];
  let fromA = 0;
  let fromB = 0;
  for (const [toA, toB] of anchors) {
    if (toA > fromA || toB > fromB)
      for (const c of diff(a.slice(fromA, toA), b.slice(fromB, toB), DIFF_CONFIG))
        out.push(new Change(c.fromA + fromA, c.toA + fromA, c.fromB + fromB, c.toB + fromB));
    fromA = toA + 1;
    fromB = toB + 1;
  }
  return out;
}

/**
 * Match lines first, then compare the contents of changed blocks for word
 * highlighting. The line keys also implement the whitespace policy.
 */
export function whitespaceDiff(policy: IgnorePolicy): (a: string, b: string) => readonly Change[] {
  return (a, b) => {
    const la = splitLines(a, policy);
    const lb = splitLines(b, policy);
    const enc = encoder();
    const ea: string[] = [];
    const eb: string[] = [];
    for (const l of la) {
      const c = enc(l.key);
      if (c === null) return diff(a, b, DIFF_CONFIG);
      ea.push(c);
    }
    for (const l of lb) {
      const c = enc(l.key);
      if (c === null) return diff(a, b, DIFF_CONFIG);
      eb.push(c);
    }
    const out: Change[] = [];
    const at = (lines: Line[], i: number) => (i > 0 ? lines[i - 1]!.to : 0);
    for (const c of diffLines(ea.join(""), eb.join(""))) {
      const fromA = c.toA > c.fromA ? la[c.fromA]!.from : at(la, c.fromA);
      const toA = c.toA > c.fromA ? la[c.toA - 1]!.to : fromA;
      const fromB = c.toB > c.fromB ? lb[c.fromB]!.from : at(lb, c.fromB);
      const toB = c.toB > c.fromB ? lb[c.toB - 1]!.to : fromB;
      if (fromA === toA || fromB === toB) {
        out.push(new Change(fromA, toA, fromB, toB));
        continue;
      }
      for (const inner of diff(a.slice(fromA, toA), b.slice(fromB, toB), DIFF_CONFIG))
        out.push(new Change(inner.fromA + fromA, inner.toA + fromA, inner.fromB + fromB, inner.toB + fromB));
    }
    return out;
  };
}

/**
 * The change that copies a chunk's content from one side to the other
 * (IDEA's ">>" / "<<" and Revert), in the destination's coordinates.
 */
export function transferChunk(chunk: Chunk, source: "a" | "b", src: Text, dst: Text) {
  const [srcFrom, srcTo, dstFrom, dstTo] =
    source === "a"
      ? [chunk.fromA, chunk.toA, chunk.fromB, chunk.toB]
      : [chunk.fromB, chunk.toB, chunk.fromA, chunk.toA];
  let insert = src.sliceString(srcFrom, Math.max(srcFrom, srcTo - 1));
  if (srcFrom !== srcTo && dstTo <= dst.length) insert += "\n";
  return { from: dstFrom, to: Math.min(dst.length, dstTo), insert };
}
