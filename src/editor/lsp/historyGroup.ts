/**
 * One undo step for an edit made of several transactions (a server refactoring, its
 * reformatting and the in-place rename after it): while a group is open its
 * transactions stay out of the undo history, and closing it records the net change once.
 *
 * A server edit applied as a workspace refactoring brings its own history marker (undone
 * through the backend, every file at once). Then the marker is the group's undo step, and the
 * local edits after the server's are kept as the refactoring's follow-up edits: undoing the
 * refactoring reverts them first, redoing it applies them again.
 */
import { ChangeSet, EditorState, StateEffect, StateField, Transaction, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  isExternalChange,
  workspaceEditFollowUps,
  workspaceEditMarker,
  type WorkspaceEditFollowUp,
} from "@/editor/api";

interface Group {
  start: Text;
  /** The text after the last change that came from elsewhere (the server's workspace edit). */
  base: Text;
  /** The local changes since `base`. */
  local: ChangeSet;
  /** The workspace refactoring whose marker landed while the group was open. */
  marker: number | null;
}

const setGroup = StateEffect.define<Text | null>();
const addFollowUp = StateEffect.define<{ id: number; followUp: WorkspaceEditFollowUp }>();

const groupField = StateField.define<Group | null>({
  create: () => null,
  update(group, tr) {
    for (const e of tr.effects)
      if (e.is(setGroup))
        return e.value ? { start: e.value, base: e.value, local: ChangeSet.empty(e.value.length), marker: null } : null;
    if (!group) return group;
    const marker = tr.annotation(workspaceEditMarker) ?? group.marker;
    if (!tr.docChanged) return marker === group.marker ? group : { ...group, marker };
    if (isExternalChange(tr)) return { ...group, marker, base: tr.newDoc, local: ChangeSet.empty(tr.newDoc.length) };
    return { ...group, marker, local: group.local.compose(tr.changes) };
  },
});

/** The follow-up edits of the refactorings made in this editor (the latest few). */
const followUpField = StateField.define<ReadonlyMap<number, WorkspaceEditFollowUp>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<number, WorkspaceEditFollowUp> | null = null;
    for (const e of tr.effects)
      if (e.is(addFollowUp)) {
        next ??= new Map(value);
        next.set(e.value.id, e.value.followUp);
        while (next.size > 20) next.delete(next.keys().next().value!);
      }
    return next ?? value;
  },
});

// Only edits stay out of the history: a refactoring's marker (effects alone) must stay in it.
const outOfHistory = EditorState.transactionExtender.of((tr) =>
  tr.docChanged && tr.startState.field(groupField, false) && !tr.effects.some((e) => e.is(setGroup))
    ? { annotations: Transaction.addToHistory.of(false) }
    : null,
);

export const historyGroupExtension = [
  groupField,
  followUpField,
  outOfHistory,
  workspaceEditFollowUps.of((state, id) => state.field(followUpField, false)?.get(id) ?? null),
];

/** Opens a group; false when one is already open (the outer one then covers the edit) or unsupported. */
export function beginHistoryGroup(view: EditorView): boolean {
  if (view.state.field(groupField, false) !== null) return false;
  view.dispatch({ effects: setGroup.of(view.state.doc) });
  return true;
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
  const group = view.state.field(groupField, false);
  if (!group) return;
  const end = view.state.doc;
  if (group.marker !== null) {
    // The refactoring's marker is the undo step; the edits after the server's go with it.
    const changed = !group.base.eq(end);
    view.dispatch({
      effects: [
        setGroup.of(null),
        ...(changed
          ? [
              addFollowUp.of({
                id: group.marker,
                followUp: { changes: group.local, revert: group.local.invert(group.base), end },
              }),
            ]
          : []),
      ],
    });
    return;
  }
  const { start } = group;
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
