/**
 * Search and selection-occurrence highlights in the Markdown preview.
 *
 * Uses the CSS Custom Highlight API (`::highlight(markdown-find)`,
 * `::highlight(markdown-find-current)`, `::highlight(markdown-selection-match)`)
 * so DOM nodes (syntax-highlighted code blocks, Mermaid diagrams, links, and
 * active user selections) are never mutated or split.
 */
import { MAX_COUNT } from "@/editor/core/cm/find";
import type { LiveMarkdownFind } from "./live";

export const SELECTION_MATCH_HIGHLIGHT = "markdown-selection-match";
export const FIND_HIGHLIGHT = "markdown-find";
export const FIND_CURRENT_HIGHLIGHT = "markdown-find-current";

const MAX_SELECTION_MATCHES = 500;
const MIN_SELECTION_LENGTH = 2;
const MAX_SELECTION_LENGTH = 200;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT"]);
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

interface TextPiece {
  node: Text;
  start: number;
  end: number;
}

interface TextRun {
  text: string;
  pieces: TextPiece[];
}

/** Collects contiguous inline text runs under `root`, separated at block boundaries. */
function collectRuns(root: Node): TextRun[] {
  const runs: TextRun[] = [];
  let pieces: TextPiece[] = [];
  let text = "";
  const flush = () => {
    if (text) runs.push({ text, pieces });
    pieces = [];
    text = "";
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      if (!value) return;
      const start = text.length;
      text += value;
      pieces.push({ node: node as Text, start, end: text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "PRE" && el.parentElement?.getAttribute("data-mermaid-state") === "ok") return;
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    if (isBlock) flush();
  };
  walk(root);
  flush();
  return runs;
}

function rangeInRun(run: TextRun, from: number, to: number): Range | null {
  let startPiece: TextPiece | undefined;
  let endPiece: TextPiece | undefined;
  for (const p of run.pieces) {
    if (!startPiece && from < p.end) startPiece = p;
    if (to <= p.end) {
      endPiece = p;
      break;
    }
  }
  if (!startPiece || !endPiece) return null;
  const range = document.createRange();
  range.setStart(startPiece.node, from - startPiece.start);
  range.setEnd(endPiece.node, to - endPiece.start);
  return range;
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const before = [...text.slice(Math.max(0, start - 2), start)].at(-1) ?? "";
  const after = String.fromCodePoint(text.codePointAt(end) ?? 0);
  const first = String.fromCodePoint(text.codePointAt(start) ?? 0);
  const last = [...text.slice(Math.max(start, end - 2), end)].at(-1) ?? "";
  const leftWord = WORD_CHAR.test(first) && WORD_CHAR.test(before);
  const rightWord = WORD_CHAR.test(last) && WORD_CHAR.test(after);
  return !leftWord && !rightWord;
}

export interface PreviewMatchOptions {
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

/** DOM ranges matching `options` under `root`, in document order. */
export function findMatchesInNode(root: Node, options: PreviewMatchOptions, limit = MAX_COUNT): Range[] {
  return matchesInRuns(collectRuns(root), options, limit);
}

function matchesInRuns(runs: readonly TextRun[], options: PreviewMatchOptions, limit: number): Range[] {
  if (!options.search || limit <= 0) return [];
  const source = options.regexp ? options.search : options.search.replace(REGEX_SPECIALS, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(source, options.caseSensitive ? "gu" : "giu");
  } catch {
    return [];
  }
  const out: Range[] = [];
  for (const run of runs) {
    re.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = re.exec(run.text))) {
      const start = found.index;
      const end = start + found[0].length;
      if (end === start) {
        re.lastIndex = start + ((run.text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
        continue;
      }
      if (options.wholeWord && !isWholeWordMatch(run.text, start, end)) continue;
      const range = rangeInRun(run, start, end);
      if (range) out.push(range);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

interface PreviewBlock {
  startLine: number;
  runs: TextRun[];
}

interface PreviewIndex {
  blocks: PreviewBlock[];
  runs: TextRun[];
  query?: string;
  matches?: Range[][];
}

const previewIndexes = new WeakMap<HTMLElement, PreviewIndex>();

export function invalidatePreviewIndex(root: HTMLElement) {
  previewIndexes.delete(root);
}

function previewIndex(root: HTMLElement): PreviewIndex {
  let index = previewIndexes.get(root);
  if (!index) {
    const els = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")];
    const blocks = els.map((el) => ({ startLine: Number(el.dataset.line), runs: collectRuns(el) }));
    index = { blocks, runs: blocks.length ? blocks.flatMap((b) => b.runs) : collectRuns(root) };
    previewIndexes.set(root, index);
  }
  return index;
}

function lowerBound(lines: readonly number[], line: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid]! < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Reuses the rendered text index across queries and match navigation. */
export function findPreviewMatches(
  root: HTMLElement,
  find: LiveMarkdownFind,
): { ranges: Range[]; current: Range | null } {
  const index = previewIndex(root);
  const key = JSON.stringify([find.search, find.caseSensitive, find.wholeWord, find.regexp]);
  if (index.query !== key) {
    let remaining = MAX_COUNT;
    index.matches = (index.blocks.length ? index.blocks : [{ runs: index.runs }]).map((block) => {
      const ranges = matchesInRuns(block.runs, find, remaining);
      remaining -= ranges.length;
      return ranges;
    });
    index.query = key;
  }
  const matches = index.matches!;
  const ranges = matches.flat();
  if (find.currentMatchIndex < 0 || !ranges.length) return { ranges, current: null };

  const line = find.matchLines[find.currentMatchIndex];
  if (line !== undefined && index.blocks.length) {
    let lo = 0;
    let hi = index.blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.blocks[mid]!.startLine <= line) lo = mid + 1;
      else hi = mid;
    }
    const blockIndex = lo - 1;
    if (blockIndex < 0) return { ranges, current: null };
    const block = index.blocks[blockIndex]!;
    const ordinal = find.currentMatchIndex - lowerBound(find.matchLines, block.startLine);
    return { ranges, current: matches[blockIndex]?.[ordinal] ?? null };
  }
  return { ranges, current: ranges[find.currentMatchIndex] ?? null };
}

function isSameRange(a: Range, b: Range): boolean {
  try {
    return (
      (a.compareBoundaryPoints(Range.START_TO_START, b) <= 0 && a.compareBoundaryPoints(Range.END_TO_END, b) >= 0) ||
      (b.compareBoundaryPoints(Range.START_TO_START, a) <= 0 && b.compareBoundaryPoints(Range.END_TO_END, a) >= 0)
    );
  } catch {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  }
}

/** Single-line non-empty selection inside `root` (2..200 chars), matching CodeMirror's `highlightSelectionMatches`. */
export function previewSelectionOf(root: HTMLElement): { text: string; range: Range } | null {
  if (typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount !== 1) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  if (text.length < MIN_SELECTION_LENGTH || text.length > MAX_SELECTION_LENGTH || text.includes("\n") || !text.trim())
    return null;
  return { text, range: range.cloneRange() };
}

/** Case-sensitive occurrences of `text` in `root`, excluding `excludeRange` (capped at `maxMatches`). */
export function selectionMatchesInNode(
  root: HTMLElement,
  text: string,
  excludeRange: Range | null = null,
  maxMatches = MAX_SELECTION_MATCHES,
): Range[] {
  if (text.length < MIN_SELECTION_LENGTH || text.length > MAX_SELECTION_LENGTH || text.includes("\n") || !text.trim())
    return [];
  const all = matchesInRuns(
    previewIndex(root).runs,
    { search: text, caseSensitive: true, wholeWord: false, regexp: false },
    maxMatches + 2,
  );
  const filtered = excludeRange ? all.filter((r) => !isSameRange(r, excludeRange)) : all;
  return filtered.length > maxMatches ? [] : filtered;
}

/** True when `range` is not hidden inside a collapsed `<details>` element. */
export function isRangeShown(range: Range, root: HTMLElement): boolean {
  for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) {
      const summary = el.querySelector(":scope > summary");
      if (!summary?.contains(range.startContainer)) return false;
    }
  }
  return true;
}

/** Opens any collapsed `<details>` ancestors containing `range`. */
export function openDetailsContaining(range: Range, root: HTMLElement, toggled?: Map<number, boolean>): boolean {
  let opened = false;
  let allDetails: HTMLDetailsElement[] | undefined;
  for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) {
      el.open = true;
      opened = true;
      if (toggled) {
        allDetails ??= [...root.querySelectorAll("details")];
        const idx = allDetails.indexOf(el);
        if (idx >= 0) toggled.set(idx, true);
      }
    }
  }
  return opened;
}

/** Scrolls `range` into view inside `root` when layout rects are available. */
export function revealPreviewRange(range: Range, root: HTMLElement): boolean {
  const r = range.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  if (r.height <= 0 || box.height <= 0) return false;
  if (r.top < box.top + 24 || r.bottom > box.bottom - 24) {
    root.scrollTop += r.top - box.top - box.height / 3;
  }
  return true;
}

interface HighlightSet {
  priority?: number;
  clear(): void;
  add(range: Range): void;
}

const PRIORITIES: Record<string, number> = {
  [SELECTION_MATCH_HIGHLIGHT]: 0,
  [FIND_HIGHLIGHT]: 1,
  [FIND_CURRENT_HIGHLIGHT]: 2,
};

const highlightByRoot = new Map<string, Map<HTMLElement, readonly Range[]>>();

/**
 * Updates `name` for `root` in `CSS.highlights`. One `Highlight` instance per
 * name is mutated in place so WebKit repaints removed ranges reliably.
 */
export function setPreviewHighlight(name: string, root: HTMLElement, ranges: readonly Range[]) {
  const shown = ranges.filter((r) => isRangeShown(r, root));
  let byRoot = highlightByRoot.get(name);
  if (!byRoot) {
    byRoot = new Map();
    highlightByRoot.set(name, byRoot);
  }
  if (shown.length) byRoot.set(root, shown);
  else byRoot.delete(root);

  const registry = (globalThis as { CSS?: { highlights?: Map<string, HighlightSet> } }).CSS?.highlights;
  const HighlightCtor = (globalThis as { Highlight?: new () => HighlightSet }).Highlight;
  if (!registry || !HighlightCtor) return;

  let set = registry.get(name);
  if (!set) {
    set = new HighlightCtor();
    if (PRIORITIES[name] !== undefined) set.priority = PRIORITIES[name];
    registry.set(name, set);
  }
  set.clear();
  for (const list of byRoot.values()) {
    for (const r of list) set.add(r);
  }
}

export function clearPreviewHighlights(root: HTMLElement) {
  setPreviewHighlight(SELECTION_MATCH_HIGHLIGHT, root, []);
  setPreviewHighlight(FIND_HIGHLIGHT, root, []);
  setPreviewHighlight(FIND_CURRENT_HIGHLIGHT, root, []);
}
