/**
 * Settings › Languages & Frameworks › Language Servers: languages on the left,
 * the selected language's tools on the right, grouped by kind (language
 * servers, formatters, debuggers, plugins). Selecting a tool shows its install
 * actions and settings under its table. Settings are staged in the dialog and
 * written on Apply / OK; installs run right away.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { ToolInfo } from "@/bindings";
import { Badge, Button, EmptyState, fileIconName, Icon, IconButton, ProgressBar, SearchField, Spinner, T } from "@/ui";
import { sampleFileName } from "@/platform/fileTypes";
import type { LanguageChoice } from "./backend";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useSettingsForm } from "@/workbench/contributions";
import {
  AlternativesRow,
  languageNames,
  NewServerDialog,
  Section,
  ServerSettings,
  ToolSettings,
  useLanguageChoices,
} from "./ServerSettings";
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

const STATUS_TONE: Record<ToolInfo["status"], "success" | "accent" | "warning"> = {
  installed: "success",
  onPath: "accent",
  custom: "accent",
  missing: "warning",
};

const KINDS: ReadonlyArray<[ToolInfo["kind"], string]> = [
  ["languageServer", "Language Servers"],
  ["formatter", "Formatters"],
  ["debugger", "Debuggers"],
  ["plugin", "Plugins"],
  ["cli", "Command-Line Tools"],
];

/** Tools that serve no language (e.g. the Dev Containers CLI) are listed under this name. */
const OTHER = "Other Tools";

export interface LanguageEntry {
  name: string;
  tools: ToolInfo[];
  /** Tools to install so the language works: a server when none is available, likewise a debugger. */
  missing: ToolInfo[];
  state: "ready" | "partial" | "none";
}

const available = (t: ToolInfo) => t.status !== "missing";

function firstToInstall(tools: readonly ToolInfo[]): ToolInfo | undefined {
  return tools.find((t) => t.canInstall) ?? tools[0];
}

function languageEntry(name: string, tools: ToolInfo[]): LanguageEntry {
  const servers = tools.filter((t) => t.kind === "languageServer");
  const debuggers = tools.filter((t) => t.kind === "debugger");
  const noServer = servers.length > 0 && !servers.some(available);
  const noDebugger = debuggers.length > 0 && !debuggers.some(available);
  const missing = [noServer && firstToInstall(servers), noDebugger && firstToInstall(debuggers)].filter(
    (t): t is ToolInfo => !!t,
  );
  const state = !missing.length ? "ready" : noServer && (noDebugger || !debuggers.length) ? "none" : "partial";
  return { name, tools, missing, state };
}

/** One entry per language the tools serve, by name; tools serving none come last. */
export function groupByLanguage(tools: readonly ToolInfo[]): LanguageEntry[] {
  const byName = new Map<string, ToolInfo[]>();
  for (const t of tools)
    for (const lang of t.languages.length ? t.languages : [OTHER]) {
      const list = byName.get(lang) ?? [];
      list.push(t);
      byName.set(lang, list);
    }
  return [...byName]
    .sort(([a], [b]) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)))
    .map(([name, list]) => languageEntry(name, list));
}

/** Languages whose name or one of whose tools matches `query`; `needsSetup` keeps the ones missing tools. */
export function filterLanguages(langs: readonly LanguageEntry[], query: string, needsSetup: boolean): LanguageEntry[] {
  const q = query.trim().toLowerCase();
  return langs.filter(
    (l) =>
      (!needsSetup || l.missing.length > 0) &&
      (!q ||
        l.name.toLowerCase().includes(q) ||
        l.tools.some((t) => [t.name, t.displayName, t.command].some((s) => s.toLowerCase().includes(q)))),
  );
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
    alternatives: [],
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

/** "1.40.2 · On PATH", or the status alone. */
function statusText(tool: ToolInfo, pending: boolean): string {
  if (pending) return tx("New");
  const status = tx(STATUS_LABEL[tool.status]);
  return tool.version ? `${tool.version} · ${status}` : status;
}

function ToolTable({
  tools,
  selected,
  pending,
  disabled,
  label,
  onSelect,
}: {
  tools: ToolInfo[];
  selected: string | null;
  pending: ReadonlySet<string>;
  disabled: (t: ToolInfo) => boolean;
  label: string;
  onSelect: (name: string) => void;
}) {
  const busy = useTools((s) => s.jobs);
  return (
    <ul className={styles.table} aria-label={label}>
      {tools.map((t) => (
        <li key={t.name} className={clsx(styles.tableRow, t.name === selected && styles.tableRowSelected)}>
          <button
            type="button"
            className={styles.tableMain}
            aria-current={t.name === selected || undefined}
            data-tool={t.name}
            onClick={() => onSelect(t.name)}
          >
            <Badge dot tone={pending.has(t.name) ? "accent" : STATUS_TONE[t.status]}>
              {pending.has(t.name) ? tx("New") : STATUS_LABEL[t.status]}
            </Badge>
            <span className={clsx(styles.toolName, disabled(t) && styles.toolOff)}>{t.displayName}</span>
            {disabled(t) && (
              <span className={styles.tag}>
                <T>Disabled</T>
              </span>
            )}
            <span className={styles.toolStatus}>{statusText(t, pending.has(t.name))}</span>
          </button>
          {t.status === "missing" && t.canInstall && !pending.has(t.name) && (
            <button
              type="button"
              className={styles.linkButton}
              disabled={!!busy[t.name]}
              aria-label={tx`Install ${t.displayName}`}
              onClick={() => void installTool(t.name)}
            >
              <T>Install</T>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The selected tool under its table: install actions, progress, log and settings. */
function ToolDetails({ tool, language, pending }: { tool: ToolInfo; language: string; pending: boolean }) {
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
  const shared = tool.languages.filter((l) => l !== language);
  const others = shared.join(", ");
  return (
    <div className={styles.details} aria-label={`${tool.displayName} details`}>
      <div className={styles.detailsHeader}>
        <div className={styles.detailsText}>
          <span className={styles.detailsTitle}>{tool.displayName}</span>
          {tool.homepage && (
            <a href={tool.homepage} target="_blank" rel="noreferrer">
              <T>Homepage</T>
            </a>
          )}
        </div>
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
      {shared.length > 0 && (
        <div className={styles.comment}>{tx`Also used for ${others}; settings apply to all of them.`}</div>
      )}
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
        <ServerSettings tool={tool} pending={pending} showAlternatives={false} />
      ) : (
        tool.kind === "debugger" && <ToolSettings tool={tool} />
      )}
    </div>
  );
}

/** The language's file-type icon, as in the Project view. */
function LanguageIcon({ name, known }: { name: string; known: readonly LanguageChoice[] }) {
  const lang = known.find((l) => l.name === name);
  const sample = lang ? sampleFileName({ extensions: lang.extensions ?? [], filenames: lang.filenames }) : null;
  return <Icon name={name === OTHER ? "package" : sample ? fileIconName(sample) : "file-text"} size={16} />;
}

const STATE_BADGE: Record<LanguageEntry["state"], ["success" | "warning", string]> = {
  ready: ["success", "Ready"],
  partial: ["warning", "Partly set up"],
  none: ["warning", "Not set up"],
};

function LanguageDetails({
  language,
  selectedTool,
  pending,
  servers,
  known,
  onSelectTool,
}: {
  language: LanguageEntry;
  known: readonly LanguageChoice[];
  selectedTool: string | null;
  pending: ReadonlySet<string>;
  servers: Record<string, ServerEntry>;
  onSelectTool: (name: string) => void;
}) {
  const jobs = useTools((s) => s.jobs);
  const [tone, stateLabel] = STATE_BADGE[language.state];
  const installable = language.missing.filter((t) => t.canInstall && !jobs[t.name]);
  const count = installable.length;
  const missingNames = language.missing.map((t) => t.displayName).join(", ");
  const disabled = (t: ToolInfo) => servers[t.name]?.enabled === false;
  const selected = language.tools.find((t) => t.name === selectedTool) ?? language.tools[0] ?? null;
  return (
    <div className={styles.language} aria-label={tx`${language.name} tools`}>
      <div className={styles.languageHeader}>
        <LanguageIcon name={language.name} known={known} />
        <span className={styles.languageTitle}>{language.name === OTHER ? tx(OTHER) : language.name}</span>
        {language.name !== OTHER && <Badge tone={tone}>{tx(stateLabel)}</Badge>}
        <span className={styles.grow} />
        {installable.length > 0 && (
          <Button size="small" onClick={() => installable.forEach((t) => void installTool(t.name))}>
            {tx`Install Missing (${count})`}
          </Button>
        )}
      </div>
      {language.missing.length > 0 && (
        <div className={styles.banner} role="note">
          {tx`Not installed: ${missingNames}.`}
        </div>
      )}
      {KINDS.map(([kind, title]) => {
        let tools = language.tools.filter((t) => t.kind === kind);
        if (!tools.length) return null;
        // Interchangeable servers: their picker, then the servers in preference order.
        // A group belongs to this language when all of its servers serve it (kmp-lsp is in
        // the Java group and the Kotlin one).
        const names = new Set(tools.map((t) => t.name));
        const groups =
          kind === "languageServer"
            ? [
                ...new Map(
                  tools
                    .filter((t) => t.alternatives.length > 1 && t.alternatives.every((n) => names.has(n)))
                    .map((t) => [t.alternatives.join("\n"), t]),
                ).values(),
              ]
            : [];
        if (groups.length) {
          const order = groups.flatMap((g) => g.alternatives);
          const rank = (t: ToolInfo) => (order.includes(t.name) ? order.indexOf(t.name) : order.length);
          tools = [...tools].sort((a, b) => rank(a) - rank(b));
        }
        return (
          <Section key={kind} title={title}>
            {groups.map((t) => (
              <AlternativesRow key={t.alternatives.join("\n")} tool={t} names={t.alternatives} />
            ))}
            <ToolTable
              tools={tools}
              selected={selected?.name ?? null}
              pending={pending}
              disabled={disabled}
              label={tx(title)}
              onSelect={onSelectTool}
            />
            {selected && tools.includes(selected) && (
              <ToolDetails
                key={selected.name}
                tool={selected}
                language={language.name}
                pending={pending.has(selected.name)}
              />
            )}
          </Section>
        );
      })}
    </div>
  );
}

export function LanguageServersPage() {
  const { tools, loaded, loading, error } = useTools();
  const form = useSettingsForm();
  const [query, setQuery] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
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

  const languages = useMemo(() => groupByLanguage(all), [all]);
  const shown = useMemo(() => filterLanguages(languages, query, needsSetup), [languages, query, needsSetup]);
  // A tool picked outside the list (a server just added) brings its language along.
  const current = shown.find((l) => l.name === selectedLanguage);
  const selected =
    (selectedTool && !current?.tools.some((t) => t.name === selectedTool)
      ? shown.find((l) => l.tools.some((t) => t.name === selectedTool))
      : current) ??
    shown[0] ??
    null;
  const tool = selected?.tools.find((t) => t.name === selectedTool) ?? null;
  const removable = !!tool && (servers[tool.name]?.languages?.length ?? 0) > 0;

  const selectLanguage = (name: string) => {
    setSelectedLanguage(name);
    setSelectedTool(null);
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = selected ? shown.indexOf(selected) : -1;
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    selectLanguage(next.name);
    e.currentTarget.querySelector<HTMLElement>(`[data-language="${CSS.escape(next.name)}"]`)?.focus();
  };

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        {tx(
          "Language servers, formatters and debug adapters for each language. Missing tools can be installed into the IDE's own tools folder; nothing is downloaded until you click Install.",
        )}
      </p>
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
              onClick={() => tool && form.set(serverKey(tool.name), null)}
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
            <IconButton
              icon="filter"
              size="small"
              title="Show Only Languages Missing Tools"
              pressed={needsSetup}
              onClick={() => setNeedsSetup(!needsSetup)}
            />
          </div>
          <SearchField
            className={styles.search}
            value={query}
            onChange={setQuery}
            placeholder="Language or tool"
            aria-label="Filter languages"
          />
          <ul className={styles.list} aria-label={tx("Languages")} onKeyDown={onListKey}>
            {shown.map((l) => (
              <li key={l.name} className={clsx(styles.row, l === selected && styles.rowSelected)}>
                <button
                  type="button"
                  className={styles.rowMain}
                  aria-current={l === selected || undefined}
                  data-language={l.name}
                  onClick={() => selectLanguage(l.name)}
                >
                  <LanguageIcon name={l.name} known={known} />
                  <span className={styles.rowName}>{l.name === OTHER ? tx(OTHER) : l.name}</span>
                  {l.missing.length > 0 && (
                    <span className={styles.rowHint}>
                      {l.state === "none" ? tx("Not set up") : tx`${l.missing.length} missing`}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {loaded && shown.length === 0 && (
              <li className={styles.listEmpty}>
                <T>No languages match.</T>
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
          <LanguageDetails
            key={selected.name}
            language={selected}
            selectedTool={selectedTool}
            pending={pending}
            servers={servers}
            known={known}
            onSelectTool={setSelectedTool}
          />
        ) : (
          <EmptyState className={styles.detailsEmpty} title={loaded ? "No language selected" : "Loading…"} />
        )}
      </div>
      {adding && (
        <NewServerDialog
          existing={all.map((t) => t.name)}
          onClose={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            setNeedsSetup(false);
            setQuery("");
            setSelectedLanguage(null);
            setSelectedTool(name);
          }}
        />
      )}
    </div>
  );
}
