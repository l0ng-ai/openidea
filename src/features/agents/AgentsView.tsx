/** Agents tool window: tasks grouped by what they need from the user. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
} from "@/ui";
import { SESSION_KIND, TASK_DRAG, age, branchLabel, groupTasks, sessionKey, type TaskGroup } from "./model";
import { openHome, useAgents } from "./store";
import { taskMenu } from "./taskActions";
import { SessionEditor } from "./SessionEditor";
import { HomeEditor } from "./HomeEditor";
import styles from "./Agents.module.css";
import { basename, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";

export function AgentsHeaderActions() {
  return <IconButton icon="plus" action="agents.newTask" size="small" />;
}

export function AgentsLocationActions() {
  const location = useAgents((s) => s.sessionLocation);
  const tx = useTx();
  return (
    <div role="group" aria-label={tx("Conversation location")} className={styles.location}>
      <IconButton
        icon="open-in-tool-window"
        action="agents.useToolWindow"
        pressed={location === "toolWindow"}
        size="small"
      />
      <IconButton icon="editor-only" action="agents.useEditor" pressed={location === "editor"} size="small" />
    </div>
  );
}

type Node = { kind: "group"; group: TaskGroup } | { kind: "task"; task: AgentTask };

const nodeKey = (n: Node) => (n.kind === "group" ? `g:${n.group.status}` : n.task.id);

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

export function TaskStatusIcon({ status }: { status: Status }) {
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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => {
    const task = sessionTask(maybeEditorService()?.activeInput?.());
    return new Set(task ? [task] : []);
  });
  // Follow the active session tab.
  useEffect(
    () =>
      maybeEditorService()?.onActiveInputChange?.((input) => {
        const task = sessionTask(input);
        if (!task) return;
        setSelected((current) => (current.has(task) ? current : new Set([task])));
        const group = groupTasks(useAgents.getState().tasks.values()).find((g) => g.tasks.some((t) => t.id === task));
        const key = group && `g:${group.status}`;
        if (key) setCollapsed((c) => (c.has(key) ? new Set([...c].filter((k) => k !== key)) : c));
      }),
    [],
  );
  const roots = useMemo<Node[]>(() => groupTasks(tasks.values()).map((group) => ({ kind: "group", group })), [tasks]);
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
        getLabel={(n) => (n.kind === "group" ? n.group.label : n.task.title)}
        getChildren={(n) =>
          n.kind === "group" ? n.group.tasks.map((task) => ({ kind: "task", task }) as Node) : undefined
        }
        isExpandable={(n) => n.kind === "group"}
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
          if (n?.kind !== "task") return;
          const selection = [...sel].flatMap((id) => {
            const task = tasks.get(id);
            return task ? [task] : [];
          });
          showContextMenu(e, taskMenu(selection));
        }}
        renderNode={(n) =>
          n.kind === "group" ? (
            <span className={styles.row}>
              <span className={styles.groupLabel}>
                <T>{n.group.label}</T>
              </span>
              <span className={styles.count}>{n.group.tasks.length}</span>
            </span>
          ) : (
            <span
              className={styles.row}
              title={n.task.error ?? n.task.title}
              onPointerDown={(e) => dragTask(e, n.task.id)}
              onClick={(e) => {
                if (inline && !e.metaKey && !e.ctrlKey && !e.shiftKey) showTask(n.task.id);
              }}
            >
              <TaskStatusIcon status={n.task.status} />
              <span className={styles.title} data-unread={unread.has(n.task.id) || undefined}>
                {n.task.title}
              </span>
              {unread.has(n.task.id) && (
                <span className={styles.unreadDot} role="img" aria-label={tx("Unread")} title={tx("Unread")} />
              )}
              {project?.workspace && (
                <span className={styles.taskProject} title={n.task.projectRoot ?? project.root}>
                  {basename(n.task.projectRoot ?? project.root)}
                </span>
              )}
              <span className={styles.detail}>
                {providerName(n.task.provider)}
                {n.task.isolation === "worktree" ? ` · ${branchLabel(n.task.branch)}` : ""}
              </span>
              <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
            </span>
          )
        }
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
                size="small"
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
          </Popup>
        )}
      </div>
    </div>
  );
}
