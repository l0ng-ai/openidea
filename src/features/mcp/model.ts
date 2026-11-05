import { call, commands } from "@/platform/ipc";
import { validateMcp, type McpSettingsValid } from "@/platform/mcp";
import { useProject } from "@/platform/project";

/** Settings › Tools › MCP Server (`features/settings/pages/mcp.tsx`). */
export const MCP_SETTINGS_PAGE = "tools.mcpServer";
/** Settings › Tools › MCP Server › Exposed Tools (`features/settings/pages/mcpTools.tsx`). */
export const MCP_TOOLS_PAGE = "tools.mcpServer.exposedTools";
/** The MCP Server tool window. */
export const MCP_TOOL_WINDOW = "mcpServer";

/** The saved MCP settings of this window (global: the server follows them in every window). */
export function savedMcpSettings(): McpSettingsValid {
  return validateMcp(useProject.getState().settings?.mcp);
}

/** Saves one global MCP setting at once (the status bar popup has no Apply). */
export async function setGlobalMcpSetting<K extends keyof McpSettingsValid>(
  key: K,
  value: McpSettingsValid[K],
): Promise<void> {
  const settings = await call(commands.settingsSet("global", `mcp.${key}`, JSON.stringify(value)));
  useProject.setState({ settings });
}
