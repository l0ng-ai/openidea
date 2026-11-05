// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/McpClientDetector.kt and the terminal promotion's notifications), Apache-2.0.
/**
 * When a project window starts with the MCP server enabled: a notification for
 * clients whose configuration points at another port (Fix Configuration), and
 * one for clients installed but not configured (Auto-Configure). Both offer the
 * settings; "Don't Show Again" turns off the MCP Server notification group.
 */
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, type McpDetectedClient } from "@/platform/ipc";
import { MCP_CLIENT_NAMES } from "@/platform/mcp";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { MCP_SETTINGS_PAGE, savedMcpSettings } from "./model";

export const PORT_MISMATCH_KEY = "mcp.clients.portMismatch";
export const UNCONFIGURED_KEY = "mcp.clients.unconfigured";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const names = (list: readonly McpDetectedClient[]) =>
  [...new Set(list.map((d) => MCP_CLIENT_NAMES[d.client] ?? d.client))].join(", ");

/** Writes the configuration of each detected client again (its project's file, or the user's). */
async function configure(list: readonly McpDetectedClient[]): Promise<void> {
  const done: McpDetectedClient[] = [];
  const failed: string[] = [];
  for (const d of list) {
    try {
      if (d.project) await call(commands.mcpConfigureProjectClient(d.client, d.project));
      else await call(commands.mcpConfigureClient(d.client));
      done.push(d);
    } catch (e) {
      failed.push(`${MCP_CLIENT_NAMES[d.client] ?? d.client}: ${errorText(e)}`);
    }
  }
  if (done.length) {
    const configured = names(done);
    notifications().notify({
      level: "info",
      title: "Clients have been autoconfigured",
      body: tx`Autoconfiguration complete. The following clients were configured: ${configured}. The clients may need to be restarted for the changes to take effect.`,
      key: UNCONFIGURED_KEY,
      group: "mcp",
    });
  }
  if (failed.length) {
    const reason = failed.join("; ");
    notifications().notify({
      level: "error",
      title: tx`Autoconfiguration can't be completed: ${reason}`,
      key: PORT_MISMATCH_KEY,
      group: "mcp",
    });
  }
}

const openSettings = () => ({
  label: tx("Open MCP Settings"),
  run: () => void executeAction("file.settings", MCP_SETTINGS_PAGE),
});

/** Detects the clients for `project` and shows what needs the user (nothing while the server is off). */
export async function checkClients(project: string | null): Promise<void> {
  if (!isTauri() || !savedMcpSettings().enabled) return;
  let detected: McpDetectedClient[];
  try {
    detected = await call(commands.mcpDetectClients(project));
  } catch {
    return;
  }
  const stale = detected.filter((d) => d.configured === true && !d.portCorrect);
  const unconfigured = detected.filter((d) => d.project == null && d.configured !== true);
  if (stale.length) {
    const clients = names(stale);
    notifications().notify({
      level: "warning",
      title: "Port mismatch detected – please reconfigure",
      body: tx`Update the OpenIDEA MCP Server configuration in ${clients} because it points to a different IDE port.`,
      key: PORT_MISMATCH_KEY,
      group: "mcp",
      actions: [{ label: tx("Fix Configuration"), run: () => void configure(stale) }, openSettings()],
    });
  }
  if (unconfigured.length) {
    const clients = names(unconfigured);
    notifications().notify({
      level: "info",
      title: "MCP Server",
      body: tx`The following MCP clients are not yet configured: ${clients}.`,
      key: UNCONFIGURED_KEY,
      group: "mcp",
      actions: [{ label: tx("Auto-Configure"), run: () => void configure(unconfigured) }, openSettings()],
    });
  }
}

/** Checks once per project this window opens, when it is known. */
export function watchClientDetection(): () => void {
  let checked: string | null = null;
  const sync = (root: string | null | undefined) => {
    if (!root || root === checked) return;
    checked = root;
    void checkClients(root);
  };
  sync(useProject.getState().project?.root);
  return useProject.subscribe((s) => sync(s.project?.root));
}
