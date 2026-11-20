/**
 * Client side of the first-party UI extension points: how each validated
 * declaration is projected onto the workbench, and how its items appear on
 * the plugin details page. One `defineUiPoint` per contribution type.
 */
import type { PluginEditor } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { defineCoreUiPoints } from "./corePoints";
import { providePluginEditorContext } from "./editorContext";
import { defineViewUiPoints } from "./uiPoints";

export { commandArgs, pluginActionId } from "./corePoints";

function activePluginEditor(): PluginEditor | null {
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

/** Registers the client side of every first-party UI point. */
export function defineBuiltinUiPoints(): () => void {
  const disposers = [providePluginEditorContext(activePluginEditor), defineCoreUiPoints(), defineViewUiPoints()];
  return () => disposers.reverse().forEach((d) => d());
}
