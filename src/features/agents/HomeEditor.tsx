/** New Task page: one prompt box with the agent and its settings; where it works in a quiet line under it. */
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import type { AgentProbe, Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { basename, useProject } from "@/platform/project";
import { Icon, Select, T, tooltipAttrs, type SelectOption } from "@/ui";
import { defaultTaskProject } from "./project";
import { maybeEditorService, useEditorShown, type EditorInput } from "@/workbench/contributions";
import { Composer } from "./Composer";
import { SubmitButton } from "./SubmitButton";
import { canSend, emptyDraft } from "./composerModel";
import { ConfigPickers } from "./ConfigPickers";
import { McpPicker } from "./McpPicker";
import { useEffortFocus } from "./effortFocus";
import { useAgentFontZoomSurface } from "./fontZoom";
import { HOME_KEY, providerIcon } from "./model";
import { ADD_AGENT, providerOptions as agentOptions } from "./providerOptions";
import {
  HOME,
  NO_COMMANDS,
  draftConfig,
  refreshProviders,
  refreshModels,
  setDraftMcpOverrides,
  setDraftOption,
  startTask,
  updateDraft,
  useAgentCommands,
  useAgents,
} from "./store";
import { useAgentSettings } from "./agentSettings";
import styles from "./Home.module.css";

export function HomeEditor({ docked = false, input }: { docked?: boolean; input?: EditorInput }) {
  const tx = useTx();
  const txTemplate = useTxTemplate();
  const draft = useAgents((s) => s.draft);
  const providers = useAgents((s) => s.providers);
  const history = useAgents((s) => s.history);
  const composer = useAgents((s) => s.composers.get(HOME)) ?? emptyDraft();
  const project = useProject((s) => s.project);
  const [selected, setSelected] = useState(() =>
    defaultTaskProject(project, maybeEditorService()?.activePath() ?? null, draft.projectRoot),
  );
  const members = project?.workspace?.projects ?? [];
  const root = members.includes(selected ?? "") ? selected! : (members[0] ?? project?.root ?? "");
  // A window without a project yet has no fact to show: the where row stays empty until it does.
  const projectLabel = members.length ? basename(root) : project?.name;
  const [repoState, setRepoState] = useState<{
    root: string;
    branches: Branch[];
    current: string | null;
    isGit: boolean;
  } | null>(null);
  const branches = repoState?.root === root ? repoState.branches : [];
  const current = repoState?.root === root ? repoState.current : null;
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [mcpOpenRequest, setMcpOpenRequest] = useState(0);
  // Kept mounted while another tab shows: what changed meanwhile is read again when it shows.
  const shown = useEditorShown();

  // Agents installed in Settings (its own window) show up when this one is back in front.
  useEffect(() => {
    const refresh = () => void refreshProviders();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    if (!shown) return;
    let live = true;
    const repo = project?.workspace ? root : null;
    void Promise.all([call(commands.vcsBranchInfo(repo)), call(commands.vcsBranches(repo))])
      .then(([info, list]) => {
        if (!live) return;
        setRepoState({ root, branches: list.filter((b) => !b.remote), current: info.head, isGit: true });
      })
      .catch(() => {
        if (live) setRepoState({ root, branches: [], current: null, isGit: false });
      });
    return () => {
      live = false;
    };
  }, [root, project?.workspace, shown]);

  const provider = providers.find((p) => p.id === draft.provider) ?? providers[0];
  const probe = useProbe(provider?.installed ? provider.id : null, provider?.command, shown);
  const catalog = useAgents((s) => s.modelCatalogs.get(provider?.id ?? ""));
  const requestingModels = useAgents((s) => s.modelRequests.has(provider?.id ?? ""));
  const requestTarget = useAgents((s) => s.modelRequestTargets.get(provider?.id ?? ""));
  const { defaults, fitWindowWidth } = useAgentSettings();
  const config = draftConfig(provider, draft, (provider && defaults[provider.id]) || {});
  const model = config.find((o) => o.category === "model");
  const selectedModel = model?.current ?? null;
  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);
  const attemptedModels = useRef(new Set<string>());
  const launch = provider && JSON.stringify([provider.program, provider.args, provider.env, provider.command]);
  useEffect(() => {
    if (!provider?.installed) return;
    const refresh = () => void refreshModels(provider.id, false, selectedModelRef.current);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [provider?.id, provider?.installed, launch, project?.root]);
  const unknownModelSettings =
    !!selectedModel &&
    !!model?.values.some((v) => v.value === selectedModel) &&
    !Object.hasOwn((catalog ?? provider)?.thoughtLevels ?? {}, selectedModel);
  useEffect(() => {
    if (!provider?.installed || !selectedModel || !unknownModelSettings) return;
    const key = JSON.stringify([provider.id, launch, project?.root, selectedModel]);
    if (requestTarget === selectedModel) attemptedModels.current.add(key);
    if (requestingModels || catalog?.refreshing || attemptedModels.current.has(key)) return;
    attemptedModels.current.add(key);
    void refreshModels(provider.id, false, selectedModel);
  }, [
    provider?.id,
    provider?.installed,
    launch,
    project?.root,
    selectedModel,
    unknownModelSettings,
    requestingModels,
    catalog,
    requestTarget,
  ]);
  const currentModelRequest = requestTarget === undefined || requestTarget === selectedModel;
  const homeRoot = useRef<HTMLDivElement>(null);
  const { zoomStyle } = useAgentFontZoomSurface(homeRoot, input?.key ?? HOME_KEY, docked);
  const unavailableModel = config.some(
    (o) =>
      o.category === "model" &&
      draft.config[o.id] !== undefined &&
      !o.values.some((v) => v.value === draft.config[o.id]),
  );
  const effortAnnouncement = useEffortFocus(homeRoot, shown && !starting && !unavailableModel, config, setDraftOption);
  const agentCommands = useAgentCommands(provider?.id, null, provider?.commands ?? NO_COMMANDS);
  const providerOptions: SelectOption[] = agentOptions(providers, tx, providerIcon);
  // Without git under the project there are no worktrees: force the local checkout.
  const isGit = project?.workspace ? repoState?.root === root && repoState.isGit : (project?.isGit ?? false);
  const isolation = isGit ? draft.isolation : "local";
  const base = draft.base ?? current;
  const canStart =
    canSend(composer) &&
    !!provider?.installed &&
    !unavailableModel &&
    !starting &&
    (!project?.workspace || repoState?.root === root);

  const openMcp = () => setMcpOpenRequest((n) => n + 1);
  // The agent shows as its icon; its name and version are in the tooltip.
  const agentTitle = [provider?.name ?? tx("Agent"), probe?.version].filter(Boolean).join(" ");

  const start = () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    startTask(isolation, project?.workspace ? root : null)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStarting(false));
  };

  return (
    <div
      ref={homeRoot}
      className={clsx(styles.home, docked && styles.docked, fitWindowWidth && styles.fitWidth)}
      style={zoomStyle}
    >
      {/* In the tool window the box sits at the bottom, under the question centred in the space above. */}
      {docked && (
        <div className={styles.dockedIntro}>
          <h1 className={styles.heading}>
            <T>What should the agent do?</T>
          </h1>
        </div>
      )}
      <div className={styles.inner}>
        {!docked && (
          <h1 className={styles.heading}>
            <T>What should the agent do?</T>
          </h1>
        )}
        <Composer
          id={HOME}
          className={docked ? undefined : styles.composer}
          autoFocus={shown}
          placeholder={docked ? "Describe a task…" : "Describe a task. @ for files, / for commands"}
          root={root}
          projectRoot={root}
          commands={agentCommands}
          history={history}
          config={config}
          onConfig={setDraftOption}
          onSubmit={start}
          onOpenMcp={openMcp}
          disabled={!canStart}
          addMenu={provider ? [{ id: "mcp", label: "MCP Servers…", icon: "plugin", run: openMcp }] : undefined}
          toolbar={
            <>
              <span className={styles.agentPicker} {...tooltipAttrs(agentTitle, undefined, true)}>
                <Select
                  variant="ghost"
                  aria-label="Agent"
                  value={provider?.id ?? null}
                  options={providerOptions}
                  renderValue={(o) => (o?.icon ? <Icon name={o.icon} size={14} /> : <T>Agent</T>)}
                  onChange={(id) =>
                    id === ADD_AGENT ? void executeAction("agents.addAgent") : updateDraft({ provider: id, config: {} })
                  }
                />
              </span>
              <ConfigPickers
                key={provider?.id}
                config={config}
                onChange={setDraftOption}
                modelRefresh={
                  provider?.installed
                    ? {
                        refreshing: requestingModels || (catalog?.refreshing ?? false),
                        loadingSettings: unknownModelSettings && (requestingModels || (catalog?.refreshing ?? false)),
                        retryAtMs:
                          currentModelRequest || (!unknownModelSettings && !catalog?.error)
                            ? (catalog?.retryAtMs ?? null)
                            : null,
                        error: !requestingModels && currentModelRequest ? (catalog?.error ?? null) : null,
                        onRefresh: () => void executeAction("agents.refreshModels"),
                      }
                    : undefined
                }
              />
              {provider && (
                <McpPicker
                  provider={provider.id}
                  overrides={draft.mcpOverrides}
                  onChange={setDraftMcpOverrides}
                  openRequest={mcpOpenRequest}
                  hideTrigger
                />
              )}
            </>
          }
          actions={
            <SubmitButton
              label={starting ? "Starting…" : "Start"}
              pending={starting}
              disabled={!canStart}
              onClick={start}
            />
          }
        />
        {/* Under the box: where the agent works. Project and checkout on the left, the branch on the right. */}
        <div className={styles.where}>
          {members.length > 1 ? (
            <Select
              variant="ghost"
              aria-label={tx("Project")}
              className={styles.projectPicker}
              value={root}
              options={members.map((path) => ({
                value: path,
                label: basename(path),
                detail: path,
                icon: "folder",
              }))}
              onChange={(path) => {
                setSelected(path);
                updateDraft({ base: null });
              }}
            />
          ) : projectLabel ? (
            <span className={styles.project} title={root}>
              <Icon name="folder" size={14} />
              <span className={styles.label}>{projectLabel}</span>
            </span>
          ) : null}
          {isGit && (
            <Select
              variant="ghost"
              aria-label="Isolation"
              value={isolation}
              options={[
                {
                  value: "local",
                  label: tx("Local checkout"),
                  icon: "folder",
                  detail: tx("edits your files directly"),
                },
                {
                  value: "worktree",
                  label: tx("New worktree"),
                  icon: "branch",
                  detail: tx("away from your changes"),
                },
              ]}
              renderValue={(o) => (o?.value === "worktree" ? tx("Worktree") : tx("Local"))}
              onChange={(isolation) => updateDraft({ isolation, isolationChosen: true })}
            />
          )}
          {/* A folder that isn't a repository has no branch: the one Git found below it isn't where the agent runs. */}
          {isolation === "local" && isGit && current && (
            <span className={styles.project} title={current}>
              <Icon name="branch" size={14} />
              <span className={styles.label}>{current}</span>
            </span>
          )}
          {isolation === "worktree" && branches.length > 0 && (
            <Select
              variant="ghost"
              aria-label="Base branch"
              searchable
              value={base}
              options={branches.map((b) => ({ value: b.name, label: b.name, icon: "branch" }))}
              onChange={(b) => updateDraft({ base: b === current ? null : b })}
            />
          )}
        </div>
        {/* Notes under the box don't take part in centring, so the box stays put as they come and go. */}
        <div className={styles.notes}>
          {effortAnnouncement && (
            <p className={styles.note} role="status" aria-live="polite" aria-atomic="true">
              {tx("Effort: {level}").replace("{level}", effortAnnouncement)}
            </p>
          )}
          {unavailableModel && (
            <p className={styles.warning} role="alert">
              <T>Choose another model before starting.</T>
            </p>
          )}
          {probe?.error && (
            <p className={styles.warning}>
              {txTemplate(`${provider?.name ?? probe.provider} didn't start: ${probe.error}`)}
            </p>
          )}
          {(error || (provider && !provider.installed)) && (
            <p
              className={error || !provider?.installed ? styles.warning : styles.note}
              role={error ? "alert" : undefined}
            >
              {error ?? txTemplate(`${provider?.command ?? ""} was not found on PATH`)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rechecks the installed agent when this page is shown or its window regains focus; opens no session. */
function useProbe(provider: string | null, command: string | undefined, shown: boolean): AgentProbe | null {
  const [probe, setProbe] = useState<AgentProbe | null>(null);
  useEffect(() => {
    if (!provider || !shown) return;
    let live = true;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      call(commands.agentProbe(provider, true))
        .then((p) => live && setProbe(p))
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [provider, command, shown]);
  return probe?.provider === provider ? probe : null;
}
