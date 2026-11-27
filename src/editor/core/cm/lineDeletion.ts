/**
 * IDEA's Delete to Line Start / Delete to Line End, Cut up to Line End (⌃K on macOS),
 * Kill to Word Start / End and Hungry Backspace. They work on document lines, not on soft-wrapped rows.
 */
import { deleteBracketPair } from "@codemirror/autocomplete";
import { deleteCharBackward } from "@codemirror/commands";
import { EditorSelection, findClusterBreak, type EditorState, type Text } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { writeClipboardText } from "@/platform/clipboard";
import { clipboardHistory, recordClipboard, removeClipboardEntries } from "../clipboardHistory";
import { humpLeft, humpRight, wordEndRight, wordStartLeft } from "../model/camelHumps";

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

/**
 * The whitespace before the caret, across lines, and the word (with CamelHumps, the hump) or
 * punctuation run before it: IDEA's previous word start ignoring line breaks.
 */
const toWordStart =
  (camelHumps: boolean) =>
  (state: EditorState, pos: number): Span => {
    let line = state.doc.lineAt(pos);
    let blank = !state.sliceDoc(line.from, pos).trim();
    while (blank && line.number > 1) {
      line = state.doc.line(line.number - 1);
      blank = !line.text.trim();
    }
    const text = state.sliceDoc(line.from, pos);
    return { from: line.from + (camelHumps ? humpLeft : wordStartLeft)(text, text.length), to: pos };
  };

/** The whitespace after the caret, across lines, and the word (with CamelHumps, the hump) or punctuation run after it. */
const toWordEnd =
  (camelHumps: boolean) =>
  (state: EditorState, pos: number): Span => {
    let line = state.doc.lineAt(pos);
    let blank = !state.sliceDoc(pos, line.to).trim();
    while (blank && line.number < state.doc.lines) {
      line = state.doc.line(line.number + 1);
      blank = !line.text.trim();
    }
    return { from: pos, to: pos + (camelHumps ? humpRight : wordEndRight)(state.sliceDoc(pos, line.to), 0) };
  };

/** The last single-caret cut: the next one at the caret it left, with no edit between, adds to it. */
let lastCut: { doc: Text; pos: number; text: string } | null = null;

/**
 * Cuts `span` of each caret (a selection is ignored, as in IDEA). Repeated with one caret it
 * collects the cuts into one clipboard entry, like IDEA's kill ring: a `backward` cut goes before
 * the collected text, any other after it.
 */
const cutTo =
  (span: (state: EditorState, pos: number) => Span, backward: boolean): Command =>
  (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const s = spans(state, span, false);
    const cut = s.ranges.filter((r) => !r.empty);
    if (!cut.length) return true;
    let text = cut.map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
    const single = state.selection.ranges.length === 1;
    const previous = lastCut;
    if (
      single &&
      previous?.doc === state.doc &&
      previous.pos === state.selection.main.head &&
      clipboardHistory()[0]?.text === previous.text
    ) {
      removeClipboardEntries([previous.text]);
      text = backward ? text + previous.text : previous.text + text;
    }
    remove(view, s, "delete.cut");
    lastCut = single ? { doc: view.state.doc, pos: s.main.from, text } : null;
    recordClipboard(text);
    void writeClipboardText(text).catch(() => {});
    return true;
  };

/** Cuts from each caret to its line end (see `toLineEnd`). */
export const cutToLineEnd = cutTo(toLineEnd, false);

/** IDEA's Kill to Word Start: cuts from the previous word start (see `toWordStart`) to each caret. */
export const killToWordStart = (camelHumps: boolean) => cutTo(toWordStart(camelHumps), true);

/** IDEA's Kill to Word End: cuts from each caret to the next word end (see `toWordEnd`). */
export const killToWordEnd = (camelHumps: boolean) => cutTo(toWordEnd(camelHumps), false);

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
