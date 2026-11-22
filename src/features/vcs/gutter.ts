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
  whenSynced,
  type EditorDocContext,
  type ScrollbarMark,
} from "@/editor/api";
import { renamedFromPath } from "./changes";
import { currentHunkText, lineStarts, rollbackEdit } from "./hunks";
import { onStagingAreaChange, stagingAreaOn } from "./staging";
import { statusOf, useVcs } from "./store";
import { tx } from "@/platform/i18n";
import { runOp } from "./ops";

interface TrackedHunk extends LineHunk {
  staging?: {
    indexVersion: string;
    indexStart: number;
    indexLines: number;
    indexText: string;
    staged: boolean;
    unstaged: boolean;
  };
}

/** A hunk with its current extent as document offsets (mapped through edits). */
export interface EditorHunk extends TrackedHunk {
  from: number;
  to: number;
}

export const setHunksEffect = StateEffect.define<TrackedHunk[]>();

interface HunkState {
  hunks: EditorHunk[];
  markers: RangeSet<GutterMarker>;
  fresh: boolean;
}

function toEditorHunks(hunks: readonly TrackedHunk[], doc: Text): EditorHunk[] {
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

export function stagingTitle(hunk: NonNullable<TrackedHunk["staging"]>): string {
  return hunk.staged && hunk.unstaged
    ? tx("Staged and unstaged changes")
    : hunk.staged
      ? tx("Staged changes")
      : tx("Unstaged changes");
}

class StagingLaneMarker extends LaneMarker {
  constructor(hunk: EditorHunk, deleted: boolean) {
    super(COLOR[deleted ? "deleted" : hunk.kind], deleted ? "deleted" : "bar", stagingTitle(hunk.staging!));
    this.staging = hunk.staging!.staged ? (hunk.staging!.unstaged ? "both" : "staged") : "unstaged";
  }

  private readonly staging: "both" | "staged" | "unstaged";

  override eq(other: GutterMarker) {
    return other instanceof StagingLaneMarker && other.staging === this.staging && super.eq(other);
  }

  override toDOM() {
    const marker = super.toDOM() as HTMLElement;
    marker.dataset.gitStaging = this.staging;
    return marker;
  }
}

function buildMarkers(hunks: readonly EditorHunk[], doc: Text): RangeSet<GutterMarker> {
  const ranges = [];
  for (const h of hunks) {
    if (h.kind === "deleted" || h.to <= h.from) {
      const pos = Math.min(h.from, doc.length);
      const line = doc.lineAt(pos);
      ranges.push((h.staging ? new StagingLaneMarker(h, true) : MARK.deleted).range(line.from));
      continue;
    }
    const first = doc.lineAt(h.from).number;
    const last = doc.lineAt(Math.max(h.from, h.to - 1)).number;
    const mark = h.staging ? new StagingLaneMarker(h, false) : h.kind === "added" ? MARK.added : MARK.modified;
    for (let n = first; n <= last; n++) ranges.push(mark.range(doc.line(n).from));
  }
  return RangeSet.of(ranges, true);
}

export const hunkField = StateField.define<HunkState>({
  create: () => ({ hunks: [], markers: RangeSet.empty, fresh: false }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHunksEffect)) {
        const hunks = toEditorHunks(e.value, tr.state.doc);
        return { hunks, markers: buildMarkers(hunks, tr.state.doc), fresh: true };
      }
    }
    if (!tr.docChanged || !value.hunks.length) return value;
    const hunks = value.hunks.map((h) => {
      const from = tr.changes.mapPos(h.from, -1);
      const to = Math.max(from, tr.changes.mapPos(h.to, h.to === h.from ? -1 : 1));
      return { ...h, from, to };
    });
    return { hunks, markers: buildMarkers(hunks, tr.state.doc), fresh: false };
  },
  provide: (f) => lineChanges.from(f, (v) => v.hunks),
});

export function editorHunks(state: EditorState): EditorHunk[] {
  return state.field(hunkField, false)?.hunks ?? [];
}

export function editableHunk(view: EditorView, hunk: EditorHunk): boolean {
  const state = view.state.field(hunkField, false);
  return !!state?.hunks.includes(hunk) && (!hunk.staging || (state.fresh && stagingAreaOn()));
}

async function stagingHunks(path: string): Promise<TrackedHunk[]> {
  const file = statusOf(path);
  const headPath = file?.staged === "renamed" ? renamedFromPath(file) : null;
  const result = await call(commands.vcsStagingLineHunks(path, headPath));
  return (
    result?.hunks.map((h) => ({
      kind: h.kind,
      start: h.start,
      lines: h.lines,
      oldStart: h.headStart,
      oldLines: h.headLines,
      oldText: h.headText,
      staging: {
        indexVersion: result.indexVersion,
        indexStart: h.indexStart,
        indexLines: h.indexLines,
        indexText: h.indexText,
        staged: h.staged,
        unstaged: h.unstaged,
      },
    })) ?? []
  );
}

function sameRange(a: TrackedHunk, b: TrackedHunk): boolean {
  const old = a.staging;
  const fresh = b.staging;
  return (
    !!old &&
    !!fresh &&
    a.start === b.start &&
    a.lines === b.lines &&
    a.oldStart === b.oldStart &&
    a.oldLines === b.oldLines &&
    a.oldText === b.oldText &&
    old.indexVersion === fresh.indexVersion &&
    old.indexStart === fresh.indexStart &&
    old.indexLines === fresh.indexLines &&
    old.indexText === fresh.indexText &&
    old.staged === fresh.staged &&
    old.unstaged === fresh.unstaged
  );
}

export function equivalentStagingHunk(view: EditorView, hunk: EditorHunk): EditorHunk | undefined {
  return editorHunks(view.state).find((candidate) => sameRange(hunk, candidate));
}

export interface GutterChangeTarget {
  view: EditorView;
  path: string;
  hunks: EditorHunk[];
}

const stagingEdits = new Set<string>();

async function editStagingHunks(
  { view, path, hunks }: GutterChangeTarget,
  title: string,
  edit: (working: Text) => Promise<void> | void,
  refresh: boolean,
) {
  if (stagingEdits.has(path)) return;
  stagingEdits.add(path);
  const doc = view.state.doc;
  try {
    await runOp(
      title,
      async () => {
        await whenSynced(view);
        const current = await stagingHunks(path);
        if (
          view.state.doc !== doc ||
          !stagingAreaOn() ||
          !hunks.every((hunk) => current.some((range) => sameRange(hunk, range)))
        )
          throw new Error(tx("The displayed versions have changed. Refresh the diff and try again."));
        await edit(doc);
      },
      { refresh },
    );
  } finally {
    stagingEdits.delete(path);
  }
}

export async function updateStagedLines(target: GutterChangeTarget, operation: "stage" | "unstage") {
  const { view, path, hunks } = target;
  const flag = operation === "stage" ? "unstaged" : "staged";
  if (!hunks.length || hunks.some((hunk) => !hunk.staging?.[flag] || !editableHunk(view, hunk))) return;
  const version = hunks[0]!.staging!.indexVersion;
  await editStagingHunks(
    target,
    operation === "stage" ? tx("Stage Change") : tx("Unstage Change"),
    async (working) => {
      const index = await call(commands.vcsStagedText(path));
      if (index?.version !== version || view.state.doc !== working || !stagingAreaOn())
        throw new Error(tx("The displayed versions have changed. Refresh the diff and try again."));
      const text = working.toString();
      const edits = hunks
        .map((hunk) => {
          const range = hunk.staging!;
          return rollbackEdit(index.text, {
            start: range.indexStart,
            lines: range.indexLines,
            oldText: operation === "stage" ? currentHunkText(text, hunk) : hunk.oldText,
          });
        })
        .sort((a, b) => b.from - a.from);
      let next = index.text;
      for (const { from, to, insert } of edits) next = next.slice(0, from) + insert + next.slice(to);
      await call(commands.vcsSaveStagedText(path, version, next));
    },
    true,
  );
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
  stagingChanged?(view: EditorView): void;
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
  private destroyed = false;
  private readonly unsub: () => void;
  private readonly offStaging: () => void;

  constructor(
    private readonly view: EditorView,
    private readonly path: string,
  ) {
    this.schedule(30);
    this.unsub = useVcs.subscribe((s, prev) => {
      if (s.version !== prev.version || s.available !== prev.available) this.schedule(60);
    });
    this.offStaging = onStagingAreaChange(() => {
      this.view.dispatch({ effects: setHunksEffect.of([]) });
      popupHooks?.docChanged(this.view);
      this.schedule(0);
    });
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      popupHooks?.docChanged(this.view);
      this.schedule(300);
    }
  }

  schedule(delay: number) {
    clearTimeout(this.timer);
    const ticket = ++this.seq;
    this.timer = setTimeout(() => void this.fetch(ticket), delay);
  }

  async fetch(ticket: number) {
    if (this.destroyed) return;
    if (!useVcs.getState().available || !isTauri()) {
      if (editorHunks(this.view.state).length) this.view.dispatch({ effects: setHunksEffect.of([]) });
      return;
    }
    const staging = stagingAreaOn();
    try {
      if (staging) await whenSynced(this.view);
      if (this.destroyed || ticket !== this.seq) return;
      const hunks = staging ? await stagingHunks(this.path) : await call(commands.vcsLineHunks(this.path));
      if (this.destroyed || ticket !== this.seq) return;
      this.view.dispatch({ effects: setHunksEffect.of(hunks) });
      if (staging) popupHooks?.stagingChanged?.(this.view);
    } catch {
      // Paths outside the repository etc.: no markers.
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.unsub();
    this.offStaging();
  }
}

function scrollMarks(state: EditorState): ScrollbarMark[] {
  return editorHunks(state).map((h) => ({
    from: h.from,
    to: h.to > h.from ? h.to - 1 : h.from,
    color:
      h.staging?.staged && !h.staging.unstaged
        ? `color-mix(in srgb, ${COLOR[h.kind]} 55%, transparent)`
        : COLOR[h.kind],
    tooltip: h.staging ? stagingTitle(h.staging) : TITLE[h.kind].replace(" (click to show)", ""),
  }));
}

const laneTheme = EditorView.baseTheme({
  ".cm-openidea-lane .cm-gutterElement:has(.cm-openidea-laneBar, .cm-openidea-laneDeleted)": { cursor: "pointer" },
  ".cm-openidea-laneBar[data-git-staging=staged], .cm-openidea-laneBar[data-git-staging=both]": {
    boxSizing: "border-box",
    border: "1px solid var(--lane-color)",
    background: "transparent",
  },
  ".cm-openidea-laneBar[data-git-staging=both]": {
    background: "linear-gradient(90deg, var(--lane-color) 50%, transparent 50%)",
  },
  ".cm-openidea-laneDeleted[data-git-staging=staged]::before, .cm-openidea-laneDeleted[data-git-staging=both]::before":
    {
      content: '""',
      position: "absolute",
      left: "5px",
      top: "4px",
      borderTop: "2px solid transparent",
      borderBottom: "2px solid transparent",
      borderLeft: "4px solid var(--bg-editor-gutter, var(--bg-editor))",
      zIndex: 1,
    },
  ".cm-openidea-laneDeleted[data-git-staging=both]::before": { clipPath: "polygon(0 50%, 100% 50%, 0 100%)" },
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

export function rollbackHunks({ view, path, hunks }: GutterChangeTarget): boolean {
  const eligible = hunks.filter((hunk) => (!hunk.staging || hunk.staging.unstaged) && editableHunk(view, hunk));
  if (!eligible.length || view.state.readOnly) return false;
  const apply = () =>
    view.dispatch({
      changes: eligible.map((hunk) => ({
        from: hunk.from,
        to: hunk.to,
        insert: hunk.staging?.indexText ?? hunk.oldText,
      })),
      userEvent: "input.rollback",
      scrollIntoView: true,
    });
  if (eligible[0]!.staging) {
    void editStagingHunks({ view, path, hunks: eligible }, tx("Rollback"), apply, false);
  } else {
    apply();
  }
  return true;
}

/** Rollback Lines: restores the hunks touched by the selection; false when there are none. */
export function rollbackSelectedLines(view: EditorView, path: string): boolean {
  return rollbackHunks({ view, path, hunks: hunksInSelection(view.state) });
}
