/**
 * Settings › Agents › Coding Agents: one searchable list of every agent, those this machine can run first
 * (built in, installed from the ACP Registry, or defined in an agent file), then those it
 * can install. The selected agent's page holds its actions, the settings its new tasks
 * start with, and how it is launched. Launch edits are staged until Apply; installs run in
 * the background and keep running after the page closes.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type {
  AgentConfigOption,
  AgentProvider,
  AgentRegistry,
  CustomAgentInput,
  RegistryAgent,
  RequestId,
} from "@/bindings";
import { isCancelled, nextRequestId } from "@/platform/ipc";
import { tx, useTxTemplate } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import clsx from "clsx";
import { Button, Dialog, Icon, IconButton, Input, List, ProgressBar, SearchField, Select, Spinner, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { providerIcon } from "./model";
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

/** What the agent needs, if anything, as a trailing tag in the list. */
export function agentStatus(agent: AgentProvider): { label: string; tone: "muted" | "accent" } | null {
  if (agent.source.kind === "registry" && agent.source.update) return { label: "Update", tone: "accent" };
  if (agent.commandOverridden || agent.source.kind === "custom") return { label: "Custom", tone: "accent" };
  if (!agent.installed) return { label: "Not found", tone: "muted" };
  return null;
}

function AgentItem({ agent, working }: { agent: Agent; working: boolean }) {
  const status = agent.provider
    ? agentStatus(agent.provider)
    : agent.registry?.installed != null && agent.registry.update
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
  const update =
    provider?.source.kind === "registry" ? provider.source.update : registry?.update ? registry.version : null;
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
          <span className={styles.hint}>{job.message}</span>
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

/** Suggests an agent-file id for a display name (`"My Agent!"` → `"my-agent"`). */
function slugifyId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Splits arguments on whitespace, honoring single and double quotes. */
function parseArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
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
      const path = await backend.chooseExecutable(title, command);
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
  const envBase = formatEnv(agent.env);
  const env = form.useExternal(`agents.${agent.id}.env`, envBase, async (draft) => {
    const parsed = parseEnv(draft);
    await backend.setEnv(agent.id, parsed);
    await refresh();
    onChanged?.();
    return formatEnv(parsed);
  });
  const [error, setError] = useState<string | null>(null);
  // An edit can have been staged by a previous page instance. Its Apply callback
  // refreshes that instance; the mounted one follows the newly applied value too.
  useEffect(() => {
    if (!saving && current !== base) void refresh().catch((e: unknown) => setError(errorText(e)));
  }, [base, current, saving, refresh]);
  const launch = [agent.defaultProgram, ...agent.defaultArgs].join(" ");
  const envEditable = agent.commandReadOnlyReason !== "registry" && agent.commandReadOnlyReason !== "customAgent";
  return (
    <>
      {agent.loginHint && (
        <Section title="Sign In">
          <p className={styles.text}>
            <LoginHint text={agent.loginHint} />
          </p>
        </Section>
      )}
      <Section title="New Tasks">
        <AgentDefaults agent={agent} />
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
              hint={<T>Leave empty to find the executable on PATH. Changes apply to new sessions.</T>}
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
          {envEditable && (
            <Row
              label={<T>Environment variables</T>}
              htmlFor={`agent-env-${agent.id}`}
              hint={
                <T>Passed to the agent process, replacing variables of the same name. Changes apply to new sessions.</T>
              }
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
    .map((part, i) => (i % 2 === 1 ? <code key={i}>{part.slice(1, -1)}</code> : part));
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

/** The options a new task of `agent` starts with: each the agent's own default unless chosen. */
export function defaultOptions(agent: AgentProvider, chosen: Record<string, string>): AgentConfigOption[] {
  const base = agent.config.filter((o) => o.category !== "thought_level" && o.values.length > 1);
  const modelOption = base.find((o) => o.category === "model");
  const model = (modelOption && chosen[modelOption.id]) || modelOption?.current;
  const levels = (model && agent.thoughtLevels?.[model]) || [];
  return [...base, ...levels.filter((o) => o.values.length > 1)];
}

function AgentDefaults({ agent }: { agent: AgentProvider }) {
  const form = useSettingsForm();
  const all = (form.useValue("agents.defaults") ?? {}) as Record<string, Record<string, string>>;
  const chosen = all[agent.id] ?? {};
  const options = defaultOptions(agent, chosen);
  if (!options.length)
    return (
      <p className={styles.text}>
        <T>The agent's models and modes can be chosen here after its first session.</T>
      </p>
    );
  const choose = (id: string, value: string) => {
    const { [id]: _, ...rest } = chosen;
    const next = value ? { ...rest, [id]: value } : rest;
    const { [agent.id]: __, ...others } = all;
    form.set("agents.defaults", Object.keys(next).length ? { ...others, [agent.id]: next } : others);
  };
  return (
    <div className={styles.form}>
      {options.map((o) => {
        const fallback = o.values.find((v) => v.value === o.current)?.name;
        return (
          <Row key={o.id} label={o.name} htmlFor={`agent-default-${agent.id}-${o.id}`}>
            <div className={styles.select}>
              <Select
                id={`agent-default-${agent.id}-${o.id}`}
                value={chosen[o.id] ?? ""}
                options={[
                  { value: "", label: fallback ? tx`Agent's default (${fallback})` : tx("Agent's default") },
                  ...o.values.map((v) => ({
                    value: v.value,
                    label: v.name,
                    verbatim: true,
                    detail: v.description ?? undefined,
                  })),
                ]}
                onChange={(value) => choose(o.id, value)}
              />
            </div>
          </Row>
        );
      })}
      <p className={styles.rowHint}>
        <T>What you pick on the New Task page wins; these apply until then and after switching agents.</T>
      </p>
    </div>
  );
}
