/**
 * Status bar widget while the MCP server is enabled: running / failed, the URL
 * and clients as tooltip; opens its settings. Whether it is enabled comes from
 * the live status (the server follows the global settings, not this project's):
 * it runs, or reports why it could not start.
 */
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import type { McpStatus } from "@/platform/ipc";
import { useLiveMcpStatus } from "@/platform/mcp";
import { Icon } from "@/ui";
import { MCP_SETTINGS_PAGE } from "./model";
import styles from "./Mcp.module.css";

/** The widget's tooltip: the state, then each connected client. */
export function statusTooltip(status: McpStatus | null, t: ReturnType<typeof useTx>): string {
  const lines: string[] = [];
  if (status?.running && status.url) lines.push(t`MCP Server running at ${status.url}`);
  else if (status?.error) lines.push(t`MCP Server not running: ${status.error}`);
  else lines.push(t("MCP Server not running"));
  if (status?.running) {
    if (!status.clients.length) lines.push(t("No clients connected"));
    for (const c of status.clients) {
      const calls = c.calls;
      lines.push(t`${c.name} ${c.version}: ${calls} tool calls`);
    }
  }
  return lines.join(" · ");
}

export function McpStatusWidget() {
  const status = useLiveMcpStatus();
  return status?.running || status?.error ? <Widget status={status} /> : null;
}

function Widget({ status }: { status: McpStatus }) {
  const t = useTx();
  const failed = !status.running;
  return (
    <button
      type="button"
      className={clsx(styles.statusItem, failed && styles.statusError)}
      aria-label={t("MCP Server")}
      data-tooltip={statusTooltip(status, t)}
      onClick={() => void executeAction("file.settings", MCP_SETTINGS_PAGE)}
    >
      <Icon name={failed ? "warning" : "plugin"} size={13} />
      MCP
      {status.running && status.clients.length > 0 && <span>{status.clients.length}</span>}
    </button>
  );
}
