/**
 * Edit › Column Selection Mode (⇧⌘8): while on, a plain mouse drag and
 * ⇧+arrows make rectangular (block) selections, one range per line.
 */
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import { EditorView, keymap, type MouseSelectionStyle } from "@codemirror/view";
import { offsetAtVisibleColumn, stepVisibleColumn, visibleColumn, visibleWidth } from "./visibleColumn";

/** A block between two visible columns (tabs expanded, wide characters 2) of two lines. */
interface Block {
  anchorLine: number;
  anchorCol: number;
  headLine: number;
  headCol: number;
}

interface ColumnState {
  on: boolean;
  /** The block ⇧+arrows extend; reset by any other selection change. */
  block: Block | null;
}

export const setColumnMode = StateEffect.define<boolean>();
const setBlock = StateEffect.define<Block>();

export const columnModeField = StateField.define<ColumnState>({
  create: () => ({ on: false, block: null }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setColumnMode)) next = { on: e.value, block: null };
      else if (e.is(setBlock)) return { ...next, block: e.value };
    }
    if (next.block && (tr.docChanged || tr.selection)) next = { ...next, block: null };
    return next;
  },
});

export function isColumnMode(state: EditorState): boolean {
  return state.field(columnModeField, false)?.on ?? false;
}

export function toggleColumnMode(view: EditorView): boolean {
  view.dispatch({ effects: setColumnMode.of(!isColumnMode(view.state)) });
  return true;
}

/** One range per line from the anchor column to the head column (visible columns, clamped to each line). */
export function blockSelection(state: EditorState, b: Block): EditorSelection {
  const ranges = [];
  const step = b.headLine >= b.anchorLine ? 1 : -1;
  const at = (text: string, col: number) => offsetAtVisibleColumn(text, col, state.tabSize);
  for (let n = b.anchorLine; ; n += step) {
    const line = state.doc.line(n);
    ranges.push(EditorSelection.range(line.from + at(line.text, b.anchorCol), line.from + at(line.text, b.headCol)));
    if (n === b.headLine) break;
  }
  return EditorSelection.create(ranges, ranges.length - 1);
}

/** ⇧+arrow in column mode: moves the block's head by a line / column. */
export function extendBlock(view: EditorView, dLine: number, dCol: number): boolean {
  const state = view.state;
  const field = state.field(columnModeField, false);
  if (!field?.on) return false;
  let b = field.block;
  if (!b) {
    const main = state.selection.main;
    const a = state.doc.lineAt(main.anchor);
    const h = state.doc.lineAt(main.head);
    const col = (text: string, offset: number) => visibleColumn(text, offset, state.tabSize);
    b = {
      anchorLine: a.number,
      anchorCol: col(a.text, main.anchor - a.from),
      headLine: h.number,
      headCol: col(h.text, main.head - h.from),
    };
  }
  const headLine = Math.max(1, Math.min(state.doc.lines, b.headLine + dLine));
  const next = {
    ...b,
    headLine,
    headCol: stepVisibleColumn(state.doc.line(b.headLine).text, b.headCol, dCol, state.tabSize),
  };
  view.dispatch({
    selection: blockSelection(state, next),
    effects: setBlock.of(next),
    scrollIntoView: true,
    userEvent: "select.column",
  });
  return true;
}

interface BlockPoint {
  line: number;
  col: number;
}

/** The line and visible column under the pointer; past the line end, columns of the default character width. */
function blockPointAt(view: EditorView, e: MouseEvent): BlockPoint {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
  const line = view.state.doc.lineAt(pos);
  let col = visibleColumn(line.text, pos - line.from, view.state.tabSize);
  if (pos === line.to) {
    const end = view.coordsAtPos(line.to, -1);
    if (end) col += Math.max(0, Math.round((e.clientX - end.left) / view.defaultCharacterWidth));
  }
  return { line: line.number, col };
}

/** One range per line of the rectangle between two pointer points; lines ending left of it get a caret at their end. */
export function rectangleRanges(state: EditorState, a: BlockPoint, b: BlockPoint): SelectionRange[] {
  const from = Math.min(a.col, b.col);
  const to = Math.max(a.col, b.col);
  const ranges: SelectionRange[] = [];
  for (let n = Math.min(a.line, b.line); n <= Math.max(a.line, b.line); n++) {
    const line = state.doc.line(n);
    if (visibleWidth(line.text, state.tabSize) < from) {
      ranges.push(EditorSelection.cursor(line.to));
      continue;
    }
    const start = offsetAtVisibleColumn(line.text, from, state.tabSize);
    const end = offsetAtVisibleColumn(line.text, to, state.tabSize);
    ranges.push(EditorSelection.range(line.from + start, line.from + end));
  }
  return ranges;
}

/** Mouse rectangular (block) selection in visible columns, for the drags `filter` accepts. */
export function blockMouseSelection(filter: (e: MouseEvent) => boolean): Extension {
  return EditorView.mouseSelectionStyle.of((view, event): MouseSelectionStyle | null => {
    if (!filter(event)) return null;
    let start = blockPointAt(view, event);
    let startSel = view.state.selection;
    return {
      update(update) {
        if (!update.docChanged) return;
        const from = update.changes.mapPos(update.startState.doc.line(start.line).from);
        start = { line: update.state.doc.lineAt(from).number, col: start.col };
        startSel = startSel.map(update.changes);
      },
      get(e, _extend, multiple) {
        const ranges = rectangleRanges(view.state, start, blockPointAt(view, e));
        if (!ranges.length) return startSel;
        return EditorSelection.create(multiple ? ranges.concat(startSel.ranges) : ranges);
      },
    };
  });
}

function viewOf(e: MouseEvent): EditorView | null {
  return e.target instanceof HTMLElement ? EditorView.findFromDOM(e.target) : null;
}

export const columnModeExtension: Extension = [
  columnModeField,
  blockMouseSelection((e) => {
    if (e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey) return false;
    const view = viewOf(e);
    return !!view && isColumnMode(view.state);
  }),
  Prec.high(
    keymap.of([
      { key: "Shift-ArrowUp", run: (v) => extendBlock(v, -1, 0) },
      { key: "Shift-ArrowDown", run: (v) => extendBlock(v, 1, 0) },
      { key: "Shift-ArrowLeft", run: (v) => extendBlock(v, 0, -1) },
      { key: "Shift-ArrowRight", run: (v) => extendBlock(v, 0, 1) },
    ]),
  ),
  EditorView.editorAttributes.compute([columnModeField], (s): Record<string, string> =>
    isColumnMode(s) ? { class: "cm-openidea-columnMode" } : {},
  ),
];
