import { EditorSelection, Facet, Prec, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";
import type { LinePasteMode } from "@/platform/editorSettings";
import { isRemoteWindow } from "@/platform/remote";
import { isLinewiseClipboardText } from "../clipboardHistory";
import { isMarkdown, relativeImagePath } from "./markdownImages";

export const clipboardDocumentPath = Facet.define<string, string>({ combine: (paths) => paths[0] ?? "" });

/** Effective Smart Keys setting, supplied by the editor's prefs compartment. */
export const linePasteMode = Facet.define<LinePasteMode, LinePasteMode>({ combine: (modes) => modes[0] ?? "above" });

export function filterCopiedText(state: EditorState, text: string): string {
  return state.facet(EditorView.clipboardOutputFilter).reduce((value, filter) => filter(value, state), text);
}

function clipboardFileFormatter(view: EditorView): ((paths: string[]) => string) | undefined {
  const path = view.state.facet(clipboardDocumentPath);
  return isMarkdown(path) && !isRemoteWindow()
    ? (paths) => paths.map((target) => `[](${relativeImagePath(path, target)})`).join("\n")
    : undefined;
}

/**
 * Line-wise copies go above each distinct caret line by default, keeping carets
 * on their original text. `caret` restores insertion at the caret (a copied line
 * keeps its line break), while `trim` inserts the copied text without boundary
 * whitespace in the middle of a line and still pastes above at a line boundary.
 * Otherwise, with several carets and a multi-line clipboard, the lines spread
 * across the carets the way IntelliJ
 * does (its ClipboardTextPerCaretSplitter): caret *i* gets line *i*, missing
 * lines become empty inserts, and lines beyond the caret count are dropped —
 * `"a\nb"` at two carets inserts `a` then `b`, not the block twice, while a
 * single line (a trailing newline doesn't make it multi-line) repeats at every
 * caret without the newline.
 * `userEvent` is `"input.paste"` unless the caller passes another (plain-text
 * paste opts out of Reformat on Paste through `"input.pastePlain"`).
 */
function pasteAbove(view: EditorView, text: string, userEvent: string) {
  const state = view.state;
  const starts = [...new Set(state.selection.ranges.map((r) => state.doc.lineAt(r.head).from))];
  const insert = state.toText(text + state.lineBreak);
  const changes = state.changes(starts.map((from) => ({ from, insert })));
  view.dispatch({ changes, selection: state.selection.map(changes, 1), userEvent, scrollIntoView: true });
}

export function dispatchPaste(view: EditorView, text: string, userEvent = "input.paste") {
  const state = view.state;
  const ranges = state.selection.ranges;
  const linewise = isLinewiseClipboardText(text) && ranges.every((r) => r.empty);
  const mode = state.facet(linePasteMode);
  if (linewise) {
    const atBoundary = ranges.map((range) => {
      const line = state.doc.lineAt(range.head);
      return range.head === line.from || range.head === line.to;
    });
    if (mode === "above" || (mode === "trim" && atBoundary.every(Boolean))) {
      pasteAbove(view, text, userEvent);
      return;
    }
    if (ranges.length === 1 && mode === "caret") {
      const insert = state.toText(/[\r\n]$/.test(text) ? text : text + state.lineBreak);
      const head = ranges[0]!.head;
      view.dispatch({
        changes: { from: head, to: head, insert },
        selection: EditorSelection.cursor(head + insert.length),
        userEvent,
        scrollIntoView: true,
      });
      return;
    }
    if (ranges.length === 1 && mode === "trim") {
      const head = ranges[0]!.head;
      const insert = state.toText(text.trim());
      view.dispatch({
        changes: { from: head, to: head, insert },
        selection: EditorSelection.cursor(head + insert.length),
        userEvent,
        scrollIntoView: true,
      });
      return;
    }
  }
  const lines = pasteLinesPerCaret(text, ranges.length, linewise && mode === "trim");
  if (lines) {
    let i = 0;
    const spec = view.state.changeByRange((range) => {
      const insert = lines[i++]!;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    });
    view.dispatch({ ...spec, userEvent, scrollIntoView: true });
  } else {
    view.dispatch(view.state.replaceSelection(text), { userEvent, scrollIntoView: true });
  }
}

/**
 * The per-caret inserts for `text` at `caretCount` carets, mirroring IntelliJ's
 * ClipboardTextPerCaretSplitter: line *i* for caret *i*, `""` for the carets
 * left over when there are more carets than lines, and the lines beyond the
 * caret count dropped. A clipboard of a single line — a lone trailing newline
 * is an artifact of copying, not an extra empty line — repeats at every caret
 * without its newline. `undefined` keeps the single-caret fallback.
 */
function pasteLinesPerCaret(text: string, caretCount: number, trim = false): string[] | undefined {
  if (caretCount <= 1) return undefined;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 2 && lines[1] === "") lines.pop();
  if (lines.length === 1) return Array(caretCount).fill(trim ? lines[0]!.trim() : lines[0]!);
  return Array.from({ length: caretCount }, (_, i) => {
    const line = lines[i] ?? "";
    return trim ? line.trim() : line;
  });
}

export function pasteEditorText(view: EditorView, text: string) {
  if ((!text && !isLinewiseClipboardText(text)) || !view.dom.isConnected || view.state.readOnly) return;
  dispatchPaste(view, text);
  view.focus();
}

export async function pasteEditorClipboard(view: EditorView) {
  if (!view.dom.isConnected || view.state.readOnly) return;
  try {
    // Successful native paste preserves image blobs and may complete after execCommand returns.
    if (isMarkdown(view.state.facet(clipboardDocumentPath)) && document.queryCommandSupported("paste")) {
      view.focus();
      if (document.execCommand("paste")) return;
    }
    pasteEditorText(view, await readClipboardText(undefined, clipboardFileFormatter(view)));
  } catch {
    if (!view.dom.isConnected || view.state.readOnly) return;
    view.focus();
    document.execCommand("paste");
  }
}

// Markdown image handlers get first refusal, including copied image files.
export const clipboardFilesExtension = Prec.lowest(
  EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      return pasteClipboardFiles(event, (text) => pasteEditorText(view, text), clipboardFileFormatter(view));
    },
  }),
);
