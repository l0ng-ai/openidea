/** Built-in launch settings; each executable is staged independently until Apply. */
import { useCallback, useEffect, useState } from "react";
import type { AgentProvider } from "@/bindings";
import { tx, useTx } from "@/platform/i18n";
import { Badge, Button, Icon, IconButton, Input, List, Spinner, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { providerIcon } from "./model";
import type { CommandsBackend } from "./registry";
import styles from "./BuiltinAgents.module.css";

function Status({ agent }: { agent: AgentProvider }) {
  const translate = useTx();
  if (!agent.commandOverridden && agent.installed) return null;
  return (
    <Badge tone={agent.commandOverridden ? "accent" : "warning"}>
      {agent.commandOverridden ? translate("Custom") : translate("Not found")}
    </Badge>
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
          <div className={styles.agentRow}>
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
  const [error, setError] = useState<string | null>(null);
  // An edit can have been staged by a previous page instance. Its Apply callback
  // refreshes that instance; the mounted one follows the newly applied value too.
  useEffect(() => {
    if (!saving && current !== base) {
      void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [base, current, saving, refresh]);
  const launch = [agent.defaultProgram, ...agent.defaultArgs].join(" ");
  return (
    <section className={styles.details} aria-label={tx`${agent.name} executable`}>
      <div className={styles.title}>
        <Icon name={providerIcon(agent.id)} size={20} />
        <h3>{agent.name}</h3>
      </div>
      <code className={styles.launch}>{launch}</code>
      <p className={styles.status}>
        {agent.commandOverridden ? (
          <T>Custom executable</T>
        ) : agent.installed ? (
          <T>Found on PATH</T>
        ) : (
          <T>Not found on PATH</T>
        )}
      </p>
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
            <Button size="small" disabled={saving || !value} onClick={() => set("")}>
              <T>Reset</T>
            </Button>
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
      {agent.loginHint && (
        <p className={styles.hint}>
          <LoginHint text={agent.loginHint} />
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Login hints are plain text with optional backtick-delimited command spans. */
function LoginHint({ text }: { text: string }) {
  const translate = useTx();
  return translate(text)
    .split(/(`[^`]+`)/g)
    .map((part, i) => (i % 2 === 1 ? <code key={i}>{part.slice(1, -1)}</code> : part));
}
