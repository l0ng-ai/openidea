/**
 * Settings › Languages & Frameworks › Language Servers, laid out like the
 * Plugins page: language servers and debug adapters in a list on the left
 * (+ adds a server of one's own, − removes it), the selected tool's install
 * actions and settings on the right. Settings are staged in the dialog and
 * written on Apply / OK; installs run right away.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { ToolInfo } from "@/bindings";
import { Badge, Button, EmptyState, IconButton, ProgressBar, SearchField, Select, Spinner, T } from "@/ui";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useSettingsForm } from "@/workbench/contributions";
import { languageNames, NewServerDialog, ServerSettings, ToolSettings, useLanguageChoices } from "./ServerSettings";
import { serverKey, type ServerEntry } from "./serverConfig";
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
import { tx } from "@/platform/i18n";

type Filter = "all" | "missing" | "installed";

const PYTHON_ANALYZERS = ["basedpyright", "pyright", "ty"] as const;
type PythonAnalyzer = (typeof PYTHON_ANALYZERS)[number] | "auto" | "none" | "custom";

function selectedPythonAnalyzer(servers: Record<string, ServerEntry>): PythonAnalyzer {
  const enabled = PYTHON_ANALYZERS.filter((name) => servers[name]?.enabled !== false);
  if (enabled.length === PYTHON_ANALYZERS.length) return "auto";
  if (enabled.length === 0) return "none";
  return enabled.length === 1 ? enabled[0]! : "custom";
}

const PYTHON_ANALYZER_OPTIONS: ReadonlyArray<{ value: PythonAnalyzer; label: string; disabled?: boolean }> = [
  { value: "auto", label: "Automatic (first available)" },
  { value: "basedpyright", label: "basedpyright" },
  { value: "pyright", label: "Pyright" },
  { value: "ty", label: "ty" },
  { value: "none", label: "None" },
  { value: "custom", label: "Custom combination", disabled: true },
];

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

/** A server added in this dialog, listed before Apply checks its executable. */
function pendingTool(name: string, entry: ServerEntry, languages: string[]): ToolInfo {
  return {
    name,
    displayName: name,
    kind: "languageServer",
    command: entry.command ?? "",
    languages,
    status: "missing",
    path: null,
    version: null,
    installMethod: null,
    canInstall: false,
    unavailableReason: null,
    canUninstall: false,
    installHint: null,
    homepage: null,
    customError: null,
    defaultArgs: [],
    defaultInitializationOptions: null,
  };
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

function ToolRow({
  tool,
  selected,
  off,
  pending,
  onSelect,
}: {
  tool: ToolInfo;
  selected: boolean;
  off: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  return (
    <li className={clsx(styles.row, selected && styles.rowSelected)}>
      <button
        type="button"
        className={clsx(styles.rowMain, off && styles.rowOff)}
        aria-current={selected || undefined}
        data-tool={tool.name}
        title={`${tool.displayName} — ${tool.languages.join(", ")}`}
        onClick={onSelect}
      >
        <Badge dot tone={pending ? "accent" : STATUS_TONE[tool.status]}>
          {pending ? tx("New") : STATUS_LABEL[tool.status]}
        </Badge>
        <span className={styles.rowName}>{tool.displayName}</span>
        {pending && (
          <span className={styles.kindTag}>
            <T>New</T>
          </span>
        )}
        {tool.kind !== "languageServer" && (
          <span className={styles.kindTag}>
            <T>{KIND_LABEL[tool.kind]}</T>
          </span>
        )}
        {off && (
          <span className={styles.kindTag}>
            <T>Disabled</T>
          </span>
        )}
        <span className={styles.rowLanguages}>{tool.languages.join(", ")}</span>
      </button>
    </li>
  );
}

function Details({ tool, pending }: { tool: ToolInfo; pending: boolean }) {
  const job = useTools((s) => s.jobs[tool.name]);
  const last = useTools((s) => s.logs[tool.name]);
  const [logOpen, setLogOpen] = useState(false);
  const log = job?.lines ?? last?.lines ?? [];
  const lastError = !job && last?.error !== "Cancelled" ? last?.error : null;
  const busy = !!job;
  // Servers and adapters show the install hint next to their executable.
  const manualHint =
    !pending &&
    !tool.canInstall &&
    tool.status === "missing" &&
    (tool.unavailableReason ?? (tool.kind === "plugin" ? tool.installHint : null));
  return (
    <div className={styles.details} aria-label={`${tool.displayName} details`}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>
            <span>{tool.displayName}</span>
            {pending ? (
              <Badge tone="accent">
                <T>New</T>
              </Badge>
            ) : (
              <Badge tone={STATUS_TONE[tool.status]}>{STATUS_LABEL[tool.status]}</Badge>
            )}
          </div>
          <div className={styles.subtitle}>
            <T>{KIND_LABEL[tool.kind]}</T>
            {tool.version && <> · {tool.version}</>}
            {tool.homepage && (
              <>
                {" · "}
                <a href={tool.homepage} target="_blank" rel="noreferrer">
                  <T>Homepage</T>
                </a>
              </>
            )}
          </div>
        </div>
        <div className={styles.actions}>
          {tool.canInstall && (
            <Button
              size="small"
              variant={tool.status === "missing" ? "primary" : "secondary"}
              disabled={busy}
              title={
                tool.installMethod ? tx`Installs into the IDE's own tools folder via ${tool.installMethod}` : undefined
              }
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
        </div>
      </div>
      {job && <JobRow name={tool.displayName} job={job} />}
      {lastError && (
        <div className={styles.error} role="alert">
          {lastError}
        </div>
      )}
      {manualHint && (
        <div className={styles.notice} role="note">
          {manualHint}
        </div>
      )}
      {log.length > 0 && (
        <div>
          <button
            type="button"
            className={styles.linkButton}
            aria-expanded={logOpen}
            onClick={() => setLogOpen(!logOpen)}
          >
            {logOpen ? tx("Hide install log") : tx("Show install log")}
          </button>
          {logOpen && (
            <pre className={styles.log} aria-label={`${tool.displayName} install log`}>
              {log.join("\n")}
            </pre>
          )}
        </div>
      )}

      {tool.kind === "languageServer" ? (
        <ServerSettings tool={tool} pending={pending} />
      ) : (
        tool.kind === "debugger" && <ToolSettings tool={tool} />
      )}
    </div>
  );
}

export function LanguageServersPage() {
  const { tools, loaded, loading, error } = useTools();
  const form = useSettingsForm();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const known = useLanguageChoices();
  const staged = form.useValue("languageServers") as Record<string, ServerEntry> | undefined;
  const servers = useMemo(() => staged ?? {}, [staged]);
  const applied = useProject((s) => s.settings?.languageServers);

  useEffect(() => {
    void refreshTools();
    // Applied paths and servers change what is found and listed.
    return onIdeEvent("settingsChanged", (e) => {
      if (!e.key || /^(tools|languageServers)(\.|$)/.test(e.key)) void refreshTools();
    });
  }, []);

  // The backend's list, minus servers removed here and plus servers added here (until Apply).
  const { all, pending } = useMemo(() => {
    const isCustom = (e: ServerEntry | undefined) => (e?.languages?.length ?? 0) > 0;
    const list = tools.filter((t) => !isCustom(applied?.[t.name]) || isCustom(servers[t.name]));
    const added = new Set<string>();
    for (const [name, entry] of Object.entries(servers)) {
      if (!isCustom(entry) || list.some((t) => t.name === name)) continue;
      list.push(pendingTool(name, entry, languageNames(entry.languages ?? [], known)));
      added.add(name);
    }
    return { all: list, pending: added };
  }, [tools, servers, applied, known]);

  const shown = useMemo(() => filterTools(all, query, filter), [all, query, filter]);
  const ready = shown.filter((t) => t.status !== "missing");
  const missing = shown.filter((t) => t.status === "missing");
  const ordered = [...ready, ...missing];
  const selected = ordered.find((t) => t.name === selectedName) ?? ordered[0] ?? null;
  const missingCount = all.filter((t) => t.status === "missing").length;
  const removable = !!selected && (servers[selected.name]?.languages?.length ?? 0) > 0;

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = selected ? ordered.indexOf(selected) : -1;
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
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
            selected={t === selected}
            off={servers[t.name]?.enabled === false}
            pending={pending.has(t.name)}
            onSelect={() => setSelectedName(t.name)}
          />
        ))}
      </>
    );

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        {tx(
          "Language servers and debug adapters used by the IDE. Missing tools can be installed into the IDE's own tools folder; nothing is downloaded until you click Install.",
        )}
      </p>
      <div className={styles.pythonAnalyzer}>
        <div className={styles.pythonAnalyzerRow}>
          <span>
            <T>Python language server</T>
          </span>
          <Select
            aria-label="Python language server"
            value={selectedPythonAnalyzer(servers)}
            options={PYTHON_ANALYZER_OPTIONS}
            onChange={(selected) => {
              if (selected === "custom") return;
              for (const name of PYTHON_ANALYZERS) {
                const on = selected === "auto" || selected === name;
                // Same as each server's own checkbox: on is the default, so only a project spells it out.
                form.set(serverKey(name, "enabled"), on ? (form.scope === "project" ? true : null) : false);
              }
            }}
          />
        </div>
        <p className={styles.pythonAnalyzerHint}>
          <T>Only one of these built-in Python analyzers runs at a time.</T>
        </p>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.side}>
          <div className={styles.toolbar}>
            <IconButton icon="plus" size="small" title="Add Language Server…" onClick={() => setAdding(true)} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Language Server"
              disabled={!removable}
              onClick={() => selected && form.set(serverKey(selected.name), null)}
            />
            <span className={styles.toolbarSep} aria-hidden />
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
            <SearchField
              className={styles.search}
              value={query}
              onChange={setQuery}
              placeholder="Filter by tool or language"
              aria-label="Filter language servers"
            />
          </div>
          <div className={styles.segmented} role="radiogroup" aria-label={tx("Show")}>
            {(["all", "missing", "installed"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                className={clsx(styles.segment, filter === f && styles.segmentOn)}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? tx("All") : f === "missing" ? tx`Missing (${missingCount})` : tx("Available")}
              </button>
            ))}
          </div>
          <ul className={styles.list} aria-label={tx("Language servers and debug adapters")} onKeyDown={onListKey}>
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
        {selected ? (
          <Details key={selected.name} tool={selected} pending={pending.has(selected.name)} />
        ) : (
          <EmptyState className={styles.detailsEmpty} title={loaded ? "No tool selected" : "Loading…"} />
        )}
      </div>
      {adding && (
        <NewServerDialog
          existing={all.map((t) => t.name)}
          onClose={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            setFilter("all");
            setQuery("");
            setSelectedName(name);
          }}
        />
      )}
    </div>
  );
}
