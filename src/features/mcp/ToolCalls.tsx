// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.frontend/src/toolwindow/McpToolCallsPanel.kt, McpConfigurationPanel.kt, services/McpServiceViewContributor.kt), Apache-2.0.
/**
 * The MCP Server tool window: the recent tool calls (time, tool, client, status,
 * duration, project) with a search and a status filter, the selected call's
 * arguments, error and changed files below; and the server's configuration tab.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { tx, useTx } from "@/platform/i18n";
import type { McpCallOutcome, McpCallRecord } from "@/platform/ipc";
import { useLiveMcpStatus } from "@/platform/mcp";
import { basename } from "@/platform/project";
import { Badge, EmptyState, IconButton, SearchField, Select, T, Tabs } from "@/ui";
import { editorService } from "@/workbench/contributions";
import {
  OUTCOMES,
  changedFilePath,
  formatCallTime,
  formatDuration,
  outcomeLabel,
  prettyArguments,
  refreshCalls,
  useTrackedCalls,
} from "./calls";
import { MCP_SETTINGS_PAGE } from "./model";
import styles from "./ToolCalls.module.css";

type Tab = "calls" | "configuration";
export const useMcpToolWindow = create<{ tab: Tab }>(() => ({ tab: "calls" }));

export function McpToolWindowTabs() {
  const tab = useMcpToolWindow((s) => s.tab);
  const t = useTx();
  return (
    <Tabs
      variant="compact"
      aria-label="MCP Server"
      activeId={tab}
      onSelect={(id) => useMcpToolWindow.setState({ tab: id as Tab })}
      items={[
        { id: "calls", label: t("Tool Calls") },
        { id: "configuration", label: t("Configuration") },
      ]}
    />
  );
}

export function McpToolWindowActions() {
  return <IconButton icon="refresh" size="small" title="Refresh" onClick={() => void refreshCalls()} />;
}

export function McpToolWindow() {
  const tab = useMcpToolWindow((s) => s.tab);
  return tab === "configuration" ? <Configuration /> : <ToolCalls />;
}

const OUTCOME_TONE: Record<McpCallOutcome, "neutral" | "success" | "danger" | "warning"> = {
  inProgress: "neutral",
  success: "success",
  error: "danger",
  cancelled: "warning",
  failed: "danger",
};

/** The calls the search (tool name) and the status filter let through. */
export function filterCalls(calls: readonly McpCallRecord[], text: string, status: McpCallOutcome | "all") {
  const q = text.trim().toLowerCase();
  return calls.filter((c) => (!q || c.tool.toLowerCase().includes(q)) && (status === "all" || c.outcome === status));
}

function ToolCalls() {
  const t = useTx();
  const { calls, loaded, error } = useTrackedCalls();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<McpCallOutcome | "all">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const shown = useMemo(() => filterCalls(calls, query, status), [calls, query, status]);
  const selected = shown.find((c) => c.id === selectedId) ?? null;
  const statusOptions = [
    { value: "all" as const, label: t("All Statuses") },
    ...OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) })),
  ];
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder={t("Search tools")}
          aria-label={t("Search tools")}
          clearable
        />
        <Select
          aria-label="Status"
          value={status}
          options={statusOptions}
          onChange={(v) => setStatus(v as McpCallOutcome | "all")}
        />
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.split}>
        <div className={styles.tableWrap}>
          {loaded && !shown.length ? (
            <EmptyState title="No tool calls recorded" />
          ) : (
            <table className={styles.table} aria-label={t("Tool Calls")}>
              <thead>
                <tr>
                  <th>
                    <T>Time</T>
                  </th>
                  <th>
                    <T>Tool</T>
                  </th>
                  <th>
                    <T>Client</T>
                  </th>
                  <th>
                    <T>Status</T>
                  </th>
                  <th className={styles.number}>
                    <T>Duration</T>
                  </th>
                  <th>
                    <T>Project</T>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr
                    key={c.id}
                    aria-selected={c.id === selectedId}
                    className={clsx(c.id === selectedId && styles.selected)}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <td>{formatCallTime(c.startedAtMs)}</td>
                    <td className={styles.mono}>
                      {c.tool}
                      {c.viaRouter && (
                        <span className={styles.router} data-tooltip={t("Called through execute_tool")}>
                          {t("via router")}
                        </span>
                      )}
                    </td>
                    <td>{c.client}</td>
                    <td>
                      <Badge tone={OUTCOME_TONE[c.outcome]}>{outcomeLabel(c.outcome)}</Badge>
                    </td>
                    <td className={styles.number}>{c.durationMs == null ? "…" : formatDuration(c.durationMs)}</td>
                    <td>{c.project ? basename(c.project) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <CallDetail call={selected} />
      </div>
    </div>
  );
}

function CallDetail({ call }: { call: McpCallRecord | null }) {
  const t = useTx();
  if (!call) return <div className={clsx(styles.detail, styles.placeholder)} />;
  const count = call.changedFiles.length;
  return (
    <div className={styles.detail} aria-label={t("Call details")} role="region">
      <div className={styles.detailTitle}>
        <T>Request</T>
      </div>
      <pre className={styles.code} aria-label={t("Arguments")}>
        {prettyArguments(call.arguments)}
      </pre>
      {call.error && (
        <>
          <div className={styles.detailTitle}>
            <T>Error</T>
          </div>
          <pre className={clsx(styles.code, styles.error)}>{call.error}</pre>
        </>
      )}
      {call.changedFiles.length > 0 && (
        <>
          <div className={styles.detailTitle}>{t`Changed files: ${count}`}</div>
          <ul className={styles.files} aria-label={t("Changed files")}>
            {call.changedFiles.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void editorService().openFile(changedFilePath(f, call.project), { focus: true })}
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Configuration() {
  const status = useLiveMcpStatus();
  const t = useTx();
  const running = !!status?.running;
  const state = running ? tx("Running") : tx("Stopped");
  const clients = running ? status!.clients : [];
  const n = clients.length;
  return (
    <div className={styles.configuration}>
      <div className={styles.detailTitle}>
        <T>MCP Server</T>
      </div>
      <div role="status" aria-label={t("Server status")}>
        {t`Server status: ${state}`}
      </div>
      {running && status?.url && <div className={styles.mono}>{`HTTP Stream: ${status.url}`}</div>}
      {!running && status?.error && <div className={styles.error}>{status.error}</div>}
      {running && (
        <div>{n === 1 ? t("1 active connection") : n ? t`${n} active connections` : t("No active connections")}</div>
      )}
      {clients.map((c) => (
        <div key={`${c.name}@${c.version}`} className={styles.client}>
          {t`${c.name} ${c.version}: ${c.calls} tool calls`}
        </div>
      ))}
      <button
        type="button"
        className={styles.link}
        onClick={() => void executeAction("file.settings", MCP_SETTINGS_PAGE)}
      >
        <T>Open MCP server settings</T>
      </button>
    </div>
  );
}
