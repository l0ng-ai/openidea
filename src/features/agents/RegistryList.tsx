/**
 * Agents of the ACP Registry this machine can run, with Install / Update / Remove (in
 * Settings › Agents › Add Agent).
 * Installs run in the background with progress, and keep running after the page closes
 * (as a background task of the project windows); the page then shows them as installing.
 */
import { useEffect, useMemo, useState } from "react";
import type { AgentRegistry, RegistryAgent, RequestId } from "@/bindings";
import { isCancelled, nextRequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import clsx from "clsx";
import { Button, Icon, List, ProgressBar, SearchField, Spinner, T } from "@/ui";
import { confirm } from "@/workbench/messages";
import { providerIcon } from "./model";
import {
  DISTRIBUTION_LABEL,
  afterInstall,
  afterRemove,
  matchesQuery,
  rowActions,
  sortAgents,
  type RegistryBackend,
} from "./registry";
import styles from "./RegistryList.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How often the page checks on installs it did not start. */
const BACKGROUND_POLL_MS = 1500;

interface Job {
  id: string;
  fraction: number | null;
  message: string;
}

interface PageJob extends Job {
  request: RequestId;
}

/** An install started before the page opened; its progress shows in the background tasks. */
const backgroundJob = (agent: RegistryAgent): Job => ({
  id: agent.id,
  fraction: null,
  message: tx`Installing ${agent.name} in the background…`,
});

export function RegistryList({ backend, onChanged }: { backend: RegistryBackend; onChanged?: () => void }) {
  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<PageJob | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const request = nextRequestId();
    let live = true;
    backend
      .list(request)
      .then((r) => live && setRegistry(r))
      .catch((e: unknown) => live && !isCancelled(e) && setLoadError(errorText(e)));
    return () => {
      live = false;
      backend.cancel(request);
    };
  }, [backend]);

  // Installs started before the page opened: follow them until they end.
  const background = registry?.agents.some((a) => a.installing) ?? false;
  useEffect(() => {
    if (!background) return;
    let live = true;
    let request: RequestId | null = null;
    const timer = setInterval(() => {
      if (request != null) return;
      const r = (request = nextRequestId());
      backend
        .list(r)
        .then((next) => {
          if (!live) return;
          setRegistry(next);
          if (!next.agents.some((a) => a.installing)) onChanged?.();
        })
        .catch(() => {})
        .finally(() => {
          if (request === r) request = null;
        });
    }, BACKGROUND_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
      if (request != null) backend.cancel(request);
    };
  }, [backend, background, onChanged]);

  const agents = useMemo(
    () => sortAgents((registry?.agents ?? []).filter((a) => matchesQuery(a, query))),
    [registry, query],
  );
  const busy = job != null || removing != null || background;

  const setError = (id: string, error: string | null) =>
    setErrors((all) => {
      const { [id]: _, ...rest } = all;
      return error ? { ...rest, [id]: error } : rest;
    });

  const install = async (agent: RegistryAgent) => {
    if (
      agent.noChecksum &&
      !(await confirm({
        title: tx`Install ${agent.name}`,
        message: tx`${agent.name} provides no checksum for its download, so the downloaded file cannot be verified. Install it anyway?`,
        ok: tx("Install"),
        icon: "warning",
      }))
    )
      return;
    const request = nextRequestId();
    setError(agent.id, null);
    setJob({ id: agent.id, request, fraction: null, message: tx`Installing ${agent.name} ${agent.version}…` });
    backend
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
        onChanged?.();
      })
      .catch((e: unknown) => !isCancelled(e) && setError(agent.id, errorText(e)))
      .finally(() => setJob(null));
  };

  const remove = (agent: RegistryAgent) => {
    setError(agent.id, null);
    setRemoving(agent.id);
    backend
      .remove(agent.id)
      .then(() => {
        setRegistry((r) => r && { ...r, agents: afterRemove(r.agents, agent.id) });
        onChanged?.();
      })
      .catch((e: unknown) => setError(agent.id, errorText(e)))
      .finally(() => setRemoving(null));
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const index = Math.max(
    0,
    agents.findIndex((a) => a.id === selectedId),
  );
  const selected = agents[index] ?? null;
  const jobOf = (agent: RegistryAgent) => (job?.id === agent.id ? job : agent.installing ? backgroundJob(agent) : null);

  return (
    <div className={styles.registry}>
      <SearchField
        autoFocus
        value={query}
        onChange={setQuery}
        placeholder={tx("Search the ACP Registry")}
        aria-label="Search agents"
        clearable
      />
      {registry?.warning && (
        <p className={styles.warning} role="status">
          {registry.warning}
        </p>
      )}
      <div className={styles.split} aria-busy={!registry && !loadError}>
        {loadError ? (
          <p className={styles.error} role="alert">
            {tx`Cannot load the ACP Registry: ${loadError}`}
          </p>
        ) : !registry ? (
          <div className={styles.loading}>
            <Spinner size={14} />
            <T>Loading the ACP Registry…</T>
          </div>
        ) : agents.length === 0 ? (
          <p className={styles.empty}>
            {query ? <T>No agents match</T> : <T>The registry has no agents for this system</T>}
          </p>
        ) : (
          <>
            <List
              className={styles.master}
              items={agents}
              getKey={(a) => a.id}
              activeIndex={index}
              onActiveChange={(i) => setSelectedId(agents[i]?.id ?? null)}
              rowHeight={28}
              aria-label={tx("Registry agents")}
              renderItem={(a) => <AgentItem agent={a} working={jobOf(a) != null} />}
            />
            {selected && (
              <AgentDetails
                key={selected.id}
                agent={selected}
                job={jobOf(selected)}
                removing={removing === selected.id}
                disabled={busy}
                error={errors[selected.id] ?? null}
                onInstall={() => void install(selected)}
                onRemove={() => remove(selected)}
                onCancel={job?.id === selected.id ? () => backend.cancel(job.request) : undefined}
              />
            )}
          </>
        )}
      </div>
      <p className={styles.notice}>
        <T>
          Agents in the ACP Registry are third-party software. They run on this computer with your permissions and can
          read and change your files. Install only agents you trust.
        </T>
      </p>
    </div>
  );
}

/** A list row: the agent, and whether it is installed, has an update or is installing. */
function AgentItem({ agent, working }: { agent: RegistryAgent; working: boolean }) {
  const actions = rowActions(agent);
  return (
    <div className={styles.item}>
      <Icon name={providerIcon(agent.id)} size={16} />
      <span className={styles.itemName}>{agent.name}</span>
      {working ? (
        <Spinner size={12} />
      ) : actions.update ? (
        <span className={clsx(styles.itemTag, styles.itemAccent)}>
          <T>Update</T>
        </span>
      ) : agent.installed != null ? (
        <span className={styles.itemTag}>
          <T>Installed</T>
        </span>
      ) : null}
    </div>
  );
}

function AgentDetails({
  agent,
  job,
  removing,
  disabled,
  error,
  onInstall,
  onRemove,
  onCancel,
}: {
  agent: RegistryAgent;
  job: Job | null;
  removing: boolean;
  disabled: boolean;
  error: string | null;
  onInstall: () => void;
  onRemove: () => void;
  /** Absent for an install this page did not start (stop it from the background tasks). */
  onCancel?: () => void;
}) {
  const actions = rowActions(agent);
  const facts = [
    agent.installed != null && agent.installed !== agent.version
      ? tx`${agent.installed} installed, ${agent.version} available`
      : agent.version,
    agent.distribution ? tx(DISTRIBUTION_LABEL[agent.distribution]) : null,
    agent.authors.join(", ") || null,
    agent.license,
  ].filter(Boolean);
  return (
    <section className={styles.details} aria-label={agent.name}>
      <div className={styles.detailsTitle}>
        <Icon name={providerIcon(agent.id)} size={24} />
        <h3>{agent.name}</h3>
      </div>
      <div className={styles.facts}>{facts.join(" · ")}</div>
      <div className={styles.actions}>
        {job ? (
          <>
            <ProgressBar value={job.fraction} aria-label={tx`Installing ${agent.name}`} />
            {onCancel && (
              <Button size="small" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            {actions.install && (
              <Button size="small" variant="primary" disabled={disabled} onClick={onInstall}>
                Install
              </Button>
            )}
            {actions.update && (
              <Button size="small" variant="primary" disabled={disabled} onClick={onInstall}>
                Update
              </Button>
            )}
            {actions.remove && (
              <Button size="small" disabled={disabled} onClick={onRemove}>
                {removing ? "Removing…" : "Remove"}
              </Button>
            )}
          </>
        )}
      </div>
      {job && <p className={styles.progressText}>{job.message}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {agent.description && <p className={styles.description}>{agent.description}</p>}
      {agent.noChecksum && (
        <p className={styles.warning}>
          <T>No checksum provided: the download can't be verified.</T>
        </p>
      )}
      <div className={styles.links}>
        {agent.repository && <ExternalLink url={agent.repository} label="Repository" />}
        {agent.website && agent.website !== agent.repository && <ExternalLink url={agent.website} label="Website" />}
      </div>
    </section>
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
