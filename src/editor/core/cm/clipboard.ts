import { EditorSelection, Facet, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";
import { isRemoteWindow } from "@/platform/remote";
import { isMarkdown, relativeImagePath } from "./markdownImages";

export const clipboardDocumentPath = Facet.define<string, string>({ combine: (paths) => paths[0] ?? "" });

function clipboardFileFormatter(view: EditorView): ((paths: string[]) => string) | undefined {
  const path = view.state.facet(clipboardDocumentPath);
  return isMarkdown(path) && !isRemoteWindow()
    ? (paths) => paths.map((target) => `[](${relativeImagePath(path, target)})`).join("\n")
    : undefined;
}

/**
 * The dispatch shared by every paste entry point. With several carets and a
 * clipboard of exactly one line per caret, each caret gets its own line
 * (JetBrains behavior): `"a\nb"` at two carets inserts `a` then `b`, not the
 * block twice. Any other count pastes the full text at every caret.
 * `userEvent` is `"input.paste"` unless the caller passes another (plain-text
 * paste opts out of Reformat on Paste through `"input.pastePlain"`).
 */
export function dispatchPaste(view: EditorView, text: string, userEvent = "input.paste") {
  const ranges = view.state.selection.ranges;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (ranges.length > 1 && lines.length === ranges.length) {
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

export function pasteEditorText(view: EditorView, text: string) {
  if (!text || !view.dom.isConnected || view.state.readOnly) return;
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
