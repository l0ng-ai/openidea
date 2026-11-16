/**
 * Code previews outside editor tabs (Find in Files, bookmarks): the
 * editor's font, colours, line numbers and syntax highlighting, without
 * folding or contributions. Editing is opt-in.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import type { EditorSettings } from "@/platform/ipc";
import type { DocBackend } from "../backend";
import { openideaHighlightStyle } from "./highlight";
import { openideaTheme } from "./theme";
import { languageDescriptionFor, loadSupport, loadedSupport } from "./languages";
import { fontExtension } from "./setup";
import { tx } from "@/platform/i18n";
import { selectableText } from "@/ui";

export async function previewExtensions(
  path: string,
  settings: EditorSettings | undefined,
  backend?: DocBackend,
  editable = false,
): Promise<Extension> {
  const desc = await languageDescriptionFor(path, undefined, backend);
  const support = desc ? (loadedSupport(desc) ?? (await loadSupport(desc))) : null;
  return [
    fontExtension(settings),
    openideaTheme,
    lineNumbers(),
    highlightSpecialChars(),
    syntaxHighlighting(openideaHighlightStyle),
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    // Read-only previews still support selection, Copy and keyboard focus.
    EditorView.contentAttributes.of({ "aria-label": tx`Preview of ${path}`, class: selectableText, tabindex: "0" }),
    support ?? [],
  ];
}
