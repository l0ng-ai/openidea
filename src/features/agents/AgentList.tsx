/**
 * Settings › Agents: every agent this machine can run (built in, installed from the ACP
 * Registry, or defined in an agent file) beside the selected one's status, the settings
 * its new tasks start with, and how it is launched. Launch edits are staged until Apply.
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentConfigOption, AgentProvider, RequestId } from "@/bindings";
import { isCancelled, nextRequestId } from "@/platform/ipc";
import { tx, useTxTemplate } from "@/platform/i18n";
import clsx from "clsx";
import { Button, Dialog, Icon, IconButton, Input, List, ProgressBar, Select, Spinner, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { providerIcon } from "./model";
import type { CommandsBackend, RegistryBackend } from "./registry";
import { RegistryList } from "./RegistryList";
import styles from "./AgentList.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the agent needs, if anything, as a trailing tag in the list. */
export function agentStatus(agent: AgentProvider): { label: string; tone: "muted" | "accent" | "warning" } | null {
  if (agent.source.kind === "registry" && agent.source.update) return { label: "Update", tone: "accent" };
  if (agent.commandOverridden || agent.source.kind === "custom") return { label: "Custom", tone: "accent" };
  if (!agent.installed) return { label: "Not found", tone: "muted" };
  return null;
}

function Status({ agent }: { agent: AgentProvider }) {
  const status = agentStatus(agent);
  if (!status) return null;
  return (
    <span className={clsx(styles.tag, status.tone === "accent" && styles.tagCustom)}>
      <T>{status.label}</T>
    </span>
  );
}

export function AgentList({
  backend,
  registry,
  onChanged,
}: {
  backend: CommandsBackend;
  registry: RegistryBackend;
  onChanged?: () => void;
}) {
  const [agents, setAgents] = useState<AgentProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    let live = true;
    backend.providers().then(
      (list) => live && setAgents(list),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [backend]);
  const refresh = useCallback(async () => {
    setAgents(await backend.providers());
  }, [backend]);
  const changed = useCallback(() => {
    void refresh().catch((e: unknown) => setError(errorText(e)));
    onChanged?.();
  }, [refresh, onChanged]);
  if (error)
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  if (!agents) return <Spinner size={14} />;
  const index = Math.max(
    0,
    agents.findIndex((a) => a.id === selected),
  );
  const agent = agents[index];
  const remove = async () => {
    if (!agent || agent.source.kind !== "registry") return;
    if (
      !(await confirm({
        title: tx`Remove ${agent.name}`,
        message: tx`Remove ${agent.name} from this computer? Its tasks stay, but can't continue until it is installed again.`,
        ok: tx("Remove"),
      }))
    )
      return;
    setRemoving(true);
    try {
      await registry.remove(agent.id);
      setSelected(null);
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div className={styles.split}>
      <div className={styles.master}>
        <div className={styles.toolbar} role="toolbar" aria-label={tx("Agents")}>
          <IconButton icon="plus" title="Add Agent…" onClick={() => setAdding(true)} />
          <IconButton
            icon="minus"
            title="Remove"
            disabled={agent?.source.kind !== "registry" || removing}
            onClick={() => void remove()}
          />
        </div>
        <List
          className={styles.list}
          items={agents}
          getKey={(p) => p.id}
          activeIndex={index}
          onActiveChange={(i) => setSelected(agents[i]?.id ?? null)}
          rowHeight={32}
          aria-label={tx("Agents")}
          renderItem={(p) => (
            <div className={clsx(styles.agentRow, !p.installed && !p.commandOverridden && styles.agentMissing)}>
              <Icon name={providerIcon(p.id)} size={16} />
              <span className={styles.agentName}>{p.name}</span> <Status agent={p} />
            </div>
          )}
        />
      </div>
      {agent && (
        <Details
          key={agent.id}
          agent={agent}
          backend={backend}
          registry={registry}
          refresh={refresh}
          onChanged={onChanged}
        />
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add Agent"
        width={680}
        minHeight={360}
        // A fixed size, as IntelliJ's choosers open: the list scrolls inside it.
        initialSize={{ w: 680, h: 440 }}
        resizable="both"
        buttons={[{ label: "Done", role: "cancel" }]}
      >
        <RegistryList backend={registry} onChanged={changed} />
      </Dialog>
    </div>
  );
}

function Details({
  agent,
  backend,
  registry,
  refresh,
  onChanged,
}: {
  agent: AgentProvider;
  backend: CommandsBackend;
  registry: RegistryBackend;
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
    if (!saving && current !== base) {
      void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [base, current, saving, refresh]);
  const launch = [agent.defaultProgram, ...agent.defaultArgs].join(" ");
  const status =
    agent.source.kind === "registry"
      ? tx`ACP Registry · ${agent.source.version}`
      : agent.source.kind === "custom"
        ? tx("Agent file")
        : agent.commandOverridden
          ? tx("Custom executable")
          : agent.installed
            ? tx("Found on PATH")
            : tx("Not found on PATH");
  return (
    <section className={styles.details} aria-label={agent.name}>
      <div className={styles.title}>
        <Icon name={providerIcon(agent.id)} size={20} />
        <h3>{agent.name}</h3>
      </div>
      <div className={styles.subtitle}>
        <span
          aria-hidden
          className={clsx(styles.dot, agent.commandOverridden ? styles.dotCustom : agent.installed && styles.dotFound)}
        />
        <span>{status}</span>
        <span aria-hidden>·</span>
        <code className={styles.launch} title={tx("Launch command")}>
          {launch}
        </code>
      </div>
      {agent.source.kind === "registry" && agent.source.update && (
        <RegistryUpdate agent={agent} version={agent.source.update} registry={registry} refresh={refresh} />
      )}
      {agent.loginHint && (
        <>
          <h4 className={styles.section}>
            <T>Sign in</T>
          </h4>
          <p className={styles.hint}>
            <LoginHint text={agent.loginHint} />
          </p>
        </>
      )}
      <h4 className={styles.section}>
        <T>New tasks start with</T>
      </h4>
      <AgentDefaults agent={agent} />
      <h4 className={styles.section}>
        <T>Launch</T>
      </h4>
      {agent.commandEditable ? (
        <>
          <label className={styles.label} htmlFor={`agent-executable-${agent.id}`}>
            <T>Executable</T>
          </label>
          <div className={styles.controls}>
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
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            />
            {value && <IconButton icon="undo" title="Reset" disabled={saving} onClick={() => set("")} />}
          </div>
          <p className={styles.hint}>
            <T>Leave empty to find the executable on PATH. Changes apply to new sessions.</T>
          </p>
        </>
      ) : (
        <p className={styles.hint}>
          {agent.commandReadOnlyReason === "packageRunner" ? (
            <T>This agent runs through a package runner (npm or uv) and has no executable to choose.</T>
          ) : agent.commandReadOnlyReason === "registry" ? (
            <T>This agent is installed from the ACP Registry, which launches it.</T>
          ) : (
            <T>This agent is configured in its agent file.</T>
          )}
        </p>
      )}
      {agent.commandReadOnlyReason !== "registry" && agent.commandReadOnlyReason !== "customAgent" && (
        <>
          <label className={styles.label} htmlFor={`agent-env-${agent.id}`}>
            <T>Environment variables</T>
          </label>
          <div className={styles.controls}>
            <Input
              id={`agent-env-${agent.id}`}
              mono
              value={env.value}
              disabled={env.saving}
              placeholder="NAME=value; OTHER=value"
              onChange={(e) => env.set(e.target.value)}
            />
          </div>
          <p className={styles.hint}>
            <T>Passed to the agent process, replacing variables of the same name. Changes apply to new sessions.</T>
          </p>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
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

/** Updates an agent installed from the ACP Registry, with its progress. */
function RegistryUpdate({
  agent,
  version,
  registry,
  refresh,
}: {
  agent: AgentProvider;
  version: string;
  registry: RegistryBackend;
  refresh: () => Promise<void>;
}) {
  const [job, setJob] = useState<{ request: RequestId; fraction: number | null; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = () => {
    const request = nextRequestId();
    setError(null);
    setJob({ request, fraction: null, message: tx`Installing ${agent.name} ${version}…` });
    registry
      .install(agent.id, request, (e) =>
        setJob((j) =>
          j && j.request === request
            ? e.type === "progress"
              ? { ...j, fraction: e.fraction, message: e.message }
              : { ...j, message: e.text }
            : j,
        ),
      )
      .then(refresh)
      .catch((e: unknown) => !isCancelled(e) && setError(errorText(e)))
      .finally(() => setJob(null));
  };
  return (
    <div className={styles.update}>
      {job ? (
        <>
          <ProgressBar value={job.fraction} aria-label={tx`Installing ${agent.name}`} />
          <span className={styles.hint}>{job.message}</span>
          <Button size="small" onClick={() => registry.cancel(job.request)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span>{tx`${version} is available`}</span>
          <Button size="small" variant="primary" onClick={update}>
            Update
          </Button>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
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
      <p className={styles.hint}>
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
    <div className={styles.defaults}>
      {options.map((o) => {
        const fallback = o.values.find((v) => v.value === o.current)?.name;
        return (
          <div key={o.id} className={styles.defaultRow}>
            <label className={styles.defaultLabel} htmlFor={`agent-default-${agent.id}-${o.id}`}>
              {o.name}
            </label>
            <div>
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
          </div>
        );
      })}
      <p className={styles.hint}>
        <T>What you pick on the New Task page wins; these apply until then and after switching agents.</T>
      </p>
    </div>
  );
}
