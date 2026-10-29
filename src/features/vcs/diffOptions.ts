/**
 * Diff viewer settings (IDEA's diff toolbar): viewer kind, whitespace policy,
 * highlighting, collapsed unchanged fragments and synchronized scrolling, plus
 * chunks computed by IDEA's comparison and per-chunk transfer helpers.
 */
import { Change, Chunk, type DiffConfig } from "@codemirror/merge";
import type { ChangeDesc, Text } from "@codemirror/state";
import { compareTexts, type ComparisonPolicy, type LineFragment } from "./comparison";
import { DiffTooBigError } from "./comparison/lcs";

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

const IDEA = Symbol("ideaDiff");

interface IdeaDiff {
  policy: ComparisonPolicy;
  words: boolean;
  trimChunks: boolean;
}

const COMPARISON_POLICY: Record<IgnorePolicy, ComparisonPolicy> = {
  none: "default",
  trim: "trim",
  whitespace: "ignore",
  whitespaceAndLines: "ignore",
};

/**
 * A MergeView `diffConfig` whose chunks come from IDEA's comparison
 * (`./comparison`) instead of `@codemirror/merge`'s own diff: lines matched as
 * IDEA does, word fragments by IDEA's rules, no merging of nearby changes.
 */
export function ideaDiffConfig(ignore: IgnorePolicy, highlight: HighlightPolicy): DiffConfig {
  const idea: IdeaDiff = {
    policy: COMPARISON_POLICY[ignore],
    words: highlight === "words",
    trimChunks: ignore === "whitespaceAndLines",
  };
  const config: DiffConfig = {};
  (config as Record<symbol, IdeaDiff>)[IDEA] = idea;
  return config;
}

/** The line fragment a chunk was built from. */
const fragments = new WeakMap<Chunk, LineFragment>();

/**
 * Whether the chunk has IDEA's inner fragments (its words were compared):
 * such a chunk gets the lighter line background (TextDiffType "ignored"
 * colour) with its `changes` in full colour.
 */
export const hasInnerFragments = (chunk: Chunk) => !!fragments.get(chunk)?.inner;

/** IDEA's line fragments as chunks; `changes` hold the inner fragments, or the whole block. */
export function ideaChunks(a: Text, b: Text, ignore: IgnorePolicy, highlight: HighlightPolicy): readonly Chunk[] {
  return toChunks(a, b, ideaOf(ideaDiffConfig(ignore, highlight))!);
}

function toChunks(a: Text, b: Text, idea: IdeaDiff): readonly Chunk[] {
  let compared: LineFragment[];
  try {
    compared = compareTexts(a.toString(), b.toString(), idea);
  } catch (error) {
    if (!(error instanceof DiffTooBigError)) throw error;
    // Repeated lines can exhaust IDEA's search. Keep the viewer usable with a bounded, coarser diff.
    return build.call(Chunk, a, b, { scanLimit: 500 });
  }
  return compared.map((f) => {
    // `to` is one past the last line's end, past the document for its last line.
    const toA = f.startLine1 === f.endLine1 ? f.startOffset1 : f.endLine1 === a.lines ? a.length + 1 : f.endOffset1;
    const toB = f.startLine2 === f.endLine2 ? f.startOffset2 : f.endLine2 === b.lines ? b.length + 1 : f.endOffset2;
    const changes = f.inner
      ? f.inner.map((r) => new Change(r.start1, r.end1, r.start2, r.end2))
      : [new Change(0, f.endOffset1 - f.startOffset1, 0, f.endOffset2 - f.startOffset2)];
    const chunk = new Chunk(changes, f.startOffset1, toA, f.startOffset2, toB);
    fragments.set(chunk, f);
    return chunk;
  });
}

// Every chunk computation of MergeView and unifiedMergeView goes through these.
const ideaOf = (conf?: DiffConfig) => (conf as Record<symbol, IdeaDiff | undefined> | undefined)?.[IDEA];
const { build, updateA, updateB } = Chunk;
Chunk.build = (a: Text, b: Text, conf?: DiffConfig) => {
  const idea = ideaOf(conf);
  return idea ? toChunks(a, b, idea) : build.call(Chunk, a, b, conf);
};
Chunk.updateA = (chunks: readonly Chunk[], a: Text, b: Text, changes: ChangeDesc, conf?: DiffConfig) => {
  const idea = ideaOf(conf);
  return idea ? toChunks(a, b, idea) : updateA.call(Chunk, chunks, a, b, changes, conf);
};
Chunk.updateB = (chunks: readonly Chunk[], a: Text, b: Text, changes: ChangeDesc, conf?: DiffConfig) => {
  const idea = ideaOf(conf);
  return idea ? toChunks(a, b, idea) : updateB.call(Chunk, chunks, a, b, changes, conf);
};

/** Text of lines `[from, to)` (0-based), without the last line break. */
const linesContent = (doc: Text, from: number, to: number) => doc.sliceString(doc.line(from + 1).from, doc.line(to).to);

/**
 * The change that copies a chunk's content from one side to the other
 * (IDEA's ">>" / "<<" and Revert), in the destination's coordinates. Lines are
 * replaced as DiffUtil.applyModification does, so a missing final line break
 * stays missing.
 */
export function transferChunk(chunk: Chunk, source: "a" | "b", src: Text, dst: Text) {
  const f = fragments.get(chunk);
  if (!f) return transferByOffsets(chunk, source, src, dst);
  const [srcFrom, srcTo, dstFrom, dstTo] =
    source === "a"
      ? [f.startLine1, f.endLine1, f.startLine2, f.endLine2]
      : [f.startLine2, f.endLine2, f.startLine1, f.endLine1];
  if (dstFrom === dstTo) {
    const text = linesContent(src, srcFrom, srcTo);
    return dstFrom === dst.lines
      ? { from: dst.length, to: dst.length, insert: "\n" + text }
      : { from: dst.line(dstFrom + 1).from, to: dst.line(dstFrom + 1).from, insert: text + "\n" };
  }
  let from = dst.line(dstFrom + 1).from;
  let to = dst.line(dstTo).to;
  if (srcFrom === srcTo) {
    // Lines removed with a line break: the one before them, or else the one after.
    if (from > 0) from--;
    else if (to < dst.length) to++;
    return { from, to, insert: "" };
  }
  return { from, to, insert: linesContent(src, srcFrom, srcTo) };
}

/** `transferChunk` for chunks not built from line fragments. */
function transferByOffsets(chunk: Chunk, source: "a" | "b", src: Text, dst: Text) {
  const [srcFrom, srcTo, dstFrom, dstTo] =
    source === "a"
      ? [chunk.fromA, chunk.toA, chunk.fromB, chunk.toB]
      : [chunk.fromB, chunk.toB, chunk.fromA, chunk.toA];
  let insert = src.sliceString(srcFrom, Math.max(srcFrom, srcTo - 1));
  if (srcFrom !== srcTo && dstTo <= dst.length) insert += "\n";
  return { from: dstFrom, to: Math.min(dst.length, dstTo), insert };
}
