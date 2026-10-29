/**
 * ↑ / ↓ (with ⇧ extending) and Clone Caret Above / Below in visible columns:
 * the caret keeps its goal column across lines of mixed-width text (CJK,
 * fullwidth punctuation, emoji, tabs) instead of a pixel x that drifts when a
 * wide glyph is not exactly two cells wide. Soft-wrapped lines keep
 * CodeMirror's pixel motion between their visual rows.
 */
import { EditorSelection, StateEffect, StateField, type EditorState, type SelectionRange } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { offsetAtVisibleColumn, visibleColumn } from "./visibleColumn";

/** Goal visible column per caret head, kept while only these commands move the carets. */
const setGoals = StateEffect.define<ReadonlyMap<number, number>>();

export const visibleGoalColumns = StateField.define<ReadonlyMap<number, number> | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGoals)) return e.value;
    return tr.selection || tr.docChanged ? null : value;
  },
});

function goalOf(state: EditorState, head: number): number {
  const goal = state.field(visibleGoalColumns, false)?.get(head);
  if (goal !== undefined) return goal;
  const line = state.doc.lineAt(head);
  return visibleColumn(line.text, head - line.from, state.tabSize);
}

/** Whether the line from `pos` is one visual row (not soft-wrapped, not merged with others by a fold). */
function singleRow(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const block = view.lineBlockAt(pos);
  if (block.from !== line.from || block.to !== line.to) return false;
  if (!view.lineWrapping || line.length === 0) return true;
  const a = view.coordsAtPos(line.from, 1);
  const b = view.coordsAtPos(line.to, -1);
  return !!a && !!b && Math.abs(a.top - b.top) < 1;
}

/** The head one visual line up / down from `head` at visible column `goal`, or null at the document edge. */
export function verticalHead(view: EditorView, head: number, forward: boolean, goal: number): number | null {
  const { state } = view;
  const block = view.lineBlockAt(head);
  if (forward ? block.to >= state.doc.length : block.from <= 0) return null;
  const target = forward ? block.to + 1 : block.from - 1;
  if (singleRow(view, head) && singleRow(view, target)) {
    const line = state.doc.lineAt(target);
    return line.from + offsetAtVisibleColumn(line.text, goal, state.tabSize);
  }
  const moved = view.moveVertically(EditorSelection.cursor(head), forward).head;
  return moved === head ? null : moved;
}

function moveCarets(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { state } = view;
  const goals = new Map<number, number>();
  const ranges = state.selection.ranges.map((r): SelectionRange => {
    if (!extend && !r.empty) return EditorSelection.cursor(forward ? r.to : r.from);
    const goal = goalOf(state, r.head);
    let head = verticalHead(view, r.head, forward, goal);
    if (head === null) head = forward ? state.doc.lineAt(r.head).to : state.doc.lineAt(r.head).from;
    goals.set(head, goal);
    return extend ? EditorSelection.range(r.anchor, head) : EditorSelection.cursor(head);
  });
  const selection = EditorSelection.create(ranges, state.selection.mainIndex);
  if (selection.eq(state.selection)) return false;
  view.dispatch({ selection, effects: setGoals.of(goals), scrollIntoView: true, userEvent: "select" });
  return true;
}

export const cursorLineUp: Command = (view) => moveCarets(view, false, false);
export const cursorLineDown: Command = (view) => moveCarets(view, true, false);
export const selectLineUp: Command = (view) => moveCarets(view, false, true);
export const selectLineDown: Command = (view) => moveCarets(view, true, true);

/** Clone Caret Above / Below: a caret on the next line at each caret's goal column. */
function cloneCaret(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const ranges = state.selection.ranges.slice();
  const goals = new Map<number, number>();
  for (const r of state.selection.ranges) {
    const goal = goalOf(state, r.head);
    goals.set(r.head, goal);
    const line = state.doc.lineAt(r.head);
    // A soft-wrapped line: step over its own visual rows first.
    let head: number | null = r.head;
    while (head !== null && head >= line.from && head <= line.to) {
      const next = verticalHead(view, head, forward, goal);
      head = next === head ? null : next;
    }
    if (head === null || ranges.some((x) => x.head === head)) continue;
    ranges.push(EditorSelection.cursor(head));
    goals.set(head, goal);
  }
  if (ranges.length === state.selection.ranges.length) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, ranges.length - 1),
    effects: setGoals.of(goals),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export const cloneCaretAbove: Command = (view) => cloneCaret(view, false);
export const cloneCaretBelow: Command = (view) => cloneCaret(view, true);
