import { Facet, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";
import { isMarkdown, relativeImagePath } from "./markdownImages";

export const clipboardDocumentPath = Facet.define<string, string>({ combine: (paths) => paths[0] ?? "" });

function clipboardFileFormatter(view: EditorView): ((paths: string[]) => string) | undefined {
  const path = view.state.facet(clipboardDocumentPath);
  return isMarkdown(path)
    ? (paths) => paths.map((target) => `[](${relativeImagePath(path, target)})`).join("\n")
    : undefined;
}

export function pasteEditorText(view: EditorView, text: string) {
  if (!text || !view.dom.isConnected || view.state.readOnly) return;
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}

export async function pasteEditorClipboard(view: EditorView) {
  if (!view.dom.isConnected || view.state.readOnly) return;
  try {
    // Native paste preserves image blobs and may complete after execCommand returns.
    if (isMarkdown(view.state.facet(clipboardDocumentPath)) && document.queryCommandSupported("paste")) {
      view.focus();
      document.execCommand("paste");
      return;
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
