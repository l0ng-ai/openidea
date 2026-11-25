/**
 * IDEA's Delete to Line Start / Delete to Line End, Cut up to Line End (⌃K on macOS) and
 * Hungry Backspace. They work on document lines, not on soft-wrapped rows.
 */
import { deleteBracketPair } from "@codemirror/autocomplete";
import { deleteCharBackward } from "@codemirror/commands";
import { EditorSelection, findClusterBreak, type EditorState, type Text } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { writeClipboardText } from "@/platform/clipboard";
import { clipboardHistory, recordClipboard, removeClipboardEntries } from "../clipboardHistory";

type Span = { from: number; to: number };

/** The caret to its line end; also the line break when only whitespace follows (or the caret is at the end). */
function toLineEnd(state: EditorState, pos: number): Span {
  const line = state.doc.lineAt(pos);
  const blank = !state.sliceDoc(pos, line.to).trim();
  return { from: pos, to: blank && line.to < state.doc.length ? line.to + 1 : line.to };
}

/** The caret's line up to the caret; at the line start, the line break before it. */
function toLineStart(state: EditorState, pos: number): Span {
  const line = state.doc.lineAt(pos);
  return { from: pos === line.from ? Math.max(0, pos - 1) : line.from, to: pos };
}

/** `span` of each caret (or each selection, with `keepSelections`), overlaps merged. */
function spans(state: EditorState, span: (state: EditorState, pos: number) => Span, keepSelections: boolean) {
  const ranges = state.selection.ranges.map((r) => {
    const s = keepSelections && !r.empty ? r : span(state, r.head);
    return EditorSelection.range(s.from, s.to);
  });
  return EditorSelection.create(ranges, state.selection.mainIndex);
}

function remove(view: EditorView, spans: EditorSelection, userEvent: string) {
  const changes = view.state.changes(spans.ranges.map((r) => ({ from: r.from, to: r.to })));
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      spans.ranges.map((r) => EditorSelection.cursor(changes.mapPos(r.from))),
      spans.mainIndex,
    ),
    scrollIntoView: true,
    userEvent,
  });
}

const deleteTo =
  (span: (state: EditorState, pos: number) => Span, userEvent: string): Command =>
  (view) => {
    if (view.state.readOnly) return false;
    const s = spans(view.state, span, true);
    if (s.ranges.some((r) => !r.empty)) remove(view, s, userEvent);
    return true;
  };

/** A selection is deleted as it is; a caret deletes to its line start (see `toLineStart`). */
export const deleteToLogicalLineStart = deleteTo(toLineStart, "delete.backward");

/** A selection is deleted as it is; a caret deletes to its line end (see `toLineEnd`). */
export const deleteToLogicalLineEnd = deleteTo(toLineEnd, "delete.forward");

/** The last single-caret Cut up to Line End: the next one at the same caret, with no edit between, adds to it. */
let lastCut: { doc: Text; pos: number; text: string } | null = null;

/**
 * Cuts from each caret to its line end (a selection is ignored, as in IDEA). Repeated with
 * one caret it collects the cut lines into one clipboard entry, like IDEA's kill ring.
 */
export const cutToLineEnd: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const s = spans(state, toLineEnd, false);
  const cut = s.ranges.filter((r) => !r.empty);
  if (!cut.length) return true;
  let text = cut.map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
  const single = state.selection.ranges.length === 1;
  const pos = s.main.from;
  const previous = lastCut;
  if (single && previous?.doc === state.doc && previous.pos === pos && clipboardHistory()[0]?.text === previous.text) {
    removeClipboardEntries([previous.text]);
    text = previous.text + text;
  }
  remove(view, s, "delete.cut");
  lastCut = single ? { doc: view.state.doc, pos, text } : null;
  recordClipboard(text);
  void writeClipboardText(text).catch(() => {});
  return true;
};

/** Spaces, tabs and line breaks, the whitespace Hungry Backspace removes (IDEA's `StringUtil.isWhiteSpace`). */
const HUNGRY = /[ \t\n]/;

/** The run of whitespace before the caret, across lines; otherwise the character before it. */
function toWhitespaceStart(state: EditorState, pos: number): Span {
  let from = pos;
  while (from > 0 && HUNGRY.test(state.sliceDoc(from - 1, from))) from--;
  if (from < pos || pos === 0) return { from, to: pos };
  const line = state.doc.lineAt(pos);
  return { from: line.from + findClusterBreak(line.text, pos - line.from, false), to: pos };
}

/**
 * Deletes all whitespace (line breaks too) before each caret, as IDEA's Hungry Backspace; a
 * selection, or a caret after anything else, gets a plain Backspace (an empty bracket pair goes as one).
 */
export const hungryBackspace: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const hungry = state.selection.ranges.some(
    (r) => r.empty && r.head > 0 && HUNGRY.test(state.sliceDoc(r.head - 1, r.head)),
  );
  if (!hungry) return deleteBracketPair(view) || deleteCharBackward(view);
  remove(view, spans(state, toWhitespaceStart, true), "delete.backward");
  return true;
};
