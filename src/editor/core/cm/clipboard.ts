import { EditorSelection, Facet, Prec, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";
import { isRemoteWindow } from "@/platform/remote";
import { isLinewiseClipboardText } from "../clipboardHistory";
import { isMarkdown, relativeImagePath } from "./markdownImages";

export const clipboardDocumentPath = Facet.define<string, string>({ combine: (paths) => paths[0] ?? "" });

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
 * Line-wise copies go above each distinct caret line, keeping carets on their
 * original text. Otherwise, with several carets and a multi-line clipboard,
 * the lines spread across the carets the way IntelliJ
 * does (its ClipboardTextPerCaretSplitter): caret *i* gets line *i*, missing
 * lines become empty inserts, and lines beyond the caret count are dropped —
 * `"a\nb"` at two carets inserts `a` then `b`, not the block twice, while a
 * single line (a trailing newline doesn't make it multi-line) repeats at every
 * caret without the newline.
 * `userEvent` is `"input.paste"` unless the caller passes another (plain-text
 * paste opts out of Reformat on Paste through `"input.pastePlain"`).
 */
export function dispatchPaste(view: EditorView, text: string, userEvent = "input.paste") {
  const state = view.state;
  const ranges = state.selection.ranges;
  if (isLinewiseClipboardText(text) && ranges.every((r) => r.empty)) {
    const insert = state.toText(text + state.lineBreak);
    const starts = [...new Set(ranges.map((r) => state.doc.lineAt(r.head).from))];
    const changes = state.changes(starts.map((from) => ({ from, insert })));
    view.dispatch({ changes, selection: state.selection.map(changes, 1), userEvent, scrollIntoView: true });
    return;
  }
  const lines = pasteLinesPerCaret(text, ranges.length);
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
function pasteLinesPerCaret(text: string, caretCount: number): string[] | undefined {
  if (caretCount <= 1) return undefined;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 2 && lines[1] === "") lines.pop();
  if (lines.length === 1) return Array(caretCount).fill(lines[0]!);
  return Array.from({ length: caretCount }, (_, i) => lines[i] ?? "");
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
