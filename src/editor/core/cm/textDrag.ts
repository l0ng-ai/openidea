import { EditorSelection, StateEffect, StateField, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, RectangleMarker, layer } from "@codemirror/view";
import { isMacHost } from "@/platform/keymap";

// Moving selected text by dragging it, driven by mouse events. The desktop webview
// keeps native drag and drop for files dropped onto the window, which stops HTML5
// drop events from reaching the page, so CodeMirror's built-in text drag never lands.

const DRAG_THRESHOLD = 4;
const EDGE = 24;

const setDropPos = StateEffect.define<number | null>();

const dropPos = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDropPos)) value = e.value;
    return value === null || !tr.docChanged ? value : tr.changes.mapPos(value);
  },
});

const dropCaret = layer({
  above: true,
  class: "cm-openidea-textDropLayer",
  markers(view) {
    const pos = view.state.field(dropPos);
    return pos === null ? [] : RectangleMarker.forRange(view, "cm-dropCursor", EditorSelection.cursor(pos));
  },
  update: (u) =>
    u.docChanged || u.geometryChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setDropPos))),
});

/** Whether a press at (`x`, `y`), which maps to `pos`, lands on the selected text of `range`. */
function onSelection(view: EditorView, range: SelectionRange, pos: number, x: number, y: number): boolean {
  if (range.empty || pos < range.from || pos > range.to) return false;
  if (pos > range.from && pos < range.to) return true;
  const c = view.coordsAtPos(pos, pos === range.from ? 1 : -1);
  if (!c || y < c.top || y > c.bottom) return false;
  return pos === range.from ? x >= c.left : x <= c.right;
}

function viewAt(x: number, y: number): EditorView | null {
  const el = document.elementFromPoint(x, y)?.closest(".cm-editor");
  return el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
}

/** Whether a drop copies instead of moving: ⌥ on macOS, Ctrl elsewhere, as for native drags. */
const copies = (e: MouseEvent) => (isMacHost() ? e.altKey : e.ctrlKey);

function startDrag(source: EditorView, range: SelectionRange, down: MouseEvent): void {
  const doc = source.dom.ownerDocument;
  let dragging = false;
  let target: EditorView | null = null;
  let last = down;
  let frame = 0;

  const showAt = (view: EditorView | null, pos: number | null) => {
    if (target && target !== view) target.dispatch({ effects: setDropPos.of(null) });
    target = view;
    if (view && view.state.field(dropPos, false) !== pos) view.dispatch({ effects: setDropPos.of(pos) });
  };

  const track = () => {
    const view = viewAt(last.clientX, last.clientY) ?? (target && withinX(target, last) ? target : null);
    const pos =
      view?.state.field(dropPos, false) === undefined ? null : view.posAtCoords({ x: last.clientX, y: last.clientY });
    showAt(view && pos !== null ? view : null, pos);
  };

  const withinX = (view: EditorView, e: MouseEvent) => {
    const r = view.scrollDOM.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right;
  };

  // Scroll the editor under the pointer while it rests near or past its top or bottom edge.
  const autoScroll = () => {
    frame = 0;
    if (!dragging || !target) return;
    const r = target.scrollDOM.getBoundingClientRect();
    const dy =
      last.clientY < r.top + EDGE
        ? last.clientY - (r.top + EDGE)
        : last.clientY > r.bottom - EDGE
          ? last.clientY - (r.bottom - EDGE)
          : 0;
    if (!dy) return;
    target.scrollDOM.scrollTop += Math.max(-EDGE, Math.min(EDGE, dy));
    const pos = target.posAtCoords({ x: last.clientX, y: Math.max(r.top + 1, Math.min(r.bottom - 1, last.clientY)) });
    if (pos !== null) showAt(target, pos);
    frame = requestAnimationFrame(autoScroll);
  };

  const finish = () => {
    doc.removeEventListener("mousemove", move, true);
    doc.removeEventListener("mouseup", up, true);
    doc.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (frame) cancelAnimationFrame(frame);
    const view = target;
    showAt(null, null);
    return view;
  };

  const cancel = () => void finish();

  const move = (e: MouseEvent) => {
    last = e;
    if (!dragging) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
      dragging = true;
    }
    e.preventDefault();
    track();
    if (!frame) frame = requestAnimationFrame(autoScroll);
  };

  const up = (e: MouseEvent) => {
    last = e;
    if (dragging) track();
    const pos = target?.state.field(dropPos) ?? null;
    const view = finish();
    e.preventDefault();
    if (!dragging) {
      const at = source.posAtCoords({ x: e.clientX, y: e.clientY });
      if (at !== null) source.dispatch({ selection: { anchor: at }, userEvent: "select.pointer" });
      source.focus();
      return;
    }
    if (!view || pos === null) return;
    drop(source, range, view, pos, copies(e));
  };

  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  doc.addEventListener("mousemove", move, true);
  doc.addEventListener("mouseup", up, true);
  doc.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}

/** Drops the text of `range` from `source` at `pos` in `target`, moving it unless `copy`. */
function drop(source: EditorView, range: SelectionRange, target: EditorView, pos: number, copy: boolean): void {
  const text = source.state.sliceDoc(range.from, range.to);
  if (target.state.readOnly) return;
  const move = !copy && !source.state.readOnly;
  if (target === source) {
    if (pos >= range.from && pos <= range.to) {
      source.focus();
      return;
    }
    const changes = source.state.changes([
      ...(move ? [{ from: range.from, to: range.to }] : []),
      { from: pos, insert: text },
    ]);
    const at = changes.mapPos(pos, -1);
    source.dispatch({
      changes,
      selection: EditorSelection.single(at, at + text.length),
      userEvent: move ? "move.drop" : "input.drop",
      scrollIntoView: true,
    });
    source.focus();
    return;
  }
  target.dispatch({
    changes: { from: pos, insert: text },
    selection: EditorSelection.single(pos, pos + text.length),
    userEvent: "input.drop",
    scrollIntoView: true,
  });
  if (move) source.dispatch({ changes: { from: range.from, to: range.to }, userEvent: "delete.drop" });
  target.focus();
}

const pressHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (!view.contentDOM.contains(e.target as Node)) return false;
    const { ranges } = view.state.selection;
    const range = ranges[0]!;
    if (ranges.length > 1 || range.empty) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null || !onSelection(view, range, pos, e.clientX, e.clientY)) return false;
    e.preventDefault();
    startDrag(view, range, e);
    return true;
  },
});

/** Drag selected text to move it; hold ⌥ (macOS) or Ctrl to copy it instead. */
export const textDrag: Extension = [dropPos, dropCaret, pressHandler];
