import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { stagingAreaOn } from "./staging";
import type { DiffLineSelection } from "./hunkInclusion";

const deletedRow = ".cm-deletedChunk > .cm-deletedLine";
const diffRow = `.cm-line, ${deletedRow}`;
const selectedClass = "cm-unified-commit-selected";
const markWorkingRows = StateEffect.define<DecorationSet>();
const workingRowMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, transaction) =>
    transaction.effects.find((effect) => effect.is(markWorkingRows))?.value ??
    (transaction.docChanged ? Decoration.none : marks),
  provide: (field) => EditorView.decorations.from(field),
});
const selectedWorkingRow = Decoration.line({ attributes: { class: selectedClass } });

function rowAt(view: EditorView, target: EventTarget | null): Element | null {
  const row = target instanceof Element ? target.closest(diffRow) : null;
  return row && view.contentDOM.contains(row) ? row : null;
}

// A browser selection cannot drag out of a contenteditable=false deletion widget.
// Track the rendered rows across that boundary and leave ordinary text selections to CodeMirror.
const crossSideSelection = ViewPlugin.fromClass(
  class {
    private removedRows: Element[] = [];
    private selection?: DiffLineSelection;
    private drag?: AbortController;

    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("pointerdown", this.start);
      view.dom.addEventListener("keydown", this.clear);
    }

    private setRows(rows: Element[]) {
      const selection = selectionOfRows(this.view, rows);
      this.clearRemovedRows();
      this.selection = selection;
      this.removedRows = rows.filter((row) => row.matches(deletedRow));
      for (const row of this.removedRows) row.classList.add(selectedClass);
      const doc = this.view.state.doc;
      const marks = Decoration.set(
        selection.current.map(({ first }) => selectedWorkingRow.range(doc.line(first + 1).from)),
      );
      this.view.dispatch({ effects: markWorkingRows.of(marks) });
    }

    private clearRemovedRows() {
      for (const row of this.removedRows) row.classList.remove(selectedClass);
      this.removedRows = [];
      this.selection = undefined;
    }

    private clear = () => {
      if (!this.selection) return;
      this.clearRemovedRows();
      this.view.dispatch({ effects: markWorkingRows.of(Decoration.none) });
    };

    selectionAt(row: Element) {
      return row.classList.contains(selectedClass) ? this.selection : undefined;
    }

    private start = (event: PointerEvent) => {
      if (event.button !== 0) return;
      this.clear();
      this.drag?.abort();
      const anchor = rowAt(this.view, event.target);
      if (!anchor || stagingAreaOn()) return;
      const owner = this.view.dom.ownerDocument;
      const drag = (this.drag = new AbortController());
      const hostOf = (row: Element) => row.closest(".cm-deletedChunk") ?? this.view.contentDOM;
      const sourceHost = hostOf(anchor);
      let last = anchor;
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId || !(next.buttons & 1)) return;
        const row = rowAt(this.view, next.target);
        if (!row || row === last) return;
        last = row;
        const order = [...this.view.contentDOM.querySelectorAll(diffRow)];
        const from = order.indexOf(anchor);
        const to = order.indexOf(row);
        if (from < 0 || to < 0) return;
        const rows = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        if (rows.some((line) => hostOf(line) !== sourceHost)) this.setRows(rows);
        else this.clear();
      };
      const stop = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        if (next.type === "pointercancel") this.clear();
        drag.abort();
      };
      const options = { capture: true, signal: drag.signal };
      owner.addEventListener("pointermove", move, options);
      owner.addEventListener("pointerup", stop, options);
      owner.addEventListener("pointercancel", stop, options);
    };

    update(update: ViewUpdate) {
      if (update.docChanged) this.clearRemovedRows();
    }

    destroy() {
      this.drag?.abort();
      this.view.contentDOM.removeEventListener("pointerdown", this.start);
      this.view.dom.removeEventListener("keydown", this.clear);
      this.clearRemovedRows();
    }
  },
);

export const unifiedCommitSelection = [crossSideSelection, workingRowMarks];

/** The end of a selection at column zero belongs to the preceding row. */
function selectsRow(range: Range, row: Element): boolean {
  if (!range.intersectsNode(row)) return false;
  if (!row.contains(range.endContainer)) return true;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(row);
  prefix.setEnd(range.endContainer, range.endOffset);
  return prefix.toString().length > 0;
}

/** Deleted rows are widgets in the working editor. Their line numbers are in the original document. */
export function unifiedCommitLines(view: EditorView, target: Element): DiffLineSelection | null {
  const clicked = rowAt(view, target);
  if (!clicked) return null;
  const dragged = view.plugin(crossSideSelection)?.selectionAt(clicked);
  if (dragged) return dragged;
  const selection = view.dom.ownerDocument.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const rows =
    range && view.contentDOM.contains(range.commonAncestorContainer) && selectsRow(range, clicked)
      ? [...view.contentDOM.querySelectorAll(diffRow)].filter((row) => selectsRow(range, row))
      : [clicked];
  if (!rows.some((row) => row.matches(deletedRow))) return null;
  const mapped = selectionOfRows(view, rows);
  return mapped.old.length ? mapped : null;
}

function selectionOfRows(view: EditorView, rows: Element[]) {
  const original = getOriginalDoc(view.state);
  const chunks = new Map(
    getChunks(view.state)
      ?.chunks.filter((chunk) => chunk.fromA < chunk.toA)
      .map((chunk) => [chunk.fromB, chunk]),
  );
  const selected = new Set(rows);
  const old: { first: number; last: number }[] = [];
  const current: { first: number; last: number }[] = [];
  for (const widget of new Set(rows.filter((row) => row.matches(deletedRow)).map((row) => row.parentElement!))) {
    const chunk = chunks.get(view.posAtDOM(widget));
    if (!chunk) continue;
    const start = original.lineAt(chunk.fromA).number - 1;
    const end = original.lineAt(chunk.endA).number - 1;
    widget.querySelectorAll(":scope > .cm-deletedLine").forEach((row, offset) => {
      const line = start + offset;
      if (line <= end && selected.has(row)) old.push({ first: line, last: line });
    });
  }
  for (const row of rows) {
    if (!row.matches(".cm-line")) continue;
    const line = view.state.doc.lineAt(view.posAtDOM(row)).number - 1;
    current.push({ first: line, last: line });
  }
  return { old, current };
}
