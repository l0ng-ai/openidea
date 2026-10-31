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
import { dropConfirm, handleMcpRequest, useMcpConfirms } from "./requests";

export function activate(): () => void {
  const disposers = [
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
    useMcpConfirms.setState({ queue: [] });
  };
}
