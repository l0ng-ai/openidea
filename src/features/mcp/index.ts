/**
 * The built-in MCP server's part of a project window: confirmations before a
 * tool runs something, the editor requests it makes (open a file, the open
 * editors), and the status bar widget. Its settings page lives in Settings ›
 * Tools › MCP Server.
 */
import { onIdeEvent } from "@/platform/ipc";
import { registerOverlay, registerStatusItem } from "@/workbench/contributions";
import { McpConfirmHost } from "./ConfirmDialog";
import { McpStatusWidget } from "./McpStatus";
import { denyAll, dropConfirm, handleMcpRequest } from "./requests";

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
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    denyAll();
  };
}
