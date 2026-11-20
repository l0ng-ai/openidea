/**
 * Editor change markers (IDEA's "line status tracker"): coloured bars right of
 * the line numbers for added / modified lines and a notch for deletions,
 * computed by the backend against the unsaved buffer. Clicking a marker opens
 * the inline hunk popup (`HunkPopup.tsx`).
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { foldState, foldedRanges } from "@codemirror/language";
import type { HunkKind, LineHunk } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import {
  LaneMarker,
  gutterLaneMarkers,
  lineChanges,
  scrollbarMarks,
  type EditorDocContext,
  type ScrollbarMark,
} from "@/editor/api";
import { lineStarts } from "./hunks";
import { useVcs } from "./store";

/** A hunk with its current extent as document offsets (mapped through edits). */
export interface EditorHunk extends LineHunk {
  from: number;
  to: number;
}

export const setHunksEffect = StateEffect.define<LineHunk[]>();

interface HunkState {
  hunks: EditorHunk[];
  markers: RangeSet<GutterMarker>;
}

function toEditorHunks(hunks: readonly LineHunk[], doc: Text): EditorHunk[] {
  const text = doc.toString();
  const starts = lineStarts(text);
  const at = (line: number) => starts[Math.min(line, starts.length - 1)]!;
  return hunks.map((h) => ({ ...h, from: at(h.start), to: h.lines === 0 ? at(h.start) : at(h.start + h.lines) }));
}

const COLOR: Record<HunkKind, string> = {
  added: "var(--gutter-added)",
  modified: "var(--gutter-modified)",
  deleted: "var(--gutter-deleted)",
};

const TITLE: Record<HunkKind, string> = {
  added: "Added lines (click to show)",
  modified: "Modified lines (click to show)",
  deleted: "Deleted lines (click to show)",
};

const MARK = {
  added: new LaneMarker(COLOR.added, "bar", TITLE.added),
  modified: new LaneMarker(COLOR.modified, "bar", TITLE.modified),
  deleted: new LaneMarker(COLOR.deleted, "deleted", TITLE.deleted),
};

function buildMarkers(hunks: readonly EditorHunk[], doc: Text): RangeSet<GutterMarker> {
  const ranges = [];
  for (const h of hunks) {
    if (h.kind === "deleted" || h.to <= h.from) {
      const pos = Math.min(h.from, doc.length);
      const line = doc.lineAt(pos);
      ranges.push(MARK.deleted.range(line.from));
      continue;
    }
    const first = doc.lineAt(h.from).number;
    const last = doc.lineAt(Math.max(h.from, h.to - 1)).number;
    const mark = h.kind === "added" ? MARK.added : MARK.modified;
    for (let n = first; n <= last; n++) ranges.push(mark.range(doc.line(n).from));
  }
  return RangeSet.of(ranges, true);
}

export const hunkField = StateField.define<HunkState>({
  create: () => ({ hunks: [], markers: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHunksEffect)) {
        const hunks = toEditorHunks(e.value, tr.state.doc);
        return { hunks, markers: buildMarkers(hunks, tr.state.doc) };
      }
    }
    if (!tr.docChanged || !value.hunks.length) return value;
    const hunks = value.hunks.map((h) => {
      const from = tr.changes.mapPos(h.from, -1);
      const to = Math.max(from, tr.changes.mapPos(h.to, h.to === h.from ? -1 : 1));
      return { ...h, from, to };
    });
    return { hunks, markers: buildMarkers(hunks, tr.state.doc) };
  },
  provide: (f) => lineChanges.from(f, (v) => v.hunks),
});

export function editorHunks(state: EditorState): EditorHunk[] {
  return state.field(hunkField, false)?.hunks ?? [];
}

/** The hunk shown on the line starting at `lineFrom` (a folded line shows the hunks it hides). */
export function hunkAtPos(state: EditorState, lineFrom: number): EditorHunk | undefined {
  const doc = state.doc;
  const line = doc.lineAt(lineFrom);
  const hunks = editorHunks(state);
  const direct = hunks.find((h) => {
    if (h.kind === "deleted" || h.to <= h.from) return doc.lineAt(Math.min(h.from, doc.length)).from === line.from;
    return h.from <= line.from && line.from < h.to;
  });
  if (direct) return direct;
  let end = line.to;
  foldedRanges(state).between(line.from, line.to, (_from, to) => {
    end = Math.max(end, to);
  });
  return end > line.to ? hunks.find((h) => h.from > line.to && h.from <= end) : undefined;
}

/**
 * Markers of lines hidden in a fold move to the folded line, as in IDEA (CM
 * gutters only draw markers that start a visible line block).
 */
function visibleMarkers(state: EditorState): RangeSet<GutterMarker> {
  const markers = state.field(hunkField).markers;
  const folds = foldedRanges(state);
  if (!folds.size || !markers.size) return markers;
  const doc = state.doc;
  const moved: Array<{ from: number; value: GutterMarker }> = [];
  const seen = new Set<number>();
  markers.between(0, doc.length, (from, _to, value) => {
    let at = from;
    folds.between(from, from, (fFrom, fTo) => {
      if (fFrom < from && from <= fTo) at = doc.lineAt(fFrom).from;
    });
    if (seen.has(at)) return;
    seen.add(at);
    moved.push({ from: at, value });
  });
  moved.sort((a, b) => a.from - b.from);
  return RangeSet.of(
    moved.map((m) => m.value.range(m.from)),
    true,
  );
}

// ---------------------------------------------------------------------------

/** Popup opener, injected by `HunkPopup.tsx` (avoids a React import here). */
export interface HunkPopupHooks {
  open(view: EditorView, hunk: EditorHunk, path: string): void;
  /** The document of `view` changed (an open popup for it is stale). */
  docChanged(view: EditorView): void;
}
let popupHooks: HunkPopupHooks | null = null;
export function setHunkPopupHooks(hooks: HunkPopupHooks | null) {
  popupHooks = hooks;
}

export function showHunkPopup(view: EditorView, hunk: EditorHunk, path: string) {
  popupHooks?.open(view, hunk, path);
}

class HunkFetcher implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private dirtySince = 0;
  private destroyed = false;
  private readonly unsub: () => void;

  constructor(
    private readonly view: EditorView,
    private readonly path: string,
  ) {
    this.schedule(30);
    this.unsub = useVcs.subscribe((s, prev) => {
      if (s.version !== prev.version || s.available !== prev.available) this.schedule(60);
    });
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      popupHooks?.docChanged(this.view);
      this.dirtySince = ++this.seq;
      this.schedule(300);
    }
  }

  schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fetch(), delay);
  }

  async fetch() {
    if (this.destroyed) return;
    if (!useVcs.getState().available || !isTauri()) {
      if (editorHunks(this.view.state).length) this.view.dispatch({ effects: setHunksEffect.of([]) });
      return;
    }
    const ticket = ++this.seq;
    try {
      const hunks = await call(commands.vcsLineHunks(this.path));
      if (this.destroyed) return;
      // The buffer changed while the request was in flight; a fresh request is scheduled.
      if (this.dirtySince > ticket) return;
      this.view.dispatch({ effects: setHunksEffect.of(hunks) });
    } catch {
      // Paths outside the repository etc.: no markers.
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.unsub();
  }
}

function scrollMarks(state: EditorState): ScrollbarMark[] {
  return editorHunks(state).map((h) => ({
    from: h.from,
    to: h.to > h.from ? h.to - 1 : h.from,
    color: COLOR[h.kind],
    tooltip: TITLE[h.kind].replace(" (click to show)", ""),
  }));
}

const laneTheme = EditorView.baseTheme({
  ".cm-openidea-lane .cm-gutterElement:has(.cm-openidea-laneBar, .cm-openidea-laneDeleted)": { cursor: "pointer" },
});

/**
 * Clicks on (or right next to) the change lane open the hunk popup. The lane
 * lives outside `contentDOM`, where `EditorView.domEventHandlers` never see
 * events, so the listener sits on `scrollDOM` (capture, ahead of gutter handlers).
 */
export function laneMouseDown(view: EditorView, event: MouseEvent, path: string): boolean {
  if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  const deletedMarker = event.target instanceof Element ? event.target.closest(".cm-openidea-laneDeleted") : null;
  const lane = view.dom.querySelector(".cm-openidea-lane");
  if (!lane) return false;
  if (!deletedMarker) {
    const rect = lane.getBoundingClientRect();
    if (event.clientX < rect.left - 1 || event.clientX > rect.right + 3) return false;
    if (event.clientY < rect.top || event.clientY > rect.bottom) return false;
  }
  const markerRect = deletedMarker?.getBoundingClientRect();
  const y = markerRect ? markerRect.top + markerRect.height / 2 + 1 : event.clientY;
  const block = view.lineBlockAtHeight(y - view.documentTop);
  const hunk = hunkAtPos(view.state, block.from);
  if (!hunk || (deletedMarker && hunk.kind !== "deleted")) return false;
  event.preventDefault();
  event.stopPropagation();
  showHunkPopup(view, hunk, path);
  return true;
}

function laneClicks(path: string): Extension {
  return ViewPlugin.define((view) => {
    const onDown = (e: MouseEvent) => void laneMouseDown(view, e, path);
    view.scrollDOM.addEventListener("mousedown", onDown, true);
    return { destroy: () => view.scrollDOM.removeEventListener("mousedown", onDown, true) };
  });
}

/** Extensions for one text editor (registered via `registerEditorContribution`). */
export function changeMarkers(ctx: EditorDocContext): Extension {
  // Library classes are not in the working tree.
  if (ctx.virtual) return [];
  const path = ctx.path;
  return [
    hunkField,
    gutterLaneMarkers.compute([hunkField, foldState], visibleMarkers),
    scrollbarMarks.compute([hunkField], scrollMarks),
    laneClicks(path),
    laneTheme,
    ViewPlugin.define((view) => new HunkFetcher(view, path)),
  ];
}

/** Moves the caret to the next / previous change in `view`. Returns whether it moved. */
export function gotoChange(
  view: EditorView,
  dir: 1 | -1,
  from = view.state.selection.main.head,
): EditorHunk | undefined {
  const hunks = editorHunks(view.state);
  if (!hunks.length) return undefined;
  const lineFrom = view.state.doc.lineAt(from).from;
  const sorted = [...hunks].sort((a, b) => a.from - b.from);
  let target: EditorHunk | undefined;
  if (dir === 1) target = sorted.find((h) => h.from > lineFrom && view.state.doc.lineAt(h.from).from > lineFrom);
  else
    target = [...sorted]
      .reverse()
      .find(
        (h) =>
          view.state.doc.lineAt(Math.min(h.from, view.state.doc.length)).from < lineFrom &&
          !(h.from <= from && from < h.to),
      );
  target ??= dir === 1 ? sorted[0] : sorted[sorted.length - 1];
  if (!target) return undefined;
  const pos = Math.min(target.from, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
  return target;
}

/** Hunks touched by the selection (a deletion counts on the line its marker is on). */
export function hunksInSelection(state: EditorState): EditorHunk[] {
  const doc = state.doc;
  return editorHunks(state).filter((h) =>
    state.selection.ranges.some((r) => {
      const first = doc.lineAt(r.from).from;
      const last = doc.lineAt(r.to).to;
      if (h.kind === "deleted" || h.to <= h.from) {
        const marker = doc.lineAt(Math.min(h.from, doc.length)).from;
        return first <= marker && marker <= last;
      }
      return h.from <= last && first < h.to;
    }),
  );
}

/** IDEA's Rollback Lines: restores the hunks touched by the selection; false when there are none. */
export function rollbackSelectedLines(view: EditorView): boolean {
  const hunks = hunksInSelection(view.state);
  if (!hunks.length) return false;
  view.dispatch({
    changes: hunks.map((h) => ({ from: h.from, to: h.to, insert: h.oldText })),
    userEvent: "input.rollback",
    scrollIntoView: true,
  });
  return true;
}
