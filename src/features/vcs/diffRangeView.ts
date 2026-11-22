import { EditorSelection, EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { isExternalChange } from "@/editor/api";
import { mapDiffRange, type DiffRange } from "./stagingRange";

export const setDiffRange = StateEffect.define<DiffRange | null>();

function updatedRange(tr: Transaction, range: DiffRange | null) {
  for (const effect of tr.effects) if (effect.is(setDiffRange)) return effect.value;
  if (!range || !tr.docChanged) return range;
  return mapDiffRange(range, tr.startState.doc, tr.newDoc, tr.changes) ?? { from: 0, to: 0, line: 0, lines: 0 };
}

const rangeField = StateField.define<DiffRange | null>({
  create: () => null,
  update: (range, tr) => updatedRange(tr, range),
});

const hidden = EditorView.decorations.compute([rangeField, "doc"], (state) => {
  const range = state.field(rangeField);
  if (!range) return Decoration.none;
  const hide = Decoration.replace({ block: true, inclusive: true });
  return Decoration.set([
    ...(range.from > 0 ? [hide.range(0, range.from)] : []),
    ...(range.to < state.doc.length ? [hide.range(range.to, state.doc.length)] : []),
  ]);
});

/** Show only the excerpt while keeping the original document, syntax and edit history. */
export const diffRangeView = [
  rangeField,
  hidden,
  EditorState.changeFilter.of((tr) => {
    const range = tr.startState.field(rangeField);
    if (
      !range ||
      !tr.docChanged ||
      isExternalChange(tr) ||
      tr.isUserEvent("revert") ||
      tr.isUserEvent("undo") ||
      tr.isUserEvent("redo")
    )
      return true;
    let outside = false;
    tr.changes.iterChangedRanges((from, to) => {
      if (from < range.from || to > range.to) outside = true;
    });
    return !outside;
  }),
  EditorState.transactionFilter.of((tr) => {
    const range = updatedRange(tr, tr.startState.field(rangeField));
    if (!range) return tr;
    const selection = tr.newSelection;
    const clamp = (pos: number) => Math.max(range.from, Math.min(range.to, pos));
    const clipped = EditorSelection.create(
      selection.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head))),
      selection.mainIndex,
    );
    return clipped.eq(selection) ? tr : [tr, { selection: clipped, sequential: true }];
  }),
];
