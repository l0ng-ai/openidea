import type { AgentChange, AgentCommit, AgentConfigOption, AgentEntry, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx, useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { Icon, IconButton, T, type IconName } from "@/ui";
import { notifications, useEditorShown } from "@/workbench/contributions";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Composer } from "../Composer";
import { ConfigPickers } from "../ConfigPickers";
import { HermesProfilePicker } from "../HermesProfilePicker";
import { McpPicker } from "../McpPicker";
import { SkillsPicker } from "../SkillsPicker";
import styles from "../Session.module.css";
import { SessionAssets } from "../SessionAssets";
import { SubmitButton } from "../SubmitButton";
import { useAgentSettings } from "../agentSettings";
import { canSend, emptyDraft } from "../composerModel";
import { useEffortFocus } from "../effortFocus";
import { isBusy } from "../model";
import { asksInCard, type PermissionEntry } from "../permission";
import {
  stopTask,
  editQueued,
  refreshTaskModels,
  removeQueued,
  sendMessage,
  sendQueuedNow,
  setTaskConfig,
  setTaskMcpOverrides,
  setTaskSkillOverrides,
  stopBackgroundTask,
  useAgentCommands,
  useAgents,
} from "../store";
import { PermissionLine } from "./QuestionForm";
import { SessionStatus } from "./SessionStatus";
import { Elapsed } from "./WorkingRow";
import { WorkingSubagents } from "./toolEntries";

/**
 * What needs the user or tells where the agent is, above the composer: an approval it
 * waits for (answered with 1, 2, 3… when the focus isn't in a text field), the plan,
 * then what runs and what is queued, and a line saying what it does now.
 */
function Tray({ task, entries, children }: { task: AgentTask; entries: AgentEntry[] | null; children: ReactNode }) {
  const tx = useTx();
  const pending = entries?.find((e): e is PermissionEntry => e.type === "permission" && !e.chosen && !asksInCard(e));
  const plan = entries?.findLast((e): e is Extract<AgentEntry, { type: "plan" }> => e.type === "plan");
  const [planOpen, setPlanOpen] = useState(false);
  const done = plan?.items.filter((i) => i.status === "completed").length ?? 0;
  const planShown = plan && plan.items.length > 0 && done < plan.items.length;
  return (
    <div className={styles.tray}>
      {pending && <PendingPermission task={task} entry={pending} />}
      {planShown && (
        <div className={styles.trayStrip}>
          <button
            type="button"
            className={styles.trayChip}
            aria-expanded={planOpen}
            onClick={() => setPlanOpen(!planOpen)}
          >
            <Icon name="todo" size={13} />
            {tx`Plan ${done}/${plan.items.length}`}
          </button>
        </div>
      )}
      {planShown && planOpen && (
        <div className={styles.trayPlan}>
          {plan.items.map((item, i) => (
            <div
              key={i}
              className={clsx(
                styles.planItem,
                item.status === "completed" && styles.planDone,
                item.status === "in_progress" && styles.planCurrent,
              )}
            >
              <Icon
                name={item.status === "completed" ? "check" : item.status === "in_progress" ? "run" : "minus"}
                size={12}
              />
              {item.content}
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

/** The approval the agent waits for, with its answers on 1, 2, 3… */
function PendingPermission({ task, entry }: { task: AgentTask; entry: PermissionEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useEditorShown();
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Only while this session holds the focus: keys typed elsewhere never answer for it.
      if (!target || !el.closest(`.${styles.session}`)?.contains(target)) return;
      if (target.closest("input, textarea, [contenteditable='true'], .cm-editor")) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      const button = el.querySelectorAll<HTMLButtonElement>(`.${styles.permissionOption}`)[n - 1];
      if (!button || button.disabled) return;
      e.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);
  // Answered, the card goes: the focus it had moves on to the composer.
  useLayoutEffect(() => {
    const el = ref.current;
    const area = el?.closest(`.${styles.composerArea}`);
    return () => {
      if (!el?.contains(document.activeElement) && document.activeElement !== document.body) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement?.isConnected)
          area?.querySelector<HTMLElement>(".cm-content")?.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <div ref={ref} className={styles.trayAsk}>
      <PermissionLine task={task} entry={entry} />
    </div>
  );
}

export function SessionComposer({
  task,
  focusRequest,
  focusRoot,
  entries,
  head,
  changes,
  commits,
  changesOpen,
  onToggleChanges,
  onOpenSubagent,
}: {
  task: AgentTask;
  focusRequest: number;
  focusRoot: RefObject<HTMLDivElement | null>;
  entries: AgentEntry[] | null;
  head: string | null;
  changes: AgentChange[] | null;
  commits: readonly AgentCommit[];
  changesOpen: boolean;
  onToggleChanges: () => void;
  onOpenSubagent: (id: string) => void;
}) {
  const { sendWith, whileRunning } = useAgentSettings();
  const project = useProject((s) => s.project);
  const composer = useAgents((s) => s.composers.get(task.id)) ?? emptyDraft();
  const provider = useAgents((s) => s.providers.find((p) => p.id === task.provider));
  const catalog = useAgents((s) => s.modelCatalogs.get(task.provider));
  const requestingModels = useAgents((s) => s.modelRequests.has(task.provider));
  const model = task.config.find((o) => o.category === "model");
  const catalogModel = (catalog?.config ?? provider?.config)?.find((o) => o.category === "model");
  const canRefreshModels =
    task.status !== "archived" &&
    (!!model || !!task.model || !!catalogModel) &&
    !!provider?.installed &&
    project?.trusted !== false;
  const pickerConfig = useMemo(() => {
    if (!canRefreshModels) return task.config;
    if (!model) {
      const recovered: AgentConfigOption =
        catalogModel === undefined
          ? {
              id: "model",
              name: "Model",
              description: null,
              category: "model",
              current: task.model,
              values: [],
              via: "option",
            }
          : { ...catalogModel, current: task.model ?? catalogModel.current };
      return [...task.config, recovered];
    }
    // The agent's current catalog is what a chat can switch to. The session's own list only
    // keeps the model it runs selectable when the catalog no longer offers it.
    const offered = catalogModel?.values;
    if (!offered?.length) return task.config;
    const kept = model.values.filter(
      (v) => (v.value === model.current || v.value === task.model) && !offered.some((o) => o.value === v.value),
    );
    return task.config.map((o) => (o === model ? { ...model, values: [...offered, ...kept] } : o));
  }, [task.config, task.model, model, model?.current, catalogModel, canRefreshModels]);
  const [sending, setSending] = useState(false);
  const configChange = useRef<{ loadingModel: boolean } | null>(null);
  const [configuring, setConfiguring] = useState<typeof configChange.current>(null);
  const [mcpOpenRequest, setMcpOpenRequest] = useState(0);
  const [skillsOpenRequest, setSkillsOpenRequest] = useState(0);
  const [assetFocus, setAssetFocus] = useState(0);
  const agentCommands = useAgentCommands(task.provider, task.id, task.commands);
  const busy = isBusy(task.status);
  const shellRunning = useAgents((s) => s.shellRunning.has(task.id));
  // ↑ recalls this conversation's messages, newest first.
  const history = useMemo(
    () => (entries ?? []).flatMap((e) => (e.type === "user" && e.text ? [e.text] : [])).reverse(),
    [entries],
  );
  // Only a running turn of an agent that takes messages mid-turn can be steered: otherwise
  // "now" would cancel the turn, so the message waits for it instead.
  const steers =
    whileRunning === "steer" &&
    !!task.capabilities?.steer &&
    task.status === "running" &&
    (composer.images.length === 0 || !!task.capabilities.images);
  const send = (now: boolean) => {
    if (!canSend(composer) || sending || configChange.current || task.status === "archived") return;
    setSending(true);
    sendMessage(task.id, now && (whileRunning !== "steer" || steers))
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: "Couldn't send the message",
          body: String(e),
        }),
      )
      .finally(() => setSending(false));
  };
  const setOption = (id: string, value: string) => {
    const pickerModel = pickerConfig.find((o) => o.category === "model");
    const changingModel = id === pickerModel?.id;
    const loadingModel = changingModel && !model?.values.some((v) => v.value === value);
    const pendingModel = model?.current != null && model.current !== task.model;
    const change = loadingModel || (changingModel && configChange.current) || pendingModel ? { loadingModel } : null;
    if (change) {
      configChange.current = change;
      setConfiguring(change);
    }
    void setTaskConfig(task.id, id, value)
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: "Couldn't change the setting",
          body: String(e),
        }),
      )
      .finally(() => {
        if (change && configChange.current === change) {
          configChange.current = null;
          setConfiguring(null);
        }
      });
  };
  const openMcp = () => setMcpOpenRequest((n) => n + 1);
  const openSkills = () => setSkillsOpenRequest((n) => n + 1);
  const shown = useEditorShown();
  const effortAnnouncement = useEffortFocus(focusRoot, shown && task.status !== "archived", task.config, setOption);
  return (
    <div className={styles.composerArea}>
      {task.status === "archived" && (
        <div className={styles.banner}>
          <span className={styles.bannerText}>
            <T>This task is archived. Unarchive it to continue the conversation.</T>
          </span>
          <IconButton
            icon="undo"
            title="Unarchive"
            onClick={() => void executeAction("agents.unarchiveTasks", [task.id])}
          />
        </div>
      )}
      <Tray task={task} entries={entries}>
        <WorkingSubagents entries={entries} onOpen={onOpenSubagent} />
        <BackgroundTasks task={task} />
        {task.queue.length > 0 && <Queue task={task} />}
      </Tray>
      <SessionAssets task={task} entries={entries} head={head} onFocusComposer={() => setAssetFocus((n) => n + 1)} />
      <Composer
        id={task.id}
        focusRequest={focusRequest + assetFocus}
        placeholder={
          !busy
            ? "Reply to the agent"
            : steers
              ? "Send into the agent's turn"
              : whileRunning === "steer"
                ? "Queue a message for when the agent is done"
                : sendWith === "enter"
                  ? "Queue a message for when the agent is done (⌘↵ sends it now)"
                  : "Queue a message for when the agent is done (⌘⇧↵ sends it now)"
        }
        root={task.cwd}
        projectRoot={task.projectRoot ?? project?.root ?? task.cwd}
        commands={agentCommands}
        history={history}
        config={task.config}
        onConfig={setOption}
        onSubmit={send}
        onOpenMcp={openMcp}
        onOpenSkills={openSkills}
        disabled={task.status === "archived"}
        addMenu={[
          { id: "mcp", label: "MCP Servers…", icon: "plugin", disabled: task.status === "archived", run: openMcp },
          { id: "skills", label: "Skills…", icon: "bulb", disabled: task.status === "archived", run: openSkills },
        ]}
        toolbar={
          <>
            <HermesProfilePicker provider={task.provider} />
            <ConfigPickers
              config={pickerConfig}
              onChange={setOption}
              modelRefresh={
                canRefreshModels
                  ? {
                      refreshing: requestingModels || (catalog?.refreshing ?? false),
                      loadingSettings: configuring?.loadingModel,
                      retryAtMs: catalog?.retryAtMs ?? null,
                      error: requestingModels ? null : (catalog?.error ?? null),
                      onOpen: () => void refreshTaskModels(task.id, false),
                      onRefresh: () => void executeAction("agents.refreshModels", task.id),
                    }
                  : undefined
              }
            />
            <McpPicker
              provider={task.provider}
              overrides={task.mcpOverrides}
              disabled={task.status === "archived"}
              busy={busy}
              openRequest={mcpOpenRequest}
              hideTrigger
              onChange={(next) =>
                void setTaskMcpOverrides(task.id, next).catch((e: unknown) =>
                  notifications().notify({
                    level: "error",
                    title: "Couldn't change the setting",
                    body: String(e),
                  }),
                )
              }
            />
            <SkillsPicker
              provider={task.provider}
              overrides={task.skillOverrides}
              disabled={task.status === "archived"}
              busy={busy}
              openRequest={skillsOpenRequest}
              hideTrigger
              onChange={(next) =>
                void setTaskSkillOverrides(task.id, next).catch((e: unknown) =>
                  notifications().notify({
                    level: "error",
                    title: "Couldn't change the setting",
                    body: String(e),
                  }),
                )
              }
            />
          </>
        }
        actions={
          <>
            {(busy || shellRunning) && <IconButton icon="stop" title="Stop" onClick={() => void stopTask(task.id)} />}
            <SubmitButton
              label={busy ? "Queue" : "Send"}
              pending={sending}
              variant={busy ? "secondary" : "primary"}
              disabled={!canSend(composer) || sending || configuring !== null || task.status === "archived"}
              onClick={() => send(false)}
            />
          </>
        }
      />
      <SessionStatus
        task={task}
        entries={entries}
        head={head}
        changes={changes}
        commits={commits}
        changesOpen={changesOpen}
        onToggleChanges={onToggleChanges}
        effortAnnouncement={effortAnnouncement}
      />
    </div>
  );
}

/** Messages waiting for the turn to end: send now, edit, or drop. */
const BACKGROUND_ICON: Record<string, IconName> = {
  local_bash: "terminal",
  monitor: "eye",
};

/** What the agent runs in the background; its subagents show as chips of their own. */
function BackgroundTasks({ task }: { task: AgentTask }) {
  const tx = useTx();
  const running = (task.background ?? []).filter((background) => background.kind !== "local_agent");
  if (!running.length) return null;
  const fail = (e: unknown) =>
    notifications().notify({
      level: "error",
      title: "Couldn't stop the background task",
      body: String(e),
    });
  return (
    <div className={styles.background} aria-label={tx("Running in the background")}>
      {running.map((background) => (
        <div key={background.id} className={styles.backgroundTask}>
          <Icon name={BACKGROUND_ICON[background.kind] ?? "clock"} size={12} className={styles.muted} />
          <span className={styles.backgroundText} title={background.description}>
            {background.description || background.kind}
          </span>
          {background.startedMs != null && <Elapsed since={background.startedMs} />}
          {task.capabilities?.backgroundTasks && (
            <IconButton
              icon="stop"
              title="Stop"
              size="small"
              onClick={() => void stopBackgroundTask(task.id, background.id).catch(fail)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Queue({ task }: { task: AgentTask }) {
  const fail = (e: unknown) =>
    notifications().notify({
      level: "error",
      title: "Couldn't update the queue",
      body: String(e),
    });
  return (
    <div className={styles.queue} aria-label={tx("Queued messages")}>
      {task.queue.map((q) => (
        <div key={q.id} className={styles.queued}>
          <Icon name="pause" size={12} className={styles.muted} />
          <span className={styles.queuedText} title={q.prompt.text}>
            {q.prompt.text || <T>Image</T>}
          </span>
          <IconButton icon="arrow-up" title="Send now" onClick={() => void sendQueuedNow(task.id, q.id).catch(fail)} />
          <IconButton icon="edit" title="Edit" onClick={() => void editQueued(task.id, q.id).catch(fail)} />
          <IconButton icon="close" title="Remove" onClick={() => void removeQueued(task.id, q.id).catch(fail)} />
        </div>
      ))}
    </div>
  );
}
