/**
 * The built-in MCP server's part of a project window: confirmations before a
 * tool runs something, the editor requests it makes (open a file, the open
 * editors), the status bar widget and its popup, the MCP Server tool window
 * (while the server is enabled), Export to Markdown, and the notifications about
 * clients to configure. Its settings pages live in Settings › Tools › MCP Server.
 */
import { registerActions } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { validateMcp } from "@/platform/mcp";
import { useProject } from "@/platform/project";
import { registerOverlay, registerStatusItem, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { McpConfirmHost } from "./ConfirmDialog";
import { watchClientDetection } from "./detection";
import { exportToolsMarkdown } from "./exportTools";
import { McpStatusWidget } from "./McpStatus";
import { MCP_TOOL_WINDOW } from "./model";
import { denyAll, dropConfirm, handleMcpRequest } from "./requests";
import { McpToolWindow, McpToolWindowActions, McpToolWindowTabs } from "./ToolCalls";

const mcpEnabled = () => validateMcp(useProject.getState().settings?.mcp).enabled;

/** The MCP Server tool window exists while the server is enabled. */
function trackToolWindow(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (enabled: boolean) => {
    if (enabled && !dispose) {
      dispose = registerToolWindow({
        id: MCP_TOOL_WINDOW,
        title: "MCP Server",
        icon: "plugin",
        anchor: "bottom",
        stripe: "onUse",
        order: 60,
        component: McpToolWindow,
        headerContent: McpToolWindowTabs,
        headerActions: McpToolWindowActions,
      });
    } else if (!enabled && dispose) {
      dispose();
      dispose = null;
    }
  };
  sync(mcpEnabled());
  const unsub = useProject.subscribe(() => sync(mcpEnabled()));
  return () => {
    unsub();
    dispose?.();
  };
}

export function activate(): () => void {
  // Nobody is left to answer once the window closes or reloads.
  const onUnload = () => denyAll();
  window.addEventListener("pagehide", onUnload);
  window.addEventListener("beforeunload", onUnload);
  const disposers = [
    () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    },
    registerOverlay({ id: "mcp.confirm", component: McpConfirmHost }),
    onIdeEvent("mcpRequest", (e) => void handleMcpRequest(e.id, e.request)),
    onIdeEvent("mcpRequestDone", (e) => dropConfirm(e.id)),
    registerStatusItem({
      id: "mcp.status",
      align: "right",
      priority: 4,
      title: "MCP Server",
      component: McpStatusWidget,
    }),
    trackToolWindow(),
    registerActions([
      {
        id: "mcp.exportTools",
        title: "Export MCP Tools to Markdown…",
        description: "Save MCP tools information as Markdown",
        category: "Tools",
        icon: "export",
        keywords: ["mcp", "tools", "markdown"],
        run: () => exportToolsMarkdown(),
      },
      {
        id: "mcp.showToolCalls",
        title: "Show MCP Tool Calls",
        description: "The recent calls of the MCP server's tools",
        category: "Tools",
        icon: "plugin",
        when: "projectOpen",
        keywords: ["mcp", "tool calls", "agent"],
        run: () => {
          if (mcpEnabled()) toolWindowService().show(MCP_TOOL_WINDOW, true);
        },
      },
    ]),
    watchClientDetection(),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    denyAll();
  };
}
