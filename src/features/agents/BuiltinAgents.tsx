/** Built-in launch settings; each executable is staged independently until Apply. */
import { useCallback, useEffect, useState } from "react";
import type { AgentProvider } from "@/bindings";
import { tx, useTx } from "@/platform/i18n";
import clsx from "clsx";
import { Button, Icon, IconButton, Input, List, Spinner, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { providerIcon } from "./model";
import type { CommandsBackend } from "./registry";
import styles from "./BuiltinAgents.module.css";

/** Trailing list tag: a missing agent is a normal state, so it is muted rather than a warning. */
function Status({ agent }: { agent: AgentProvider }) {
  if (agent.commandOverridden)
    return (
      <span className={clsx(styles.tag, styles.tagCustom)}>
        <T>Custom</T>
      </span>
    );
  if (agent.installed) return null;
  return (
    <span className={styles.tag}>
      <T>Not found</T>
    </span>
  );
}

export function BuiltinAgents({ backend, onChanged }: { backend: CommandsBackend; onChanged?: () => void }) {
  const [agents, setAgents] = useState<AgentProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let live = true;
    backend.providers().then(
      (list) => live && setAgents(list.filter((p) => p.defaultProgram != null)),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [backend]);
  const refresh = useCallback(async () => {
    const list = await backend.providers();
    setAgents(list.filter((p) => p.defaultProgram != null));
  }, [backend]);
  if (error)
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  if (!agents) return <Spinner size={14} />;
  const agent = agents[selected] ?? agents[0];
  return (
    <div className={styles.split}>
      <List
        className={styles.master}
        items={agents}
        getKey={(p) => p.id}
        activeIndex={selected}
        onActiveChange={setSelected}
        rowHeight={32}
        aria-label={tx("Built-in agents")}
        renderItem={(p) => (
          <div className={clsx(styles.agentRow, !p.installed && !p.commandOverridden && styles.agentMissing)}>
            <Icon name={providerIcon(p.id)} size={16} />
            <span className={styles.agentName}>{p.name}</span> <Status agent={p} />
          </div>
        )}
      />
      {agent && <Details key={agent.id} agent={agent} backend={backend} refresh={refresh} onChanged={onChanged} />}
    </div>
  );
}

function Details({
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
    if (!saving && current !== base) {
      void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [base, current, saving, refresh]);
  const launch = [agent.defaultProgram, ...agent.defaultArgs].join(" ");
  const status = agent.commandOverridden
    ? tx("Custom executable")
    : agent.installed
      ? tx("Found on PATH")
      : tx("Not found on PATH");
  return (
    <section className={styles.details} aria-label={tx`${agent.name} executable`}>
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
              size="small"
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
            {value && (
              <Button size="small" disabled={saving} onClick={() => set("")}>
                <T>Reset</T>
              </Button>
            )}
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
            <T>This agent is installed from the ACP Registry. Manage its installation in the ACP Registry tab.</T>
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
  const translate = useTx();
  return translate(text)
    .split(/(`[^`]+`)/g)
    .map((part, i) => (i % 2 === 1 ? <code key={i}>{part.slice(1, -1)}</code> : part));
}
