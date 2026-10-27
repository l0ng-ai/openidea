/**
 * Settings › Languages & Frameworks › Language Servers, laid out like the
 * Plugins page: language servers and debug adapters in a list on the left,
 * the selected tool's location, custom path, install actions and server
 * settings on the right. Servers of one's own are added here too.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { ToolInfo } from "@/bindings";
import { Badge, Button, EmptyState, IconButton, Input, ProgressBar, SearchField, Spinner, T } from "@/ui";
import { useProject } from "@/platform/project";
import { toolsBackend } from "./backend";
import { AddServerForm, ServerSettings } from "./ServerSettings";
import {
  cancelInstall,
  installTool,
  refreshTools,
  setCustomPath,
  STATUS_LABEL,
  uninstallTool,
  useTools,
  type InstallJob,
} from "./store";
import styles from "./LanguageServersPage.module.css";
import { tx } from "@/platform/i18n";

type Filter = "all" | "missing" | "installed";

const STATUS_TONE: Record<ToolInfo["status"], "success" | "accent" | "warning"> = {
  installed: "success",
  onPath: "accent",
  custom: "accent",
  missing: "warning",
};

const KIND_LABEL: Record<ToolInfo["kind"], string> = {
  languageServer: "Language server",
  debugger: "Debugger",
  plugin: "Plugin",
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
      <ProgressBar value={job.fraction} aria-label={tx`Installing ${name}`} className={styles.jobBar} />
      <div className={styles.jobLine}>
        <span className={styles.jobMessage} title={job.message ?? undefined}>
          {job.message ?? "Starting…"}
        </span>
        <Button size="small" variant="ghost" onClick={() => cancelInstall(name)}>
          <T>Cancel</T>
        </Button>
      </div>
    </div>
  );
}

function ToolRow({ tool, selected, onSelect }: { tool: ToolInfo; selected: boolean; onSelect: () => void }) {
  const disabled = useProject((s) => s.settings?.languageServers?.[tool.name]?.enabled === false);
  return (
    <li className={clsx(styles.row, selected && styles.rowSelected)}>
      <button
        type="button"
        className={styles.rowMain}
        aria-current={selected || undefined}
        data-tool={tool.name}
        title={`${tool.displayName} — ${tool.languages.join(", ")}`}
        onClick={onSelect}
      >
        <Badge dot tone={STATUS_TONE[tool.status]}>
          {STATUS_LABEL[tool.status]}
        </Badge>
        <span className={styles.rowName}>{tool.displayName}</span>
        {tool.kind !== "languageServer" && (
          <span className={styles.kindTag}>
            <T>{KIND_LABEL[tool.kind]}</T>
          </span>
        )}
        {disabled && (
          <span className={styles.kindTag}>
            <T>Off</T>
          </span>
        )}
        <span className={styles.rowLanguages}>{tool.languages.join(", ")}</span>
      </button>
    </li>
  );
}

/** "Path" field: an executable to launch instead of the detected one, saved when committed. */
function CustomPath({ tool }: { tool: ToolInfo }) {
  const id = useId();
  const saved = tool.status === "custom" || tool.customError ? (tool.path ?? "") : "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (tool.status === "custom" ? saved : "");
  const commit = async (next: string) => {
    setDraft(null);
    if (next.trim() !== saved) await setCustomPath(tool.command, next);
  };
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        <T>Path</T>
      </label>
      <div className={styles.fieldValue}>
        <span className={styles.pathRow}>
          <Input
            id={id}
            mono
            className={styles.pathInput}
            value={value}
            invalid={!!tool.customError}
            placeholder={tool.status !== "custom" && tool.path ? tool.path : "Auto-detect"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== null && void commit(draft)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") void commit(e.currentTarget.value);
              if (e.key === "Escape" && draft !== null) {
                e.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <IconButton
            icon="folder-open"
            size="small"
            title="Browse…"
            onClick={async () => {
              const picked = await toolsBackend().chooseExecutable(`Select ${tool.command}`, value || undefined);
              if (picked) await commit(picked);
            }}
          />
          {tool.status === "custom" && (
            <IconButton icon="close" size="small" title="Use auto-detected" onClick={() => void commit("")} />
          )}
        </span>
        {tool.customError ? (
          <div className={styles.fieldError} role="alert">
            {tool.customError}
          </div>
        ) : (
          <div className={styles.fieldHint}>
            <T>Leave empty to use the IDE-installed copy, else the one on PATH.</T>
          </div>
        )}
      </div>
    </div>
  );
}

function Details({ tool }: { tool: ToolInfo }) {
  const job = useTools((s) => s.jobs[tool.name]);
  const last = useTools((s) => s.logs[tool.name]);
  const [logOpen, setLogOpen] = useState(false);
  const log = job?.lines ?? last?.lines ?? [];
  const lastError = !job && last?.error !== "Cancelled" ? last?.error : null;
  const busy = !!job;
  const manualHint = !tool.canInstall && tool.status === "missing";
  return (
    <div className={styles.details} aria-label={`${tool.displayName} details`}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>
            <span>{tool.displayName}</span>
            <Badge tone={STATUS_TONE[tool.status]}>{STATUS_LABEL[tool.status]}</Badge>
          </div>
          <div className={styles.subtitle}>
            <T>{KIND_LABEL[tool.kind]}</T>
            {tool.languages.length > 0 && <> · {tool.languages.join(", ")}</>}
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        {tool.canInstall && (
          <Button
            size="small"
            variant={tool.status === "missing" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void installTool(tool.name)}
            aria-label={
              tool.status === "installed" ? tx`Reinstall ${tool.displayName}` : tx`Install ${tool.displayName}`
            }
          >
            {tool.status === "installed" ? "Reinstall" : "Install"}
          </Button>
        )}
        {tool.canUninstall && (
          <Button size="small" variant="ghost" disabled={busy} onClick={() => void uninstallTool(tool.name)}>
            <T>Uninstall</T>
          </Button>
        )}
        {log.length > 0 && (
          <Button size="small" variant="ghost" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
            {logOpen ? "Hide install log" : "Show install log"}
          </Button>
        )}
      </div>
      {job && <JobRow name={tool.displayName} job={job} />}
      {lastError && (
        <div className={styles.error} role="alert">
          {lastError}
        </div>
      )}
      {manualHint && (
        <div className={styles.notice} role="note">
          {tool.unavailableReason ?? tool.installHint ?? "Install it manually and put it on PATH."}
        </div>
      )}
      {tool.canInstall && tool.status === "missing" && tool.unavailableReason === null && tool.installMethod && (
        <div className={styles.fieldHint}>
          <T>Installs into the IDE&apos;s own tools folder via</T> {tool.installMethod}.
        </div>
      )}

      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>
            <T>Command</T>
          </span>
          <code className={styles.fieldValue}>{tool.command}</code>
        </div>
        {tool.kind !== "plugin" && <CustomPath key={`${tool.name}:${tool.path ?? ""}`} tool={tool} />}
        {tool.status !== "custom" && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              <T>Location</T>
            </span>
            <code className={clsx(styles.fieldValue, styles.breakAll)}>{tool.path ?? "—"}</code>
          </div>
        )}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>
            <T>Version</T>
          </span>
          <span className={clsx(styles.fieldValue, styles.version)}>{tool.version ?? "—"}</span>
        </div>
        {tool.homepage && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              <T>Homepage</T>
            </span>
            <a
              className={clsx(styles.fieldValue, styles.breakAll)}
              href={tool.homepage}
              target="_blank"
              rel="noreferrer"
            >
              {tool.homepage}
            </a>
          </div>
        )}
      </div>

      {logOpen && log.length > 0 && (
        <pre className={styles.log} aria-label={`${tool.displayName} install log`}>
          {log.join("\n")}
        </pre>
      )}
      {tool.kind === "languageServer" && <ServerSettings tool={tool} />}
    </div>
  );
}

export function LanguageServersPage() {
  const { tools, loaded, loading, error } = useTools();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void refreshTools();
  }, []);

  const shown = useMemo(() => filterTools(tools, query, filter), [tools, query, filter]);
  const ready = shown.filter((t) => t.status !== "missing");
  const missing = shown.filter((t) => t.status === "missing");
  const ordered = [...ready, ...missing];
  const selected = ordered.find((t) => t.name === selectedName) ?? ordered[0] ?? null;
  const missingCount = tools.filter((t) => t.status === "missing").length;

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = selected ? ordered.indexOf(selected) : -1;
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    setAdding(false);
    setSelectedName(next.name);
    e.currentTarget.querySelector<HTMLElement>(`[data-tool="${CSS.escape(next.name)}"]`)?.focus();
  };

  const group = (title: string, list: ToolInfo[]) =>
    list.length > 0 && (
      <>
        <li className={styles.groupHeader} role="presentation">
          <T>{title}</T> <span className={styles.groupCount}>{list.length}</span>
        </li>
        {list.map((t) => (
          <ToolRow
            key={t.name}
            tool={t}
            selected={!adding && t === selected}
            onSelect={() => {
              setAdding(false);
              setSelectedName(t.name);
            }}
          />
        ))}
      </>
    );

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        Language servers and debug adapters used by the IDE. Missing tools can be installed into the IDE&apos;s own
        tools folder; nothing is downloaded until you click Install. Add any other LSP server with +.
      </p>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.side}>
          <div className={styles.toolbar}>
            <SearchField
              className={styles.search}
              value={query}
              onChange={setQuery}
              placeholder="Filter by tool or language"
              aria-label="Filter language servers"
            />
            <IconButton
              icon="plus"
              size="small"
              title="Add Language Server…"
              aria-pressed={adding}
              onClick={() => setAdding(true)}
            />
            {loading ? (
              <Spinner size={14} label="Checking tools" />
            ) : (
              <IconButton
                icon="refresh"
                size="small"
                title="Re-check installed tools"
                onClick={() => void refreshTools()}
              />
            )}
          </div>
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
          <ul className={styles.list} aria-label="Language servers and debug adapters" onKeyDown={onListKey}>
            {group("Available", ready)}
            {group("Missing", missing)}
            {loaded && shown.length === 0 && (
              <li className={styles.listEmpty}>
                <T>No tools match.</T>
              </li>
            )}
            {!loaded && !error && (
              <li className={styles.listEmpty}>
                <T>Checking installed tools…</T>
              </li>
            )}
          </ul>
        </div>
        {adding ? (
          <div className={styles.details}>
            <AddServerForm
              existing={tools.map((t) => t.name)}
              onAdded={(name) => {
                setAdding(false);
                setFilter("all");
                setQuery("");
                setSelectedName(name);
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : selected ? (
          <Details key={selected.name} tool={selected} />
        ) : (
          <EmptyState className={styles.detailsEmpty} title={loaded ? "No tool selected" : "Loading…"} />
        )}
      </div>
    </div>
  );
}

export default LanguageServersPage;
