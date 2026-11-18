/**
 * The editor a plugin call is about: the window's active text editor, as
 * commands get it (path, language, selections in line / UTF-16 column). Tool
 * windows' renders and events carry it too, so their buttons act on what the
 * user is editing; a custom editor's calls carry its own document instead.
 *
 * Provided by the workbench (`points.tsx`) so editor-free windows (Settings)
 * do not pull in `@/editor/api` and CodeMirror.
 */
import type { PluginEditor } from "@/bindings";

let provider: (() => PluginEditor | null) | null = null;

export function providePluginEditorContext(fn: () => PluginEditor | null): () => void {
  provider = fn;
  return () => {
    if (provider === fn) provider = null;
  };
}

export function editorContext(): PluginEditor | null {
  return provider?.() ?? null;
}
