/** New Task page: one prompt box with the agent and its settings; where it works under it. */
import { useEffect, useState } from "react";
import type { AgentProbe, Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { Button, Icon, Select, T, type SelectOption } from "@/ui";
import { Composer } from "./Composer";
import { canSend, emptyDraft } from "./composerModel";
import { ConfigPickers } from "./ConfigPickers";
import { providerIcon } from "./model";
import { ADD_AGENT, providerOptions as agentOptions } from "./providerOptions";
import { HOME, NO_COMMANDS, refreshProviders, startTask, updateDraft, useAgentCommands, useAgents } from "./store";
import styles from "./Home.module.css";

export function HomeEditor() {
  const tx = useTx();
  const txTemplate = useTxTemplate();
  const draft = useAgents((s) => s.draft);
  const providers = useAgents((s) => s.providers);
  const history = useAgents((s) => s.history);
  const composer = useAgents((s) => s.composers.get(HOME)) ?? emptyDraft();
  const project = useProject((s) => s.project);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Agents installed in Settings (its own window) show up when this one is back in front.
  useEffect(() => {
    const refresh = () => void refreshProviders();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    call(commands.vcsBranches(null))
      .then((list) => {
        const local = list.filter((b) => !b.remote);
        setBranches(local);
        setCurrent(local.find((b) => b.current)?.name ?? null);
      })
      .catch(() => setBranches([]));
  }, []);

  const provider = providers.find((p) => p.id === draft.provider) ?? providers[0];
  const probe = useProbe(provider?.installed ? provider.id : null);
  const agentCommands = useAgentCommands(provider?.id, null, provider?.commands ?? NO_COMMANDS);
  const providerOptions: SelectOption[] = agentOptions(providers, tx, providerIcon);
  // Without git under the project there are no worktrees: force the local checkout.
  const isGit = project?.isGit ?? false;
  const isolation = isGit ? draft.isolation : "local";
  const base = draft.base ?? current;
  const canStart = canSend(composer) && !!provider?.installed && !starting;
  const root = project?.root ?? "";

  const start = () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    startTask(isolation)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStarting(false));
  };
  const setOption = (id: string, value: string) => updateDraft({ config: { ...draft.config, [id]: value } });

  return (
    <div className={styles.home}>
      <div className={styles.inner}>
        <h1 className={styles.heading}>
          <T>What should the agent do?</T>
        </h1>
        <Composer
          id={HOME}
          autoFocus
          placeholder="Describe a task for the agent. @ references a file, / runs a command"
          root={root}
          projectRoot={root}
          commands={agentCommands}
          history={history}
          config={provider?.config ?? []}
          onConfig={setOption}
          onSubmit={start}
          disabled={!canStart}
          toolbar={
            <>
              <Select
                variant="ghost"
                aria-label="Agent"
                value={provider?.id ?? null}
                options={providerOptions}
                onChange={(id) =>
                  id === ADD_AGENT ? void executeAction("agents.addAgent") : updateDraft({ provider: id, config: {} })
                }
              />
              <ConfigPickers config={provider?.config ?? []} values={draft.config} onChange={setOption} />
            </>
          }
          actions={
            <Button variant="primary" size="small" disabled={!canStart} onClick={start}>
              {starting ? "Starting…" : "Start"}
            </Button>
          }
        />
        <div className={styles.where}>
          <span className={styles.project}>{project?.name}</span>
          {isGit && (
            <Select
              variant="ghost"
              aria-label="Isolation"
              value={isolation}
              options={[
                { value: "worktree", label: tx("New worktree"), icon: "branch", detail: tx("away from your changes") },
                {
                  value: "local",
                  label: tx("Local checkout"),
                  icon: "folder",
                  detail: tx("edits your files directly"),
                },
              ]}
              onChange={(isolation) => updateDraft({ isolation })}
            />
          )}
          {isolation === "local" && current && (
            <>
              <span className={styles.note}>
                <T>on</T>
              </span>
              <span className={styles.branch}>
                <Icon name="branch" size={14} />
                {current}
              </span>
            </>
          )}
          {isolation === "worktree" && branches.length > 0 && (
            <>
              <span className={styles.note}>
                <T>from</T>
              </span>
              <Select
                variant="ghost"
                aria-label="Base branch"
                value={base}
                options={branches.map((b) => ({ value: b.name, label: b.name }))}
                onChange={(b) => updateDraft({ base: b === current ? null : b })}
              />
            </>
          )}
        </div>
        {probe && (
          <p className={probe.error ? styles.warning : styles.note}>
            {probe.error
              ? txTemplate(`${provider?.name ?? probe.provider} didn't start: ${probe.error}`)
              : [probe.name, probe.version, probe.protocol].filter(Boolean).join(" · ")}
          </p>
        )}
        {(error || (provider && !provider.installed) || (provider && !provider.config.length)) && (
          <p
            className={error || !provider?.installed ? styles.warning : styles.note}
            role={error ? "alert" : undefined}
          >
            {error ??
              (provider && !provider.installed ? (
                txTemplate(`${provider.command} was not found on PATH`)
              ) : (
                <T>Models and modes appear after this agent's first task.</T>
              ))}
          </p>
        )}
      </div>
    </div>
  );
}

/** What the agent reports about itself when it starts (no session is opened), once per agent. */
function useProbe(provider: string | null): AgentProbe | null {
  const [probe, setProbe] = useState<AgentProbe | null>(null);
  useEffect(() => {
    if (!provider) return;
    let live = true;
    call(commands.agentProbe(provider, false))
      .then((p) => live && setProbe(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [provider]);
  return probe?.provider === provider ? probe : null;
}
