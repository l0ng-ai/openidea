/** One versioned request shared by plugin highlighting, gutter actions and color previews. */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { call, commands, type PluginLanguageVisuals } from "@/platform/ipc";
import { navigationEpoch } from "@/editor/navigationProviders";
const pending = new WeakMap<Text, { epoch: number; doc: number; value: Promise<PluginLanguageVisuals> }>();
export function pluginVisuals(view: EditorView, ctx: EditorDocContext): Promise<PluginLanguageVisuals> {
  const text = view.state.doc;
  const epoch = navigationEpoch();
  const cached = pending.get(text);
  if (cached?.epoch === epoch && cached.doc === ctx.doc) return cached.value;
  const value = whenSynced(view).then(() => call(commands.pluginLanguageVisuals(ctx.doc)));
  pending.set(text, { epoch, doc: ctx.doc, value });
  return value;
}
