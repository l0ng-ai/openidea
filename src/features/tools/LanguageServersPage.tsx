/** Settings › Languages & Frameworks › Language Servers: status + install/uninstall of LSP servers and debug adapters. */
import { Fragment, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { ToolInfo } from "@/bindings";
import { Badge, Button, IconButton, ProgressBar, SearchField, Spinner } from "@/ui";
import {
  cancelInstall,
  installTool,
  refreshTools,
  STATUS_LABEL,
  uninstallTool,
  useTools,
  type InstallJob,
} from "./store";
import styles from "./LanguageServersPage.module.css";

type Filter = "all" | "missing" | "installed";

const STATUS_TONE: Record<ToolInfo["status"], "success" | "accent" | "warning"> = {
  installed: "success",
  onPath: "accent",
  missing: "warning",
};

export function filterTools(tools: readonly ToolInfo[], query: string, filter: Filter): ToolInfo[] {
  const q = query.trim().toLowerCase();
  return tools.filter((t) => {
    if (filter === "missing" && t.status !== "missing") return false;
    if (filter === "installed" && t.status === "missing") return false;
    if (!q) return true;
    return [t.name, t.displayName, t.command, ...t.languages].some((s) => s.toLowerCase().includes(q));
  });
}

function JobRow({ name, job }: { name: string; job: InstallJob }) {
  return (
    <div className={styles.job}>
      <ProgressBar value={job.fraction} aria-label={`Installing ${name}`} className={styles.jobBar} />
      <div className={styles.jobLine}>
        <span className={styles.jobMessage} title={job.message ?? undefined}>
          {job.message ?? "Starting…"}
        </span>
        <Button size="small" variant="ghost" onClick={() => cancelInstall(name)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Actions({
  tool,
  busy,
  onToggleLog,
  hasLog,
  logOpen,
}: {
  tool: ToolInfo;
  busy: boolean;
  hasLog: boolean;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const label = tool.displayName;
  return (
    <div className={styles.actions}>
      {tool.canInstall && (
        <Button
          size="small"
          variant={tool.status === "missing" ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => void installTool(tool.name)}
          aria-label={`${tool.status === "missing" ? "Install" : tool.status === "installed" ? "Reinstall" : "Install managed copy of"} ${label}`}
        >
          {tool.status === "missing" ? "Install" : tool.status === "installed" ? "Reinstall" : "Install"}
        </Button>
      )}
      {tool.canUninstall && (
        <Button
          size="small"
          variant="ghost"
          disabled={busy}
          onClick={() => void uninstallTool(tool.name)}
          aria-label={`Uninstall ${label}`}
        >
          Uninstall
        </Button>
      )}
      {hasLog && (
        <IconButton
          icon="terminal"
          size="small"
          title={logOpen ? "Hide install log" : "Show install log"}
          pressed={logOpen}
          onClick={onToggleLog}
        />
      )}
    </div>
  );
}

export function LanguageServersPage() {
  const { tools, loaded, loading, error, jobs, logs } = useTools();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openLog, setOpenLog] = useState<string | null>(null);

  useEffect(() => {
    void refreshTools();
  }, []);

  const shown = useMemo(() => filterTools(tools, query, filter), [tools, query, filter]);
  const missingCount = tools.filter((t) => t.status === "missing").length;

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        Language servers and debug adapters used by the IDE. Missing tools can be installed into the IDE&apos;s own
        tools folder; nothing is downloaded until you click Install.
      </p>
      <div className={styles.toolbar}>
        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder="Filter by tool or language"
          aria-label="Filter language servers"
        />
        <div className={styles.segmented} role="radiogroup" aria-label="Show">
          {(["all", "missing", "installed"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={clsx(styles.segment, filter === f && styles.segmentOn)}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "missing" ? `Missing (${missingCount})` : "Available"}
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        {loading && <Spinner size={14} label="Checking tools" />}
        <IconButton
          icon="refresh"
          title="Re-check installed tools"
          onClick={() => void refreshTools()}
          disabled={loading}
        />
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="Language servers and debug adapters">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Languages</th>
              <th scope="col" className={styles.fitHead}>
                Status
              </th>
              <th scope="col" className={styles.fitHead}>
                Version
              </th>
              <th scope="col" className={styles.actionsHead}>
                <span className={styles.visuallyHidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              const job = jobs[t.name];
              const log = job?.lines ?? logs[t.name]?.lines ?? [];
              const lastError = !job ? logs[t.name]?.error : null;
              const logOpen = openLog === t.name;
              return (
                <Fragment key={t.name}>
                  <tr className={styles.row} data-tool={t.name}>
                    <td>
                      <div className={styles.toolName}>
                        <span className={styles.display}>{t.displayName}</span>
                        {t.kind === "debugger" && <span className={styles.kindTag}>Debugger</span>}
                        {t.kind === "plugin" && <span className={styles.kindTag}>Plugin</span>}
                      </div>
                      {(t.path ?? (t.command !== t.displayName ? t.command : null)) && (
                        <div className={styles.sub} title={t.path ?? undefined}>
                          {t.path ?? t.command}
                        </div>
                      )}
                    </td>
                    <td className={styles.languages}>{t.languages.join(", ") || "—"}</td>
                    <td>
                      <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                    </td>
                    <td className={styles.version}>{t.version ?? "—"}</td>
                    <td>
                      <Actions
                        tool={t}
                        busy={!!job}
                        hasLog={log.length > 0}
                        logOpen={logOpen}
                        onToggleLog={() => setOpenLog(logOpen ? null : t.name)}
                      />
                    </td>
                  </tr>
                  {(job || lastError || logOpen || (!t.canInstall && t.status === "missing")) && (
                    <tr className={styles.detailRow}>
                      <td colSpan={5}>
                        {job && <JobRow name={t.displayName} job={job} />}
                        {lastError && lastError !== "Cancelled" && (
                          <div className={styles.rowError} role="alert">
                            {lastError}
                          </div>
                        )}
                        {!t.canInstall && t.status === "missing" && (
                          <div className={styles.hint}>
                            {t.unavailableReason ?? t.installHint ?? "Install it manually and put it on PATH."}
                          </div>
                        )}
                        {logOpen && log.length > 0 && (
                          <pre className={styles.log} aria-label={`${t.displayName} install log`}>
                            {log.join("\n")}
                          </pre>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {loaded && shown.length === 0 && <div className={styles.empty}>No tools match.</div>}
        {!loaded && !error && <div className={styles.empty}>Checking installed tools…</div>}
      </div>
    </div>
  );
}

export default LanguageServersPage;
