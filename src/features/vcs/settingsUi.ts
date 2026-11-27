/** Writing Version Control settings in place (tool window menus), as the Settings page would. */
import type { SettingsScope } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";

/**
 * Writes one setting, defaulting to the open project's settings when available.
 * A failure keeps the previous value.
 */
export async function saveVcsSetting(
  key: string,
  value: unknown,
  scope: SettingsScope = useProject.getState().project ? "project" : "global",
) {
  const settings = await call(commands.settingsSet(scope, key, JSON.stringify(value))).catch(() => null);
  if (settings) useProject.setState({ settings });
}
