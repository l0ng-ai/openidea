/**
 * Sticky selection (IDEA's Toggle Sticky Selection): while it is on, every caret move selects
 * from the selection's anchor, which starts at the caret when it is turned on. As in IDEA, an edit
 * of the document or a copy turns it off.
 */
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, type KeyBinding, keymap } from "@codemirror/view";

const setSticky = StateEffect.define<boolean>();

/** Makes the current anchors the new sticky start (Swap Selection Boundaries). */
export const restartSticky = StateEffect.define<null>();

export function isStickySelection(state: EditorState): boolean {
  return state.field(stickySelectionField, false) ?? false;
}

/** Turning it on starts the selection at each caret; turning it off removes the selection, as in IDEA. */
export function toggleStickySelection(view: EditorView): boolean {
  const { selection } = view.state;
  if (view.state.field(stickySelectionField, false) === undefined) return false;
  view.dispatch({
    effects: setSticky.of(!isStickySelection(view.state)),
    selection: EditorSelection.create(
      selection.ranges.map((r) => EditorSelection.cursor(r.head)),
      selection.mainIndex,
    ),
  });
  return true;
}

/**
 * A key binding whose plain move runs its ⇧ variant while sticky selection is on: CodeMirror's
 * plain moves collapse a selection to its edge instead of moving the caret.
 */
export function stickyMove(b: KeyBinding): KeyBinding {
  const { run, shift } = b;
  if (!run || !shift || run === shift) return b;
  return { ...b, run: (view) => (isStickySelection(view.state) ? shift : run)(view) };
}

/** Any other caret move (IDE actions, clicks, Find) keeps each range's anchor; edits pass through. */
const keepAnchors = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !isStickySelection(tr.startState)) return tr;
  if (tr.effects.some((e) => e.is(setSticky) || e.is(restartSticky))) return tr;
  const before = tr.startState.selection.ranges;
  const after = tr.newSelection;
  if (after.ranges.length !== before.length) return tr;
  if (after.ranges.every((r, i) => r.anchor === before[i]!.anchor)) return tr;
  const ranges = after.ranges.map((r, i) => EditorSelection.range(before[i]!.anchor, r.head, r.goalColumn));
  return [tr, { selection: EditorSelection.create(ranges, after.mainIndex), sequential: true }];
});

/**
 * Escape turns sticky selection off and removes the selection, then lets the editor's own
 * Escape (one caret) run. Popups and sessions with their own Escape handle it first.
 */
const escapeSticky = keymap.of([
  {
    key: "Escape",
    run: (view) => {
      if (isStickySelection(view.state)) toggleStickySelection(view);
      return false;
    },
  },
]);

/** A copy turns it off and removes the selection (IDEA's `CopyAction`), once the editor has copied. */
const copySticky = EditorView.domEventHandlers({
  copy: (_event, view) => {
    if (isStickySelection(view.state))
      queueMicrotask(() => {
        if (isStickySelection(view.state)) toggleStickySelection(view);
      });
    return false;
  },
});

export const stickySelectionField = StateField.define<boolean>({
  create: () => false,
  // Any document change ends it (IDEA's `EditorImpl.beforeChangedUpdate`).
  update: (on, tr) => tr.effects.reduce((acc, e) => (e.is(setSticky) ? e.value : acc), tr.docChanged ? false : on),
  provide: () => [keepAnchors, escapeSticky, copySticky],
});
