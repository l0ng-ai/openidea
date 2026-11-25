/**
 * One undo step for an edit made of several transactions (a server refactoring, its
 * reformatting and the in-place rename after it): while a group is open its
 * transactions stay out of the undo history, and closing it records the net change once.
 */
import { EditorState, StateEffect, StateField, Transaction, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const setGroup = StateEffect.define<Text | null>();

const groupStart = StateField.define<Text | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGroup)) return e.value;
    return value;
  },
});

const outOfHistory = EditorState.transactionExtender.of((tr) =>
  tr.startState.field(groupStart, false) && !tr.effects.some((e) => e.is(setGroup))
    ? { annotations: Transaction.addToHistory.of(false) }
    : null,
);

export const historyGroupExtension = [groupStart, outOfHistory];

export function beginHistoryGroup(view: EditorView): void {
  if (view.state.field(groupStart, false) === undefined) return;
  view.dispatch({ effects: setGroup.of(view.state.doc) });
}

/** The one replacement turning `a` into `b` (common prefix and suffix kept). */
function difference(a: Text, b: Text): { from: number; to: number; insert: string } | null {
  const x = a.toString();
  const y = b.toString();
  if (x === y) return null;
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  return { from: start, to: x.length - end, insert: y.slice(start, y.length - end) };
}

/** Closes the group: its net change becomes one undo step (`userEvent`). */
export function endHistoryGroup(view: EditorView, userEvent: string): void {
  const start = view.state.field(groupStart, false);
  if (!start) return;
  const end = view.state.doc;
  const selection = view.state.selection;
  const back = difference(end, start);
  if (!back) {
    view.dispatch({ effects: setGroup.of(null) });
    return;
  }
  view.dispatch({
    changes: back,
    effects: setGroup.of(null),
    annotations: Transaction.addToHistory.of(false),
  });
  view.dispatch({ changes: difference(start, end)!, selection, userEvent, scrollIntoView: false });
}
