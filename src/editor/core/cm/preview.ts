/**
 * Read-only code previews outside editor tabs (Find in Files, bookmarks): the
 * editor's font, colours, line numbers and syntax highlighting, without
 * editing, folding or contributions.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { editorsFor } from "@/editor/api";
import type { EditorSettings } from "@/platform/ipc";
import type { DocBackend } from "../backend";
import { openideaHighlightStyle } from "./highlight";
import { openideaTheme } from "./theme";
import { findLanguageDescription, loadSupport, loadedSupport, uiModeForPath } from "./languages";
import { fontExtension } from "./setup";
import { tx } from "@/platform/i18n";
import { selectableText } from "@/ui";

export async function previewExtensions(
  path: string,
  settings: EditorSettings | undefined,
  backend?: DocBackend,
): Promise<Extension> {
  const open = editorsFor(path)[0]?.ctx;
  // A closed file: its own mode (an Angular project's templates) like an editor would show it.
  const own = open ? null : await backend?.uiModeOf?.(path).catch(() => null);
  const desc = findLanguageDescription(open ? open.uiMode : (own ?? uiModeForPath(path) ?? null), path);
  const support = desc ? (loadedSupport(desc) ?? (await loadSupport(desc))) : null;
  return [
    fontExtension(settings),
    openideaTheme,
    lineNumbers(),
    highlightSpecialChars(),
    syntaxHighlighting(openideaHighlightStyle),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // Not editable, so selection and Copy need the text opted back in and a tab stop.
    EditorView.contentAttributes.of({ "aria-label": tx`Preview of ${path}`, class: selectableText, tabindex: "0" }),
    support ?? [],
  ];
}
