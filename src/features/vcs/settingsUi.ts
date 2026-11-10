/** Writing Version Control settings in place (tool window menus), as the Settings page would. */
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";

/**
 * Writes one setting of the open project, or of the user's settings without one.
 * A failure keeps the previous value.
 */
export async function saveVcsSetting(key: string, value: unknown) {
  const scope = useProject.getState().project ? "project" : "global";
  const settings = await call(commands.settingsSet(scope, key, JSON.stringify(value))).catch(() => null);
  if (settings) useProject.setState({ settings });
}
