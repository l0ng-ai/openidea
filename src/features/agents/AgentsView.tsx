/** Agents tool window: tasks pinned above the user's groups, then by what they need from the user. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { EDITOR_TAB_MIME, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  Popup,
  Spinner,
  T,
  Tree,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  type IconName,
} from "@/ui";
import {
  SESSION_KIND,
  TASK_DRAG,
  age,
  branchLabel,
  groupStatus,
  groupTasks,
  providerIcon,
  sessionKey,
  type TaskGroup,
} from "./model";
import { groupMembers, pinnedMembers, ungroupedMembers, type OrganizeGroup } from "./organize";
import {
  importExternalSession,
  moveTasksToGroup,
  openHome,
  pinTasks,
  refreshExternalSessions,
  useAgents,
} from "./store";
import { groupMenu, taskMenu } from "./taskActions";
import { SessionEditor } from "./SessionEditor";
import { HomeEditor } from "./HomeEditor";
import styles from "./Agents.module.css";
import { basename, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";

export function AgentsHeaderActions() {
  return (
    <>
      <IconButton icon="plus" action="agents.newTask" />
      <IconButton icon="settings" action="agents.mcpServers" />
    </>
  );
}

/** Key of the pinned section, above the groups. */
const PINNED_KEY = "pinned";
/** Key of a group the user made. */
const customKey = (group: string) => `ug:${group}`;

type Node =
  | { kind: "pinned"; tasks: AgentTask[] }
  | { kind: "custom"; group: OrganizeGroup; tasks: AgentTask[] }
  | { kind: "group"; group: TaskGroup }
  | { kind: "task"; task: AgentTask };

function nodeKey(n: Node): string {
  switch (n.kind) {
    case "pinned":
      return PINNED_KEY;
    case "custom":
      return customKey(n.group.id);
    case "group":
      return `g:${n.group.status}`;
    case "task":
      return n.task.id;
  }
}

/** Where a task shows: the pinned section first, else its group, else its status group. */
function keysOf(task: AgentTask): string[] {
  const organize = useAgents.getState().organize;
  if (organize.pinned.includes(task.id)) return [PINNED_KEY];
  const group = organize.groupOf[task.id];
  if (group && organize.groups.some((g) => g.id === group)) return [customKey(group)];
  return [`g:${groupStatus(task.status)}`];
}

/** A group header; tasks dropped on it go into the group (or into the pinned section). */
function GroupRow({
  label,
  count,
  icon,
  onDropTask,
}: {
  label: ReactNode;
  count: number;
  icon?: IconName;
  onDropTask?: (task: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onDropTask) return;
    return registerDropTarget(el, {
      accepts: (type) => type === TASK_DRAG,
      over: () => setOver(true),
      leave: () => setOver(false),
      drop: (data) => {
        setOver(false);
        onDropTask(data.payload);
      },
    });
  }, [onDropTask]);
  return (
    <span ref={ref} className={clsx(styles.row, over && styles.dropOver)}>
      {icon && <Icon name={icon} size={12} />}
      <span className={styles.groupLabel}>{label}</span>
      <span className={styles.count}>{count}</span>
    </span>
  );
}

const sessionTask = (input: EditorInput | null | undefined) =>
  input?.kind === SESSION_KIND ? (input.data as { task?: string } | undefined)?.task : undefined;

/** The task of an editor tab drag payload (session tabs only), null for anything else. */
const sessionPayloadTask = (payload: string): string | null => {
  try {
    const p = JSON.parse(payload) as { paneId?: unknown; tabId?: unknown };
    if (typeof p.paneId !== "string" || typeof p.tabId !== "string") return null;
    const input = maybeEditorService()?.tabInput?.(p.paneId, p.tabId);
    return input?.kind === SESSION_KIND ? ((input.data as { task?: string }).task ?? null) : null;
  } catch {
    return null;
  }
};

function TaskStatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "running":
    case "starting":
      return <Spinner size={11} />;
    case "ready":
      return <Icon name="check" size={13} className={styles.ready} label="Ready" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.failed} label="Failed" />;
    case "limited":
      return <Icon name="clock" size={13} className={styles.failed} label="Usage limit" />;
    case "archived":
      return <Icon name="minus" size={13} className={styles.archived} label="Archived" />;
  }
}

export function AgentsView() {
  const project = useProject((s) => s.project);
  const tx = useTx();
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const providers = useAgents((s) => s.providers);
  const docked = useAgents((s) => s.docked);
  const homeOpen = useAgents((s) => s.homeOpen);
  const inline = docked !== null || homeOpen;
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const external = useAgents((s) => s.external);
  const externalError = useAgents((s) => s.externalError);
  const [importing, setImporting] = useState<string | null>(null);
  // Sessions started elsewhere (a terminal, another editor) list on demand (#312).
  useEffect(() => {
    if (historyOpen) void refreshExternalSessions();
  }, [historyOpen]);
  const importSession = (provider: string, sessionId: string) => {
    setImporting(`${provider}:${sessionId}`);
    void importExternalSession(provider, sessionId)
      .catch(() => {})
      .finally(() => setImporting(null));
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => {
    const task = sessionTask(maybeEditorService()?.activeInput?.());
    return new Set(task ? [task] : []);
  });
  const organize = useAgents((s) => s.organize);
  // Follow the active session tab.
  useEffect(
    () =>
      maybeEditorService()?.onActiveInputChange?.((input) => {
        const task = sessionTask(input);
        if (!task) return;
        setSelected((current) => (current.has(task) ? current : new Set([task])));
        const known = useAgents.getState().tasks.get(task);
        const keys = known ? keysOf(known) : [];
        if (keys.length)
          setCollapsed((c) => (keys.some((k) => c.has(k)) ? new Set([...c].filter((k) => !keys.includes(k))) : c));
      }),
    [],
  );
  const roots = useMemo<Node[]>(() => {
    const all = [...tasks.values()];
    const pinned = pinnedMembers(all, organize);
    return [
      ...(pinned.length ? [{ kind: "pinned", tasks: pinned } as Node] : []),
      ...organize.groups.map((group): Node => ({
        kind: "custom",
        group,
        tasks: groupMembers(tasks.values(), organize, group.id),
      })),
      ...groupTasks(ungroupedMembers(all, organize)).map((group): Node => ({ kind: "group", group })),
    ];
  }, [tasks, organize]);
  const expanded = useMemo(() => new Set(roots.map(nodeKey).filter((k) => !collapsed.has(k))), [roots, collapsed]);
  // Dropping a session editor tab anywhere on the tool window docks it.
  const viewRef = useRef<HTMLDivElement>(null);
  const [tabOver, setTabOver] = useState(false);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    return registerDropTarget(el, {
      accepts: (type) => type === EDITOR_TAB_MIME,
      over: (data) => setTabOver(sessionPayloadTask(data.payload) != null),
      leave: () => setTabOver(false),
      drop: (data) => {
        setTabOver(false);
        const task = sessionPayloadTask(data.payload);
        if (task) void executeAction("agents.dockTask", task);
      },
    });
  }, [loaded, error]);
  if (!loaded)
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  if (error) return <EmptyState title="Cannot load agent tasks">{error}</EmptyState>;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  // Opening any session follows the global placement preference.
  const showTask = (task: string) => {
    setHistoryOpen(false);
    void executeAction("agents.openTask", task);
  };
  const dockedTitle = docked ? (tasks.get(docked)?.title ?? docked) : null;
  const dragTask = (e: ReactPointerEvent<HTMLSpanElement>, task: string) =>
    startPointerDrag(e, e.currentTarget, { type: TASK_DRAG, payload: task });

  const taskList = (
    <div className={styles.tasks}>
      <Tree<Node>
        aria-label="Agent tasks"
        roots={roots}
        getKey={nodeKey}
        getLabel={(n) =>
          n.kind === "task"
            ? n.task.title
            : n.kind === "pinned"
              ? "Pinned"
              : n.kind === "custom"
                ? n.group.name
                : n.group.label
        }
        getChildren={(n) =>
          n.kind === "task"
            ? undefined
            : (n.kind === "group" ? n.group.tasks : n.tasks).map((task) => ({ kind: "task", task }) as Node)
        }
        isExpandable={(n) => n.kind !== "task"}
        expanded={expanded}
        onExpandedChange={(_next, node, open) =>
          setCollapsed((c) => {
            const s = new Set(c);
            if (open) s.delete(nodeKey(node));
            else s.add(nodeKey(node));
            return s;
          })
        }
        selected={selected}
        onSelectionChange={(sel, lead) => {
          setSelected(sel);
          if (!inline && sel.size === 1 && lead?.kind === "task" && sel.has(lead.task.id)) showTask(lead.task.id);
        }}
        onActivate={(n) => n.kind === "task" && showTask(n.task.id)}
        onContextMenu={(n, sel, e) => {
          if (!n) return;
          if (n.kind === "custom") {
            showContextMenu(e, groupMenu(n.group));
            return;
          }
          if (n.kind !== "task") return;
          const selection = [...sel].flatMap((id) => {
            const task = tasks.get(id);
            return task ? [task] : [];
          });
          showContextMenu(e, taskMenu(selection));
        }}
        renderNode={(n) => {
          switch (n.kind) {
            case "pinned":
              return (
                <GroupRow
                  icon="pin"
                  label={<T>Pinned</T>}
                  count={n.tasks.length}
                  onDropTask={(task) => pinTasks([task], true)}
                />
              );
            case "custom":
              return (
                <GroupRow
                  label={n.group.name}
                  count={n.tasks.length}
                  onDropTask={(task) => moveTasksToGroup([task], n.group.id)}
                />
              );
            case "group":
              return <GroupRow label={<T>{n.group.label}</T>} count={n.group.tasks.length} />;
            case "task":
              return (
                <span
                  className={styles.row}
                  title={n.task.error ?? n.task.title}
                  onPointerDown={(e) => dragTask(e, n.task.id)}
                  onClick={(e) => {
                    if (inline && !e.metaKey && !e.ctrlKey && !e.shiftKey) showTask(n.task.id);
                  }}
                >
                  <Icon name={providerIcon(n.task.provider)} size={16} label={providerName(n.task.provider)} />
                  <span className={styles.title} data-unread={unread.has(n.task.id) || undefined}>
                    {n.task.title}
                  </span>
                  {/* Ready tasks say so by their group; the others show what they're doing. */}
                  {n.task.status !== "ready" && <TaskStatusIcon status={n.task.status} />}
                  {unread.has(n.task.id) && (
                    <span className={styles.unreadDot} role="img" aria-label={tx("Unread")} title={tx("Unread")} />
                  )}
                  {project?.workspace && (
                    <span className={styles.taskProject} title={n.task.projectRoot ?? project.root}>
                      {basename(n.task.projectRoot ?? project.root)}
                    </span>
                  )}
                  {n.task.isolation === "worktree" && (
                    <span className={styles.detail}>{branchLabel(n.task.branch)}</span>
                  )}
                  <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
                </span>
              );
          }
        }}
        empty={
          <div className={styles.empty}>
            <T>No agent tasks yet</T>
            <button type="button" className={styles.link} onClick={() => openHome()}>
              <T>New Task…</T>
            </button>
          </div>
        }
      />
    </div>
  );

  return (
    <div ref={viewRef} className={clsx(styles.view, tabOver && styles.dropTarget)}>
      <div className={styles.content}>
        {inline && (
          <div className={styles.docked}>
            <div className={styles.dockedBar}>
              <IconButton
                ref={historyRef}
                icon="history"
                title="Agent sessions"
                aria-haspopup="dialog"
                aria-expanded={historyOpen}
                onClick={() => {
                  setSelected(new Set(docked ? [docked] : []));
                  setHistoryOpen((open) => !open);
                }}
              />
              <span
                className={styles.dockedTitle}
                title={dockedTitle ?? undefined}
                onPointerDown={(e) => docked && dragTask(e, docked)}
              >
                {homeOpen ? <T>New Agent Task</T> : dockedTitle}
              </span>
            </div>
            <div className={styles.dockedSession}>
              {homeOpen ? (
                <HomeEditor docked />
              ) : (
                docked && (
                  <SessionEditor
                    docked
                    input={{
                      kind: SESSION_KIND,
                      key: sessionKey(docked),
                      data: { task: docked, title: tasks.get(docked)?.title },
                    }}
                  />
                )
              )}
            </div>
          </div>
        )}
        {!inline && taskList}
        {inline && (
          <Popup
            open={historyOpen}
            anchor={historyRef}
            onClose={() => setHistoryOpen(false)}
            aria-label={tx("Agent sessions")}
            className={styles.history}
          >
            <div className={styles.historyTitle}>
              <T>Agent sessions</T>
            </div>
            {taskList}
            {(external.length > 0 || externalError) && (
              <>
                <div className={styles.historyTitle}>
                  <T>Sessions from other apps</T>
                </div>
                {externalError ? (
                  <div className={styles.empty}>{externalError}</div>
                ) : (
                  <div className={styles.external}>
                    {external.map((s) => {
                      const key = `${s.provider}:${s.sessionId}`;
                      return (
                        <div key={key} className={styles.row} title={s.cwd ?? s.sessionId}>
                          <Icon name={providerIcon(s.provider)} size={16} label={providerName(s.provider)} />
                          <span className={styles.title}>{s.title}</span>
                          <span className={styles.age}>{age(s.updatedMs ?? 0)}</span>
                          <button
                            type="button"
                            className={styles.link}
                            disabled={importing === key}
                            onClick={() => importSession(s.provider, s.sessionId)}
                          >
                            <T>Import</T>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </Popup>
        )}
      </div>
    </div>
  );
}
