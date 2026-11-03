/**
 * The editor a plugin call is about: the window's active text editor, as
 * commands get it (path, language, selections in line / UTF-16 column). Tool
 * windows' renders and events carry it too, so their buttons act on what the
 * user is editing; a custom editor's calls carry its own document instead.
 */
import type { PluginEditor } from "@/bindings";
import { activeEditor } from "@/editor/api";

export function editorContext(): PluginEditor | null {
  const editor = activeEditor();
  if (!editor?.ctx.path) return null;
  const { doc, selection } = editor.view.state;
  const pos = (offset: number) => {
    const line = doc.lineAt(offset);
    return { line: line.number - 1, col: offset - line.from };
  };
  return {
    path: editor.ctx.path,
    language: editor.ctx.language,
    selections: selection.ranges.map((r) => ({ start: pos(r.from), end: pos(r.to) })),
  };
}
