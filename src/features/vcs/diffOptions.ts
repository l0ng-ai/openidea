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
  syncScroll: boolean;
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
      if (c === null) return diff(a, b, { scanLimit: 500 });
      ea.push(c);
    }
    for (const l of lb) {
      const c = enc(l.key);
      if (c === null) return diff(a, b, { scanLimit: 500 });
      eb.push(c);
    }
    const out: Change[] = [];
    const at = (lines: Line[], i: number) => (i > 0 ? lines[i - 1]!.to : 0);
    for (const c of diff(ea.join(""), eb.join(""), { scanLimit: 500 })) {
      const fromA = c.toA > c.fromA ? la[c.fromA]!.from : at(la, c.fromA);
      const toA = c.toA > c.fromA ? la[c.toA - 1]!.to : fromA;
      const fromB = c.toB > c.fromB ? lb[c.fromB]!.from : at(lb, c.fromB);
      const toB = c.toB > c.fromB ? lb[c.toB - 1]!.to : fromB;
      if (fromA === toA || fromB === toB) {
        out.push(new Change(fromA, toA, fromB, toB));
        continue;
      }
      for (const inner of diff(a.slice(fromA, toA), b.slice(fromB, toB), { scanLimit: 500 }))
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
