/**
 * Completion in the Arguments field of a plugin's own run configuration (plugin API 1.18):
 * the owning plugin answers for the text and caret, and each item replaces one UTF-16 range.
 */
import { call, commands, type RunConfig, type RunConfigCompletion } from "@/platform/ipc";

/** A configuration a plugin provides (`plugin:<plugin>:<id>`), also a user's override of one. */
export function pluginOwnedConfig(config: Pick<RunConfig, "id" | "kind">): boolean {
  return config.kind === "plugin" && config.id.startsWith("plugin:");
}

/** `text` with `item` applied, and where the caret goes (both in UTF-16 units, as JS strings are). */
export function applyCompletion(text: string, item: RunConfigCompletion): { text: string; caret: number } {
  const start = Math.min(item.replaceStart, text.length);
  const end = Math.max(start, Math.min(item.replaceEnd, text.length));
  return { text: text.slice(0, start) + item.insert + text.slice(end), caret: start + item.insert.length };
}

/** The plugin's completions for the Arguments field; none when it has none or fails. */
export async function completeArguments(configId: string, text: string, caret: number): Promise<RunConfigCompletion[]> {
  try {
    return await call(commands.pluginRunConfigurationComplete(configId, "arguments", text, caret));
  } catch {
    // The field stays usable when the provider fails or the configuration is gone.
    return [];
  }
}
