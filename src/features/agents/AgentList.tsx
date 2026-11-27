/**
 * Agent Setup lists every agent, with those this machine can run first
 * (built in, installed from the ACP Registry, or defined in an agent file), then those it
 * can install. The selected agent's page holds its actions, the settings its new tasks
 * start with, and how it is launched. Launch edits are staged until Apply; installs run in
 * the background and keep running after the page closes.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentConfigOption,
  AgentModelCatalog,
  AgentProvider,
  AgentRegistry,
  CopilotAuthStatus,
  CustomAgentInput,
  RegistryAgent,
  RequestId,
} from "@/bindings";
import { isCancelled, nextRequestId } from "@/platform/ipc";
import { tx, useTxTemplate } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import clsx from "clsx";
import {
  Button,
  copyText,
  Dialog,
  Icon,
  IconButton,
  Input,
  List,
  ProgressBar,
  SearchField,
  Select,
  Spinner,
  T,
} from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { AgentSignInDialog, type SignInTarget } from "./AgentSignInDialog";
import { LocalCliUpdate } from "./LocalCliUpdate";
import { approvalDefaults, cursorModelDefaults, isPerModelOption } from "./composerModel";
import { providerIcon, slugifyId } from "./model";
import { useAgents } from "./store";
import {
  DISTRIBUTION_LABEL,
  afterInstall,
  afterRemove,
  matchesQuery,
  sortAgents,
  type CommandsBackend,
  type RegistryBackend,
} from "./registry";
import styles from "./AgentList.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const COPILOT_GITHUB_ACCOUNT_ENV = "OPENIDEA_COPILOT_GITHUB_ACCOUNT";

const launchEnv = (env: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name !== COPILOT_GITHUB_ACCOUNT_ENV));

/** How often the page checks on installs it did not start. */
const BACKGROUND_POLL_MS = 1500;

/** An agent of the list: one this machine knows (`provider`), one of the registry, or both. */
interface Agent {
  id: string;
  name: string;
  provider: AgentProvider | null;
  registry: RegistryAgent | null;
}

type Row = { section: string } | Agent;
const isSection = (r: Row): r is { section: string } => "section" in r;

interface Job {
  id: string;
  /** Absent for an install this page did not start (stopped from the background tasks). */
  request: RequestId | null;
  fraction: number | null;
  message: string;
}

const runnable = (a: Agent) =>
  a.provider
    ? a.provider.installed || a.provider.source.kind !== "builtin" || a.provider.commandOverridden
    : a.registry?.installed != null;

function matches(a: Agent, query: string): boolean {
  if (a.registry) return matchesQuery(a.registry, query);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${a.name} ${a.id}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The list's rows: runnable agents in the order the backend gives them, then the ones that
 * can be installed (built-ins not found first, then the registry's), each under a header.
 */
export function agentRows(providers: AgentProvider[], registry: RegistryAgent[], query: string): Row[] {
  const byId = new Map(registry.map((r) => [r.id, r]));
  const known = new Set(providers.map((p) => p.id));
  const all: Agent[] = [
    ...providers.map((p) => ({ id: p.id, name: p.name, provider: p, registry: byId.get(p.id) ?? null })),
    ...sortAgents(registry.filter((r) => !known.has(r.id))).map((r) => ({
      id: r.id,
      name: r.name,
      provider: null,
      registry: r,
    })),
  ].filter((a) => matches(a, query));
  const installed = all.filter(runnable);
  const available = all.filter((a) => !runnable(a));
  return [
    ...(installed.length ? [{ section: "Installed" }, ...installed] : []),
    ...(available.length ? [{ section: "Available" }, ...available] : []),
  ];
}

/** Live registry update version once loaded, falling back to the cached provider snapshot before it arrives. */
function registryUpdate(provider: AgentProvider | null, registry?: RegistryAgent | null): string | null {
  if (provider && provider.source.kind !== "registry") return null;
  if (registry) return registry.installed != null && registry.update ? registry.version : null;
  return provider?.source.kind === "registry" ? provider.source.update : null;
}

/** What the agent needs, if anything, as a trailing tag in the list. */
export function agentStatus(
  agent: AgentProvider,
  registry?: RegistryAgent | null,
): { label: string; tone: "muted" | "accent" } | null {
  if (registryUpdate(agent, registry)) return { label: "Update", tone: "accent" };
  if (agent.commandOverridden || agent.source.kind === "custom") return { label: "Custom", tone: "accent" };
  if (!agent.installed) return { label: "Not found", tone: "muted" };
  return null;
}

function AgentItem({ agent, working }: { agent: Agent; working: boolean }) {
  const status = agent.provider
    ? agentStatus(agent.provider, agent.registry)
    : registryUpdate(null, agent.registry)
      ? ({ label: "Update", tone: "accent" } as const)
      : null;
  return (
    <div className={clsx(styles.agentRow, !runnable(agent) && styles.agentMissing)}>
      <Icon name={providerIcon(agent.id)} size={16} />
      <span className={styles.agentName}>{agent.name}</span>{" "}
      {working ? (
        <Spinner size={12} />
      ) : (
        status && (
          <span className={clsx(styles.tag, status.tone === "accent" && styles.tagAccent)}>
            <T>{status.label}</T>
          </span>
        )
      )}
    </div>
  );
}

export function AgentList({
  backend,
  registry: registryBackend,
  onChanged,
}: {
  backend: CommandsBackend;
  registry: RegistryBackend;
  onChanged?: () => void;
}) {
  const [providers, setProviders] = useState<AgentProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    backend.providers().then(
      (list) => live && setProviders(list),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [backend]);
  useEffect(() => {
    const request = nextRequestId();
    let live = true;
    registryBackend
      .list(request)
      .then((r) => live && setRegistry(r))
      .catch((e: unknown) => live && !isCancelled(e) && setRegistryError(errorText(e)));
    return () => {
      live = false;
      registryBackend.cancel(request);
    };
  }, [registryBackend]);
  const refresh = useCallback(async () => {
    setProviders(await backend.providers());
  }, [backend]);
  const changed = useCallback(() => {
    void refresh().catch((e: unknown) => setError(errorText(e)));
    onChanged?.();
  }, [refresh, onChanged]);

  // Installs started before the page opened: follow them until they end.
  const background = registry?.agents.some((a) => a.installing) ?? false;
  useEffect(() => {
    if (!background) return;
    let live = true;
    let request: RequestId | null = null;
    const timer = setInterval(() => {
      if (request != null) return;
      const r = (request = nextRequestId());
      registryBackend
        .list(r)
        .then((next) => {
          if (!live) return;
          setRegistry(next);
          if (!next.agents.some((a) => a.installing)) changed();
        })
        .catch(() => {})
        .finally(() => {
          if (request === r) request = null;
        });
    }, BACKGROUND_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
      if (request != null) registryBackend.cancel(request);
    };
  }, [registryBackend, background, changed]);

  const rows = useMemo(
    () => (providers ? agentRows(providers, registry?.agents ?? [], query) : []),
    [providers, registry, query],
  );

  if (error)
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  if (!providers) return <Spinner size={14} />;

  const setAgentError = (id: string, message: string | null) =>
    setErrors((all) => {
      const { [id]: _, ...rest } = all;
      return message ? { ...rest, [id]: message } : rest;
    });

  const install = async (agent: Agent) => {
    const entry = agent.registry;
    if (!entry) return;
    if (
      entry.noChecksum &&
      !(await confirm({
        title: tx`Install ${agent.name}`,
        message: tx`${agent.name} provides no checksum for its download, so the downloaded file cannot be verified. Install it anyway?`,
        ok: tx("Install"),
        icon: "warning",
      }))
    )
      return;
    const request = nextRequestId();
    setAgentError(agent.id, null);
    setJob({ id: agent.id, request, fraction: null, message: tx`Installing ${agent.name} ${entry.version}…` });
    registryBackend
      .install(agent.id, request, (e) =>
        setJob((j) =>
          j && j.request === request
            ? e.type === "progress"
              ? { ...j, fraction: e.fraction, message: e.message }
              : { ...j, message: e.text }
            : j,
        ),
      )
      .then(() => {
        setRegistry((r) => r && { ...r, agents: afterInstall(r.agents, agent.id) });
        changed();
      })
      .catch((e: unknown) => !isCancelled(e) && setAgentError(agent.id, errorText(e)))
      .finally(() => setJob(null));
  };

  const removeCustom = async (agent: Agent) => {
    if (
      !(await confirm({
        title: tx`Remove ${agent.name}`,
        message: tx`Remove ${agent.name} and delete its agent file? Its tasks stay, but can't continue without it.`,
        ok: tx("Remove"),
      }))
    )
      return;
    setAgentError(agent.id, null);
    setRemoving(agent.id);
    try {
      await backend.removeCustom(agent.id);
      changed();
    } catch (e) {
      setAgentError(agent.id, errorText(e));
    } finally {
      setRemoving(null);
    }
  };

  const importAcpJson = async () => {
    setImporting(true);
    setNotice(null);
    try {
      const text = await backend.pickAcpJson();
      if (text == null) return;
      const outcomes = await backend.importAcp(text);
      const saved = outcomes.filter((o) => o.saved);
      const skipped = outcomes.filter((o) => !o.saved);
      const names = saved.map((o) => o.name).join(", ");
      const parts = [saved.length ? tx`Imported ${names} from acp.json.` : tx("Imported nothing from acp.json.")];
      if (skipped.length) {
        const details = skipped.map((o) => `${o.name} (${o.reason})`).join(", ");
        parts.push(tx`Skipped ${details}.`);
      }
      setNotice(parts.join(" "));
      changed();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setImporting(false);
    }
  };

  const remove = async (agent: Agent) => {
    if (
      !(await confirm({
        title: tx`Remove ${agent.name}`,
        message: tx`Remove ${agent.name} from this computer? Its tasks stay, but can't continue until it is installed again.`,
        ok: tx("Remove"),
      }))
    )
      return;
    setAgentError(agent.id, null);
    setRemoving(agent.id);
    try {
      await registryBackend.remove(agent.id);
      setRegistry((r) => r && { ...r, agents: afterRemove(r.agents, agent.id) });
      changed();
    } catch (e) {
      setAgentError(agent.id, errorText(e));
    } finally {
      setRemoving(null);
    }
  };

  const found = rows.findIndex((r) => !isSection(r) && r.id === selected);
  const index = found >= 0 ? found : rows.findIndex((r) => !isSection(r));
  const agent = index >= 0 ? (rows[index] as Agent) : null;
  const jobOf = (a: Agent): Job | null =>
    job?.id === a.id
      ? job
      : a.registry?.installing
        ? { id: a.id, request: null, fraction: null, message: tx`Installing ${a.name} in the background…` }
        : null;
  const busy = job != null || removing != null || background;

  return (
    <div className={styles.split}>
      <div className={styles.master}>
        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder={tx("Search agents")}
          aria-label="Search agents"
          clearable
        />
        {rows.length ? (
          <List
            className={styles.list}
            items={rows}
            getKey={(r) => (isSection(r) ? `section:${r.section}` : r.id)}
            isSection={isSection}
            renderSection={(r) => (
              <div className={styles.listSection}>
                <T>{(r as { section: string }).section}</T>
              </div>
            )}
            activeIndex={index}
            onActiveChange={(i) => {
              const r = rows[i];
              if (r && !isSection(r)) setSelected(r.id);
            }}
            rowHeight={28}
            sectionHeight={26}
            aria-label={tx("Agents")}
            renderItem={(r) => <AgentItem agent={r as Agent} working={jobOf(r as Agent) != null} />}
          />
        ) : (
          query && (
            <p className={styles.empty}>
              <T>No agents match</T>
            </p>
          )
        )}
        <div className={styles.customActions}>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => setAdding(true)}>
            <T>Add Custom Agent…</T>
          </Button>
          <Button size="small" variant="secondary" disabled={busy || importing} onClick={() => void importAcpJson()}>
            {importing ? <T>Importing…</T> : <T>Import acp.json</T>}
          </Button>
        </div>
        {notice && (
          <p className={styles.customNotice} role="status">
            {notice}
          </p>
        )}
        {(!registry || registry.warning) && (
          <div className={styles.registryState}>
            {registryError ? (
              <span className={styles.error} role="alert">
                {tx`Cannot load the ACP Registry: ${registryError}`}
              </span>
            ) : registry?.warning ? (
              <span className={styles.warning} role="status">
                {registry.warning}
              </span>
            ) : (
              <>
                <Spinner size={12} />
                <T>Loading the ACP Registry…</T>
              </>
            )}
          </div>
        )}
      </div>
      {agent && (
        <Details
          key={agent.id}
          agent={agent}
          backend={backend}
          refresh={refresh}
          onChanged={onChanged}
          job={jobOf(agent)}
          busy={busy}
          removing={removing === agent.id}
          error={errors[agent.id] ?? null}
          onInstall={() => void install(agent)}
          onRemove={() => void remove(agent)}
          onRemoveCustom={() => void removeCustom(agent)}
          onCancel={(request) => registryBackend.cancel(request)}
        />
      )}
      {adding && (
        <CustomAgentModal
          backend={backend}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            changed();
          }}
        />
      )}
    </div>
  );
}

/** A titled separator over its indented rows: "Launch ─────────". */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={tx(title)}>
      <div className={styles.sectionTitle}>
        <T>{title}</T>
        <span aria-hidden className={styles.sectionRule} />
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

/** "Label: control", with an optional hint under the control. */
function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {htmlFor ? (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className={styles.label}>{label}</span>
      )}
      <div className={styles.control}>{children}</div>
      {hint && <p className={styles.rowHint}>{hint}</p>}
    </>
  );
}

function Details({
  agent,
  backend,
  refresh,
  onChanged,
  job,
  busy,
  removing,
  error,
  onInstall,
  onRemove,
  onRemoveCustom,
  onCancel,
}: {
  agent: Agent;
  backend: CommandsBackend;
  refresh: () => Promise<void>;
  onChanged?: () => void;
  job: Job | null;
  busy: boolean;
  removing: boolean;
  error: string | null;
  onInstall: () => void;
  onRemove: () => void;
  onRemoveCustom: () => void;
  onCancel: (request: RequestId) => void;
}) {
  const { provider, registry } = agent;
  const installed = provider?.source.kind === "registry" || (!provider && registry?.installed != null);
  const isCustom = provider?.source.kind === "custom";
  const canInstall = registry?.distribution != null;
  const update = registryUpdate(provider, registry);
  const facts = provider
    ? [providerStatus(provider)]
    : [
        registry?.version,
        registry?.distribution ? tx(DISTRIBUTION_LABEL[registry.distribution]) : null,
        registry?.authors.join(", ") || null,
        registry?.license,
      ];
  return (
    <section className={styles.details} aria-label={agent.name}>
      <header className={styles.header}>
        <Icon name={providerIcon(agent.id)} size={24} />
        <div className={styles.heading}>
          <h3>{agent.name}</h3>
          <div className={styles.facts}>
            {provider && (
              <span
                aria-hidden
                className={clsx(
                  styles.dot,
                  provider.commandOverridden || provider.source.kind === "custom"
                    ? styles.dotCustom
                    : provider.installed && styles.dotFound,
                )}
              />
            )}
            <span>{facts.filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <div className={styles.actions}>
          {job ? (
            job.request != null && (
              <Button size="small" onClick={() => onCancel(job.request!)}>
                Cancel
              </Button>
            )
          ) : (
            <>
              {!runnable(agent) && canInstall && (
                <Button size="small" variant="primary" disabled={busy} onClick={onInstall}>
                  Install
                </Button>
              )}
              {installed && update && canInstall && (
                <Button size="small" variant="primary" disabled={busy} onClick={onInstall}>
                  Update
                </Button>
              )}
              {installed && (
                <Button size="small" disabled={busy} onClick={onRemove}>
                  {removing ? "Removing…" : "Remove"}
                </Button>
              )}
              {isCustom && (
                <Button size="small" disabled={busy} onClick={onRemoveCustom}>
                  {removing ? "Removing…" : "Remove"}
                </Button>
              )}
            </>
          )}
        </div>
      </header>
      {job && (
        <div className={styles.progress}>
          <ProgressBar value={job.fraction} aria-label={tx`Installing ${agent.name}`} />
          <span>{job.message}</span>
        </div>
      )}
      {!job && installed && update && <p className={styles.notice}>{tx`${update} is available`}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {registry?.description && <p className={styles.description}>{registry.description}</p>}
      {!provider && registry?.noChecksum && (
        <p className={styles.warning}>
          <T>No checksum provided: the download can't be verified.</T>
        </p>
      )}
      {registry && (registry.repository || registry.website) && (
        <div className={styles.links}>
          {registry.repository && <ExternalLink url={registry.repository} label="Repository" />}
          {registry.website && registry.website !== registry.repository && (
            <ExternalLink url={registry.website} label="Website" />
          )}
        </div>
      )}
      {provider && <ProviderSettings agent={provider} backend={backend} refresh={refresh} onChanged={onChanged} />}
      {registry && (
        <p className={styles.thirdParty}>
          <T>
            Agents in the ACP Registry are third-party software. They run on this computer with your permissions and can
            read and change your files. Install only agents you trust.
          </T>
        </p>
      )}
    </section>
  );
}

/** Splits arguments on whitespace, honoring single and double quotes. */
function parseArgs(text: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let quote: '"' | "'" | null = null;
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      current ??= "";
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== null) {
        out.push(current);
        current = null;
      }
    } else {
      current = (current ?? "") + ch;
    }
  }
  if (quote) throw new Error(tx("Close the quoted argument before applying."));
  if (current !== null) out.push(current);
  return out;
}

/** Quotes one argv token at a time; `parseArgs` can read the result without shell expansion. */
function formatArgs(args: readonly string[]): string {
  return args.map((arg) => (/^[\w./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`)).join(" ");
}

function CustomAgentModal({
  backend,
  onClose,
  onSaved,
}: {
  backend: CommandsBackend;
  onClose: () => void;
  onSaved: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeName = (next: string) => {
    setName(next);
    if (!idTouched) setId(slugifyId(next));
  };
  const canSave = name.trim().length > 0 && id.trim().length > 0 && command.trim().length > 0 && !saving;

  const browse = async () => {
    try {
      const trimmed = name.trim();
      const title = trimmed ? tx`Select ${trimmed}` : tx("Select executable");
      const path = await backend.chooseExecutable(title, command, "desktop");
      if (path) setCommand(path);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const input: CustomAgentInput = {
        id: id.trim(),
        name: name.trim(),
        command: command.trim(),
        args: parseArgs(argsText),
        env: parseEnv(envText),
      };
      await backend.saveCustom(input);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={tx("Add Custom Agent")}
      width={560}
      buttons={[
        { label: "Add", role: "default", disabled: !canSave, onClick: () => void save() },
        { label: "Cancel", role: "cancel", onClick: onClose },
      ]}
    >
      <div className={`${styles.form} ${styles.dialogForm}`}>
        {error && (
          <p className={styles.error} role="alert" style={{ gridColumn: "1 / -1" }}>
            {error}
          </p>
        )}
        <Row label={<T>Name</T>} htmlFor={`${uid}-name`}>
          <div className={styles.field}>
            <Input
              id={`${uid}-name`}
              data-autofocus
              value={name}
              placeholder={tx("My agent")}
              onChange={(e) => changeName(e.target.value)}
            />
          </div>
        </Row>
        <Row
          label={<T>ID</T>}
          htmlFor={`${uid}-id`}
          hint={<T>Letters, digits, dashes and underscores only; names the agent file.</T>}
        >
          <div className={styles.field}>
            <Input
              id={`${uid}-id`}
              mono
              value={id}
              placeholder="my-agent"
              onChange={(e) => {
                setId(e.target.value);
                setIdTouched(true);
              }}
            />
          </div>
        </Row>
        <Row label={<T>Command</T>} htmlFor={`${uid}-command`}>
          <div className={styles.field}>
            <Input
              id={`${uid}-command`}
              mono
              value={command}
              placeholder={tx("/path/to/agent-acp")}
              onChange={(e) => setCommand(e.target.value)}
            />
            <IconButton icon="folder-open" title="Browse…" disabled={saving} onClick={() => void browse()} />
          </div>
        </Row>
        <Row
          label={<T>Arguments</T>}
          htmlFor={`${uid}-args`}
          hint={<T>Separate arguments with spaces; quote ones containing spaces.</T>}
        >
          <div className={styles.field}>
            <Input
              id={`${uid}-args`}
              mono
              value={argsText}
              placeholder="--acp"
              onChange={(e) => setArgsText(e.target.value)}
            />
          </div>
        </Row>
        <Row label={<T>Environment variables</T>} htmlFor={`${uid}-env`}>
          <div className={styles.field}>
            <Input
              id={`${uid}-env`}
              mono
              value={envText}
              placeholder="NAME=value; OTHER=value"
              onChange={(e) => setEnvText(e.target.value)}
            />
          </div>
        </Row>
      </div>
    </Dialog>
  );
}

function providerStatus(agent: AgentProvider): string {
  if (agent.source.kind === "registry") return tx`ACP Registry · ${agent.source.version}`;
  if (agent.source.kind === "custom") return tx("Agent file");
  if (agent.commandOverridden) return tx("Custom executable");
  return agent.installed ? tx("Found on PATH") : tx("Not found on PATH");
}

function ProviderSettings({
  agent,
  backend,
  refresh,
  onChanged,
}: {
  agent: AgentProvider;
  backend: CommandsBackend;
  refresh: () => Promise<void>;
  onChanged?: () => void;
}) {
  const form = useSettingsForm();
  const base = agent.commandOverridden ? agent.program : "";
  const { value, current, set, saving } = form.useExternal(`agents.${agent.id}.command`, base, async (draft) => {
    const command = draft.trim() || null;
    await backend.set(agent.id, command);
    await refresh();
    onChanged?.();
    return command === agent.defaultProgram ? "" : (command ?? "");
  });
  const argsBase = formatArgs(agent.additionalArgs ?? []);
  const args = form.useExternal(`agents.${agent.id}.additionalArgs`, argsBase, async (draft) => {
    const parsed = parseArgs(draft);
    await backend.setAdditionalArgs(agent.id, parsed);
    await refresh();
    onChanged?.();
    return formatArgs(parsed);
  });
  const accountBase = agent.env[COPILOT_GITHUB_ACCOUNT_ENV] ?? "";
  const account = form.useExternal(`agents.${agent.id}.githubAccount`, accountBase, async (draft) => {
    const next = { ...agent.env };
    const value = draft.trim();
    if (value) next[COPILOT_GITHUB_ACCOUNT_ENV] = value;
    else delete next[COPILOT_GITHUB_ACCOUNT_ENV];
    await backend.setEnv(agent.id, next);
    await refresh();
    onChanged?.();
    return value;
  });
  const envBase = formatEnv(launchEnv(agent.env));
  const env = form.useExternal(`agents.${agent.id}.env`, envBase, async (draft) => {
    const parsed = parseEnv(draft);
    const account = agent.env[COPILOT_GITHUB_ACCOUNT_ENV];
    if (account) parsed[COPILOT_GITHUB_ACCOUNT_ENV] = account;
    await backend.setEnv(agent.id, parsed);
    await refresh();
    onChanged?.();
    return formatEnv(launchEnv(parsed));
  });
  const [error, setError] = useState<string | null>(null);
  const [signInTarget, setSignInTarget] = useState<SignInTarget | null>(null);
  const [copilotStatus, setCopilotStatus] = useState<CopilotAuthStatus | null>(null);
  const [copilotStatusLoaded, setCopilotStatusLoaded] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const pendingAddAccountPrevLogins = useRef<Set<string> | null>(null);
  const fetchCopilotStatus = backend.copilotAuthStatus;
  const reloadCopilotStatus = useCallback(async (): Promise<CopilotAuthStatus | null> => {
    if (agent.id !== "copilot" || !fetchCopilotStatus) return null;
    try {
      const next = await fetchCopilotStatus();
      setCopilotStatus(next);
      setCopilotStatusLoaded(true);
      return next;
    } catch {
      setCopilotStatusLoaded(true);
      return null;
    }
  }, [agent.id, fetchCopilotStatus]);
  useEffect(() => {
    if (agent.id !== "copilot" || !fetchCopilotStatus) return;
    let alive = true;
    void fetchCopilotStatus()
      .then((next) => {
        if (alive) {
          setCopilotStatus(next);
          setCopilotStatusLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setCopilotStatusLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [agent.id, fetchCopilotStatus]);
  const activeCopilotStatus = agent.id === "copilot" && fetchCopilotStatus ? copilotStatus : null;
  // An edit can have been staged by a previous page instance. Its Apply callback
  // refreshes that instance; the mounted one follows the newly applied value too.
  useEffect(() => {
    if (!saving && (current !== base || args.current !== argsBase)) {
      void refresh().catch((e: unknown) => setError(errorText(e)));
    }
  }, [args.current, argsBase, base, current, saving, refresh]);
  const launch =
    agent.additionalArgs == null
      ? [agent.defaultProgram, ...agent.defaultArgs].join(" ")
      : formatArgs([agent.program, ...agent.args]);
  const envEditable = agent.commandReadOnlyReason !== "registry" && agent.commandReadOnlyReason !== "customAgent";
  const canSignInInIde = agent.installed && (agent.canSignIn ?? false);
  const commandSpan = agent.loginHint ? (/`([^`]+)`/.exec(agent.loginHint)?.[1] ?? null) : null;
  const defaultAccountLabel =
    activeCopilotStatus?.authenticated && activeCopilotStatus.login
      ? activeCopilotStatus.authType === "gh-cli"
        ? tx`Copilot CLI default (${activeCopilotStatus.login} via GitHub CLI)`
        : tx`Copilot CLI default (${activeCopilotStatus.login})`
      : activeCopilotStatus && !activeCopilotStatus.authenticated
        ? tx("Copilot CLI default (not signed in)")
        : tx("Copilot CLI default");
  const ghAccounts = activeCopilotStatus?.ghAccounts ?? [];
  const copilotAccountOptions = [
    { value: "", label: defaultAccountLabel, verbatim: true },
    ...ghAccounts.map((entry) => ({
      value: entry.login,
      label: entry.login,
      verbatim: true,
    })),
    ...(account.value && !ghAccounts.some((entry) => entry.login === account.value)
      ? [
          {
            value: account.value,
            label: activeCopilotStatus ? tx`${account.value} (not signed in)` : account.value,
            verbatim: true,
          },
        ]
      : []),
  ];
  const copilotSelectedSignedIn =
    !activeCopilotStatus ||
    (account.value === ""
      ? activeCopilotStatus.authenticated
      : activeCopilotStatus.ghInstalled && ghAccounts.some((entry) => entry.login === account.value));
  const authGate: DefaultsAuthGate =
    agent.id !== "copilot"
      ? "ready"
      : fetchCopilotStatus && !activeCopilotStatus && !copilotStatusLoaded
        ? "checking"
        : !copilotSelectedSignedIn
          ? "unauthenticated"
          : account.value !== account.current
            ? "pendingApply"
            : "ready";
  const accountScope =
    agent.id === "copilot"
      ? `${account.current || `default:${activeCopilotStatus?.login ?? ""}`}:${authRevision}`
      : "default";
  return (
    <>
      {value.trim() === current && agent.installed && agent.canCheckCliUpdate && (
        <LocalCliUpdate key={agent.program} agent={agent} backend={backend} />
      )}
      {agent.id === "copilot" ? (
        <Section title="Sign In">
          <div className={styles.form}>
            <Row
              label={<T>GitHub account</T>}
              htmlFor={`agent-github-account-${agent.id}`}
              hint={
                <T>
                  GitHub account whose Copilot subscription is used for AI model requests. Tokens are resolved at launch
                  and never stored.
                </T>
              }
            >
              <div className={styles.accountField}>
                <div className={styles.select}>
                  <Select
                    id={`agent-github-account-${agent.id}`}
                    value={account.value}
                    disabled={account.saving}
                    options={copilotAccountOptions}
                    onChange={(nextValue) => account.set(nextValue)}
                  />
                </div>
                {account.value === "" && canSignInInIde && (
                  <Button
                    size="small"
                    variant={activeCopilotStatus && !activeCopilotStatus.authenticated ? "primary" : "secondary"}
                    onClick={() => {
                      pendingAddAccountPrevLogins.current = null;
                      setSignInTarget({ kind: "agent", id: agent.id, name: agent.name });
                    }}
                  >
                    <T>Sign In…</T>
                  </Button>
                )}
                {activeCopilotStatus?.ghInstalled && (
                  <Button
                    size="small"
                    onClick={() => {
                      pendingAddAccountPrevLogins.current = new Set(ghAccounts.map((entry) => entry.login));
                      setSignInTarget({ kind: "gh" });
                    }}
                  >
                    <T>Add account…</T>
                  </Button>
                )}
              </div>
            </Row>
            {activeCopilotStatus && !activeCopilotStatus.ghInstalled && (
              <p className={styles.rowHint}>
                <T>Install GitHub CLI (`gh`) to switch between multiple GitHub accounts.</T>{" "}
                <ExternalLink url="https://cli.github.com/" label="Download GitHub CLI…" />
              </p>
            )}
          </div>
          {!agent.installed && agent.loginHint && (
            <p className={styles.signInHint}>
              <LoginHint text={agent.loginHint} />
            </p>
          )}
        </Section>
      ) : (
        (agent.loginHint || canSignInInIde) && (
          <Section title="Sign In">
            <div className={styles.signInRow}>
              {canSignInInIde && (
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => {
                    pendingAddAccountPrevLogins.current = null;
                    setSignInTarget({ kind: "agent", id: agent.id, name: agent.name });
                  }}
                >
                  <T>Sign In…</T>
                </Button>
              )}
              {agent.loginHint && (
                <p className={styles.signInHint}>
                  <LoginHint text={agent.loginHint} />
                  {commandSpan && (
                    <IconButton
                      size="small"
                      icon="copy"
                      title="Copy command"
                      onClick={() => void copyText(commandSpan)}
                    />
                  )}
                </p>
              )}
            </div>
          </Section>
        )
      )}
      <Section title="New Tasks">
        <AgentDefaults agent={agent} backend={backend} authGate={authGate} accountScope={accountScope} />
      </Section>
      <Section title="Launch">
        <div className={styles.form}>
          <Row label={<T>Command</T>}>
            <code className={styles.launch} title={launch}>
              {launch}
            </code>
          </Row>
          {agent.commandEditable ? (
            <Row
              label={<T>Executable</T>}
              htmlFor={`agent-executable-${agent.id}`}
              hint={<T>Empty: found on PATH. Applies to new sessions.</T>}
            >
              <div className={styles.field}>
                <Input
                  id={`agent-executable-${agent.id}`}
                  mono
                  value={value}
                  disabled={saving}
                  placeholder={tx`Auto-detect (${agent.defaultProgram})`}
                  onChange={(e) => set(e.target.value)}
                />
                <IconButton
                  icon="folder-open"
                  title="Browse…"
                  disabled={saving}
                  onClick={async () => {
                    try {
                      const path = await backend.chooseExecutable(tx`Select ${agent.name}`, value);
                      if (path) set(path);
                      setError(null);
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                />
                {value && <IconButton icon="undo" title="Reset" disabled={saving} onClick={() => set("")} />}
              </div>
            </Row>
          ) : (
            <p className={styles.rowHint}>
              {agent.commandReadOnlyReason === "packageRunner" ? (
                <T>This agent runs through a package runner (npm or uv) and has no executable to choose.</T>
              ) : agent.commandReadOnlyReason === "registry" ? (
                <T>This agent is installed from the ACP Registry, which launches it.</T>
              ) : (
                <T>This agent is configured in its agent file.</T>
              )}
            </p>
          )}
          {agent.additionalArgs != null && (
            <Row
              label={<T>Additional arguments</T>}
              htmlFor={`agent-args-${agent.id}`}
              hint={<T>Appended to the launch command. Quote values containing spaces.</T>}
            >
              <div className={styles.field}>
                <Input
                  id={`agent-args-${agent.id}`}
                  mono
                  value={args.value}
                  disabled={args.saving}
                  onChange={(e) => args.set(e.target.value)}
                />
                {args.value && (
                  <IconButton
                    icon="undo"
                    title="Reset additional arguments"
                    disabled={args.saving}
                    onClick={() => args.set("")}
                  />
                )}
              </div>
            </Row>
          )}
          {envEditable && (
            <Row
              label={<T>Environment variables</T>}
              htmlFor={`agent-env-${agent.id}`}
              hint={<T>Override the agent process environment. Applies to new sessions.</T>}
            >
              <div className={styles.field}>
                <Input
                  id={`agent-env-${agent.id}`}
                  mono
                  value={env.value}
                  disabled={env.saving}
                  placeholder="NAME=value; OTHER=value"
                  onChange={(e) => env.set(e.target.value)}
                />
              </div>
            </Row>
          )}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </Section>
      {signInTarget && (
        <AgentSignInDialog
          target={signInTarget}
          spawner={backend}
          onClose={() => setSignInTarget(null)}
          onCompleted={() => {
            if (signInTarget.kind === "gh") {
              const prev = pendingAddAccountPrevLogins.current;
              pendingAddAccountPrevLogins.current = null;
              void reloadCopilotStatus().then((fresh) => {
                if (!prev || !fresh) return;
                const added = fresh.ghAccounts.find((entry) => !prev.has(entry.login));
                if (added) account.set(added.login);
              });
              return;
            }
            void refresh().catch((e: unknown) => setError(errorText(e)));
            onChanged?.();
            if (agent.id === "copilot") void reloadCopilotStatus();
            if (backend.refreshModels) {
              void backend
                .refreshModels(agent.id, null, true)
                .then((cat) => {
                  useAgents.setState((s) => {
                    const modelCatalogs = new Map(s.modelCatalogs);
                    modelCatalogs.set(agent.id, cat);
                    return { modelCatalogs };
                  });
                  setAuthRevision((n) => n + 1);
                })
                .catch(() => {
                  setAuthRevision((n) => n + 1);
                });
            } else {
              setAuthRevision((n) => n + 1);
            }
          }}
        />
      )}
    </>
  );
}

/** `NAME=value` pairs separated by `;` or new lines. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/[;\n]/)) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq < 0 ? "" : pair.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(tx`Expected NAME=value: ${pair}`);
    env[key] = pair.slice(eq + 1).trim();
  }
  return env;
}

const formatEnv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

/** Login hints are plain text with optional backtick-delimited command spans. */
function LoginHint({ text }: { text: string }) {
  const translate = useTxTemplate();
  return translate(text)
    .split(/(`[^`]+`)/g)
    .map((part, i) =>
      i % 2 === 1 ? (
        // oxlint-disable-next-line react/no-array-index-key -- code tokens can repeat; position is the identity
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

function ExternalLink({ url, label }: { url: string; label: string }) {
  // Links come from the registry: web pages only.
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <button type="button" className={styles.link} title={url} onClick={() => void openExternalUrl(url)}>
      <T>{label}</T>
    </button>
  );
}

/** The options a new task of `agent` starts with: each its effective default unless chosen. */
export function defaultOptions(
  agent: AgentProvider,
  chosen: Record<string, string>,
  newTaskApprovals: "bypass" | "ask" = "bypass",
): AgentConfigOption[] {
  const baseRaw = agent.config.filter((o) => !isPerModelOption(o) && o.values.length > 1);
  const approvals = approvalDefaults(baseRaw, newTaskApprovals);
  const base = baseRaw.map((o) => {
    const policy = approvals[o.id];
    return {
      ...o,
      defaultValue: o.defaultValue ?? o.current,
      current: policy !== undefined && o.values.some((v) => v.value === policy) ? policy : o.current,
    };
  });
  const modelOption = base.find((o) => o.category === "model");
  const model = (modelOption && chosen[modelOption.id]) || modelOption?.current;
  const rawLevels = (model && agent.thoughtLevels?.[model]) || [];
  const modelDefaults = cursorModelDefaults(agent.id, rawLevels);
  const levels = rawLevels
    .filter((o) => o.values.length > 1)
    .map((o) => {
      const policy = modelDefaults[o.id];
      return {
        ...o,
        defaultValue: o.defaultValue ?? o.current,
        current: policy !== undefined && o.values.some((v) => v.value === policy) ? policy : o.current,
      };
    });
  return [...base, ...levels];
}

const MODEL_SETTINGS_POLL_MS = 600;
type DefaultsAuthGate = "checking" | "unauthenticated" | "pendingApply" | "ready";

const isCatalogAuthError = (message: string | null | undefined): boolean =>
  !!message && /sign in required|authentication|not authenticated|unauthorized|not logged in/i.test(message);

function AgentDefaults({
  agent,
  backend,
  authGate,
  accountScope,
}: {
  agent: AgentProvider;
  backend: CommandsBackend;
  authGate: DefaultsAuthGate;
  accountScope: string;
}) {
  const form = useSettingsForm();
  const all = (form.useValue("agents.defaults") ?? {}) as Record<string, Record<string, string>>;
  const newTaskApprovals = (form.useValue("agents.newTaskApprovals") as "bypass" | "ask" | undefined) ?? "bypass";
  const chosen = all[agent.id] ?? {};
  const refreshModels = backend.refreshModels;
  const needsAccountCatalog = agent.id === "copilot" && agent.installed && !!refreshModels;
  const scopeKey = `${agent.id}:${accountScope}`;

  const storeCatalog = useAgents((s) => s.modelCatalogs.get(agent.id));
  const [accountCatalog, setAccountCatalog] = useState<{ scopeKey: string; catalog: AgentModelCatalog } | null>(null);
  const [fetchedCatalog, setFetchedCatalog] = useState<{ scopeKey: string; catalog: AgentModelCatalog } | null>(null);

  useEffect(() => {
    if (!needsAccountCatalog || authGate !== "ready" || !refreshModels) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await refreshModels(agent.id, null);
        if (!live) return;
        setAccountCatalog({ scopeKey, catalog: next });
        if (next.refreshing) {
          timer = setTimeout(() => void poll(), MODEL_SETTINGS_POLL_MS);
        }
      } catch (e) {
        if (!live) return;
        setAccountCatalog({
          scopeKey,
          catalog: {
            provider: agent.id,
            config: [],
            thoughtLevels: {},
            refreshing: false,
            refreshedAtMs: null,
            retryAtMs: null,
            error: errorText(e),
          },
        });
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [agent.id, authGate, needsAccountCatalog, refreshModels, scopeKey]);

  const scopedAccountCatalog = accountCatalog?.scopeKey === scopeKey ? accountCatalog.catalog : null;
  const scopedFetchedCatalog = fetchedCatalog?.scopeKey === scopeKey ? fetchedCatalog.catalog : null;
  const catalog = scopedFetchedCatalog ?? scopedAccountCatalog ?? (needsAccountCatalog ? undefined : storeCatalog);
  const effectiveAgent = useMemo<AgentProvider>(() => {
    if (needsAccountCatalog) {
      if (!catalog || catalog.refreshedAtMs == null) {
        return { ...agent, config: [], thoughtLevels: {} };
      }
      return {
        ...agent,
        config: catalog.config,
        thoughtLevels: catalog.thoughtLevels ?? {},
      };
    }
    if (!catalog) return agent;
    return {
      ...agent,
      config: catalog.config.length ? catalog.config : agent.config,
      thoughtLevels: { ...agent.thoughtLevels, ...catalog.thoughtLevels },
    };
  }, [agent, catalog, needsAccountCatalog]);
  const options = defaultOptions(effectiveAgent, chosen, newTaskApprovals);
  const modelOption = options.find((o) => o.category === "model");
  const selectedModel = (modelOption && chosen[modelOption.id]) || modelOption?.current || null;
  const unknownModelSettings =
    !!selectedModel &&
    !!modelOption?.values.some((v) => v.value === selectedModel) &&
    !Object.hasOwn(effectiveAgent.thoughtLevels ?? {}, selectedModel);
  const fetchKey =
    authGate === "ready" && agent.installed && refreshModels && selectedModel && unknownModelSettings
      ? `${scopeKey}:${selectedModel}`
      : null;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const loadingModel = fetchKey !== null && settledKey !== fetchKey;

  useEffect(() => {
    if (!fetchKey || !refreshModels || !selectedModel) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await refreshModels(agent.id, selectedModel);
        if (!live) return;
        setFetchedCatalog({ scopeKey, catalog: next });
        if (next.refreshing && !Object.hasOwn(next.thoughtLevels ?? {}, selectedModel)) {
          timer = setTimeout(() => void poll(), MODEL_SETTINGS_POLL_MS);
        } else {
          setSettledKey(fetchKey);
        }
      } catch {
        if (live) setSettledKey(fetchKey);
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [agent.id, fetchKey, refreshModels, scopeKey, selectedModel]);

  if (authGate === "checking") {
    return (
      <p className={styles.statusNote}>
        <Spinner size={12} /> <T>Checking sign-in status…</T>
      </p>
    );
  }
  if (authGate === "unauthenticated" || isCatalogAuthError(catalog?.error)) {
    return (
      <p className={styles.text}>
        <T>Sign in above to view and choose models available for this account.</T>
      </p>
    );
  }
  if (authGate === "pendingApply") {
    return (
      <p className={styles.text}>
        <T>Click Apply to load the models available for the selected account.</T>
      </p>
    );
  }
  if (
    needsAccountCatalog &&
    (!scopedAccountCatalog || (scopedAccountCatalog.refreshing && scopedAccountCatalog.refreshedAtMs == null))
  ) {
    return (
      <p className={styles.statusNote}>
        <Spinner size={12} /> <T>Loading models for this account…</T>
      </p>
    );
  }
  if (needsAccountCatalog && scopedAccountCatalog?.refreshedAtMs == null && scopedAccountCatalog?.error) {
    return <p className={styles.error}>{scopedAccountCatalog.error}</p>;
  }
  if (!options.length)
    return (
      <p className={styles.text}>
        <T>The agent's models and modes can be chosen here after its first session.</T>
      </p>
    );
  const baseIds = new Set(effectiveAgent.config.filter((o) => !isPerModelOption(o)).map((o) => o.id));
  const choose = (id: string, value: string) => {
    const { [id]: _, ...rest } = chosen;
    const next: Record<string, string> = value ? { ...rest, [id]: value } : { ...rest };
    // Prune stale per-model defaults when switching to a model whose options are already known.
    if (modelOption && id === modelOption.id) {
      const nextModel = value || modelOption.current;
      const nextLevels = nextModel ? effectiveAgent.thoughtLevels?.[nextModel] : undefined;
      if (nextLevels) {
        for (const key of Object.keys(next)) {
          if (baseIds.has(key)) continue;
          const matching = nextLevels.find((o) => o.id === key);
          if (!matching || !matching.values.some((v) => v.value === next[key])) delete next[key];
        }
      }
    }
    const { [agent.id]: __, ...others } = all;
    form.set("agents.defaults", Object.keys(next).length ? { ...others, [agent.id]: next } : others);
  };
  return (
    <div className={styles.form}>
      {options.map((o) => {
        const fallback = o.values.find((v) => v.value === o.current)?.name;
        const agentDefault = o.defaultValue ?? o.current;
        const defaultLabel = fallback
          ? o.current !== agentDefault
            ? tx`Default (${fallback})`
            : tx`Agent's default (${fallback})`
          : tx("Agent's default");
        const currentChoice = chosen[o.id] ?? "";
        const unavailableChoice =
          currentChoice && !o.values.some((v) => v.value === currentChoice)
            ? [{ value: currentChoice, label: tx`${currentChoice} (unavailable)`, verbatim: true, disabled: true }]
            : [];
        return (
          <Row key={o.id} label={o.name} htmlFor={`agent-default-${agent.id}-${o.id}`}>
            <div className={styles.select}>
              <Select
                id={`agent-default-${agent.id}-${o.id}`}
                value={currentChoice}
                options={[
                  { value: "", label: defaultLabel },
                  ...unavailableChoice,
                  ...o.values.map((v) => ({
                    value: v.value,
                    label: v.name,
                    verbatim: true,
                    detail: v.description ?? undefined,
                    verbatimDetail: true,
                  })),
                ]}
                onChange={(value) => choose(o.id, value)}
              />
            </div>
          </Row>
        );
      })}
      {loadingModel && (
        <p className={styles.rowHint}>
          <T>Loading model settings…</T>
        </p>
      )}
      <p className={styles.rowHint}>
        <T>What you pick on the New Task page wins; these apply until then and after switching agents.</T>
      </p>
    </div>
  );
}
