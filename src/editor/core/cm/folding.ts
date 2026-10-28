/**
 * Folding: ranges from the backend (`doc_folding`, tree-sitter based) merged
 * with CodeMirror's syntax folding (`foldNodeProp`) as fallback, IDEA-style
 * chevrons in the gutter (open chevrons only on gutter hover).
 */
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Line,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  codeFolding,
  foldEffect,
  foldGutter,
  foldService,
  foldable,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
import type { FoldRange } from "@/platform/ipc";
import { enclosingCodeBlock } from "./caretCommands";
import { regionMarker, regionNameAt } from "./regions";

export interface BackendFold {
  /** Offset where the fold starts (end of the header line). */
  from: number;
  to: number;
  /** 0-based header line at the time the folds were computed (for sticky scroll). */
  kind: FoldRange["kind"];
  /** A custom region (`//region` … `//endregion`): folds from its start marker, which the placeholder names. */
  custom?: boolean;
}

export const setBackendFolds = StateEffect.define<FoldRange[]>();

/**
 * A block whose `{` sits alone on its line (Allman style: C#, some Java / C)
 * folds from the declaration line above it, so the fold and the sticky line
 * show `namespace Demo` / `void F()` rather than a bare brace.
 */
function allmanHeader(state: EditorState, line: Line): Line {
  if (line.text.trim() !== "{" || line.number === 1) return line;
  const prev = state.doc.line(line.number - 1);
  const code = prev.text.trim();
  return code && !/[;{},]$/.test(code) && !/^(\/\/|#|\*|\/\*|--)/.test(code) ? prev : line;
}

/** Converts backend line ranges to offsets in `state`. */
export function foldsFromRanges(state: EditorState, ranges: readonly FoldRange[]): BackendFold[] {
  const out: BackendFold[] = [];
  const lines = state.doc.lines;
  for (const r of ranges) {
    if (r.start_line + 1 > lines || r.end_line + 1 > lines || r.end_line <= r.start_line) continue;
    const first = state.doc.line(r.start_line + 1);
    const end = state.doc.line(r.end_line + 1);
    if (regionMarker(first.text)?.start) {
      const from = first.from + /^\s*/.exec(first.text)![0].length;
      if (end.to > from) out.push({ from, to: end.to, kind: r.kind, custom: true });
      continue;
    }
    const start = allmanHeader(state, first);
    const trimmed = end.text.trimStart();
    // `}` / `)` / `]` on the last line stays visible after the placeholder, like IDEA.
    const to = /^[}\])]/.test(trimmed) ? end.from + (end.text.length - trimmed.length) : end.to;
    if (to > start.to) out.push({ from: start.to, to, kind: r.kind });
  }
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

export const backendFolds = StateField.define<BackendFold[]>({
  create: () => [],
  update(folds, tr) {
    for (const e of tr.effects) if (e.is(setBackendFolds)) return foldsFromRanges(tr.state, e.value);
    if (!tr.docChanged || !folds.length) return folds;
    const out: BackendFold[] = [];
    for (const f of folds) {
      const from = tr.changes.mapPos(f.from, -1);
      const to = tr.changes.mapPos(f.to, 1);
      if (to > from) out.push({ ...f, from, to });
    }
    return out;
  },
});

/** First backend fold starting within [lineStart, lineEnd]. */
function foldAtLine(folds: readonly BackendFold[], lineStart: number, lineEnd: number): BackendFold | null {
  let lo = 0;
  let hi = folds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (folds[mid]!.from < lineStart) lo = mid + 1;
    else hi = mid;
  }
  let best: BackendFold | null = null;
  for (let i = lo; i < folds.length && folds[i]!.from <= lineEnd; i++) {
    const f = folds[i]!;
    // Only folds whose header ends on this line (custom regions: on this line); keep the widest.
    if ((f.from === lineEnd || f.custom) && (!best || f.to > best.to)) best = f;
  }
  return best;
}

const backendFoldService = foldService.of((state, lineStart, lineEnd) => {
  const folds = state.field(backendFolds, false);
  if (!folds?.length) return null;
  const f = foldAtLine(folds, lineStart, lineEnd);
  if (!f) return null;
  // Don't fold away the caret line's own content.
  return { from: f.from, to: f.to };
});

/** Lines scanned upwards from the caret when looking for the enclosing fold region. */
const MAX_SCAN_LINES = 2000;

/**
 * IDEA "Collapse" (⌘-): the innermost not-yet-folded region that contains the
 * caret — the caret line's own region first, then enclosing ones above it.
 */
export function enclosingFoldRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const folded = foldedRanges(state);
  const isFolded = (r: { from: number; to: number }) => {
    let hit = false;
    folded.between(r.from, r.from, (a, b) => {
      if (a === r.from && b === r.to) hit = true;
    });
    return hit;
  };
  let line = state.doc.lineAt(pos);
  for (let i = 0; i < MAX_SCAN_LINES; i++) {
    const r = foldable(state, line.from, line.to);
    const onCaretLine = i === 0;
    if (r && (onCaretLine || (r.from <= pos && pos <= r.to)) && !isFolded(r)) return r;
    if (line.number === 1) break;
    line = state.doc.line(line.number - 1);
  }
  return null;
}

/** Folds the region around each caret. */
export function foldAtCaret(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  for (const range of view.state.selection.ranges) {
    const r = enclosingFoldRange(view.state, range.head);
    if (r) effects.push(foldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/**
 * IDEA "Expand" (⌘=): the visible fold at the caret — the outermost fold
 * containing it (inner ones are hidden inside it), else a fold on its line.
 */
export function foldToExpand(state: EditorState, head: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(head);
  let containing: { from: number; to: number } | null = null;
  let onLine: { from: number; to: number } | null = null;
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    if (from <= head && head <= to) {
      if (!containing || to - from > containing.to - containing.from) containing = { from, to };
    } else if (from >= line.from && from <= line.to) {
      if (!onLine || to - from > onLine.to - onLine.from) onLine = { from, to };
    }
  });
  return containing ?? onLine;
}

export function unfoldAtCaret(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  for (const range of view.state.selection.ranges) {
    const r = foldToExpand(view.state, range.head);
    if (r) effects.push(unfoldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/**
 * IDEA "Collapse Block" (⇧⌘.): folds the inside of the `{…}` block around the
 * caret, whether or not the language offers a fold there; an already folded
 * block passes on to the one enclosing it.
 */
export function collapseBlockEffects(state: EditorState): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  for (const range of state.selection.ranges) {
    let block = enclosingCodeBlock(state, range.head);
    while (block && isFolded(state, block)) block = enclosingCodeBlock(state, block.from - 1);
    if (block && block.to > block.from) effects.push(foldEffect.of(block));
  }
  return effects;
}

export function collapseBlock(view: EditorView): boolean {
  const effects = collapseBlockEffects(view.state);
  if (!effects.length) return false;
  // A caret inside a fold would unfold it again: it moves to the fold, as in IDEA.
  const folds = effects.map((e) => e.value as { from: number; to: number });
  const sel = view.state.selection;
  const selection = EditorSelection.create(
    sel.ranges.map((r) => {
      const f = folds.find((x) => x.from < r.head && r.head < x.to);
      return f ? EditorSelection.cursor(f.from) : r;
    }),
    sel.mainIndex,
  );
  view.dispatch({ effects, selection });
  return true;
}

/**
 * IDEA "Fold Selection / Remove Region" (⌘.): folds each selection (without
 * a trailing line break); with no selection, toggles the region at the caret.
 */
export function foldSelectionEffects(state: EditorState): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      const to = state.sliceDoc(range.to - 1, range.to) === "\n" ? range.to - 1 : range.to;
      if (to > range.from) effects.push(foldEffect.of({ from: range.from, to }));
      continue;
    }
    const folded = foldToExpand(state, range.head);
    if (folded) effects.push(unfoldEffect.of(folded));
    else {
      const r = enclosingFoldRange(state, range.head);
      if (r) effects.push(foldEffect.of(r));
    }
  }
  return effects;
}

export function foldSelection(view: EditorView): boolean {
  const effects = foldSelectionEffects(view.state);
  if (!effects.length) return false;
  const sel = view.state.selection;
  const folded = effects.filter((e) => e.is(foldEffect)).map((e) => e.value as { from: number; to: number });
  // The caret lands after the new fold, like IDEA.
  const after =
    sel.ranges.some((r) => !r.empty) && folded.length ? { anchor: folded[folded.length - 1]!.to } : undefined;
  view.dispatch({ effects, selection: after });
  return true;
}

function isFolded(state: EditorState, r: { from: number; to: number }): boolean {
  let hit = false;
  foldedRanges(state).between(r.from, r.from, (a, b) => {
    if (a === r.from && b === r.to) hit = true;
  });
  return hit;
}

/** Every foldable region (nested ones included) of the lines in `[from, to]`, kept within `[from, to]`. */
export function foldableRegions(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (let pos = state.doc.lineAt(from).from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    const r = foldable(state, line.from, line.to);
    if (r && r.from >= from && r.to <= to) out.push(r);
    if (line.to >= state.doc.length) break;
    pos = line.to + 1;
  }
  return out;
}

/** The selection, when it holds whole regions to work on; else the whole document. */
function regionScope(state: EditorState): { from: number; to: number } | null {
  const main = state.selection.main;
  return main.empty ? null : { from: main.from, to: main.to };
}

/**
 * IDEA "Collapse All" (⌘⇧-): every region, nested ones included; with a
 * selection, the regions inside it (all of them when it holds none).
 */
export function collapseAllEffects(state: EditorState): StateEffect<unknown>[] {
  const scope = regionScope(state);
  let regions = scope ? foldableRegions(state, scope.from, scope.to) : [];
  if (!regions.length) regions = foldableRegions(state);
  return regions.filter((r) => !isFolded(state, r)).map((r) => foldEffect.of(r));
}

/** IDEA "Expand All" (⌘⇧=): every folded region, or those inside the selection. */
/**
 * IDEA "Expand to Level N" (⌘* N) / "Expand All to Level N" (⌘⇧* N): the
 * regions of the region around the caret (of the file with `all`) nested at most
 * `level` deep are expanded, deeper ones collapsed.
 */
export function expandToLevelEffects(state: EditorState, level: number, all = false): StateEffect<unknown>[] {
  const regions = foldableRegions(state);
  let scope = regions;
  if (!all) {
    const head = state.selection.main.head;
    const around = regions.filter((r) => r.from <= head && head <= r.to);
    const root = around.reduce<(typeof regions)[number] | null>(
      (best, r) => (!best || r.to - r.from < best.to - best.from ? r : best),
      null,
    );
    if (!root) return [];
    scope = regions.filter((r) => r.from >= root.from && r.to <= root.to);
  }
  const effects: StateEffect<unknown>[] = [];
  for (const r of scope) {
    const depth = scope.filter((o) => o !== r && o.from <= r.from && r.to <= o.to).length + 1;
    const folded = isFolded(state, r);
    if (depth <= level && folded) effects.push(unfoldEffect.of(r));
    else if (depth > level && !folded) effects.push(foldEffect.of(r));
  }
  return effects;
}

export function expandAllEffects(state: EditorState): StateEffect<unknown>[] {
  const all: Array<{ from: number; to: number }> = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => void all.push({ from, to }));
  const scope = regionScope(state);
  const inside = scope ? all.filter((r) => r.from >= scope.from && r.to <= scope.to) : [];
  return (inside.length ? inside : all).map((r) => unfoldEffect.of(r));
}

/**
 * IDEA "Collapse Recursively" (⌘⌥-): the region at the caret line (else the
 * innermost one around the caret) and every region inside it.
 */
export function collapseRecursivelyEffects(state: EditorState, head: number): StateEffect<unknown>[] {
  const line = state.doc.lineAt(head);
  const own = foldable(state, line.from, line.to);
  const root = own && !isFolded(state, own) ? own : enclosingFoldRange(state, head);
  if (!root) return [];
  const inner = foldableRegions(state, root.from, root.to).filter((r) => !isFolded(state, r));
  if (!isFolded(state, root) && !inner.some((r) => r.from === root.from && r.to === root.to)) inner.push(root);
  return inner.map((r) => foldEffect.of(r));
}

/** IDEA "Expand Recursively" (⌘⌥=): the region at the caret and every folded region inside it. */
export function expandRecursivelyEffects(state: EditorState, head: number): StateEffect<unknown>[] {
  const line = state.doc.lineAt(head);
  const root = foldToExpand(state, head) ?? foldable(state, line.from, line.to);
  if (!root) return [];
  const out: StateEffect<unknown>[] = [];
  foldedRanges(state).between(root.from, root.to, (from, to) => {
    if (from >= root.from && to <= root.to) out.push(unfoldEffect.of({ from, to }));
  });
  return out;
}

function dispatchEffects(view: EditorView, effects: StateEffect<unknown>[]): boolean {
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

export const collapseAll = (view: EditorView) => dispatchEffects(view, collapseAllEffects(view.state));
export const expandAll = (view: EditorView) => dispatchEffects(view, expandAllEffects(view.state));
export const collapseRecursively = (view: EditorView) =>
  dispatchEffects(
    view,
    view.state.selection.ranges.flatMap((r) => collapseRecursivelyEffects(view.state, r.head)),
  );
export const expandRecursively = (view: EditorView) =>
  dispatchEffects(
    view,
    view.state.selection.ranges.flatMap((r) => expandRecursivelyEffects(view.state, r.head)),
  );

function chevron(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = open ? "cm-openidea-foldOpen" : "cm-openidea-foldClosed";
  span.title = open ? "Collapse" : "Expand";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "9");
  svg.setAttribute("height", "9");
  svg.setAttribute("viewBox", "0 0 9 9");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", open ? "M8 2.75 4.5 6.25 1 2.75" : "M3 8 6.5 4.5 3 1");
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

export function foldingExtension(showOutline = true): Extension {
  return [
    // The chevron column sits right of contributed icon gutters (IDEA new UI).
    showOutline ? Prec.lowest(foldGutter({ markerDOM: chevron })) : [],
    backendFolds,
    backendFoldService,
    codeFolding({
      // A folded custom region shows its name, as in IDEA.
      preparePlaceholder: (state, range) => regionNameAt(state, range.from),
      placeholderDOM: (_view, onclick, name: string | null) => {
        const el = document.createElement("span");
        el.className = "cm-foldPlaceholder";
        el.textContent = name ?? "…";
        el.title = "Expand";
        el.setAttribute("aria-label", "folded code");
        el.onclick = onclick;
        return el;
      },
    }),
  ];
}
