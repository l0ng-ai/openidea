import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteClipboardFiles, readClipboardText } from "@/platform/clipboard";

export function pasteEditorText(view: EditorView, text: string) {
  if (!text || !view.dom.isConnected || view.state.readOnly) return;
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}

export async function pasteEditorClipboard(view: EditorView) {
  try {
    pasteEditorText(view, await readClipboardText());
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
      return pasteClipboardFiles(event, (text) => pasteEditorText(view, text));
    },
  }),
);
