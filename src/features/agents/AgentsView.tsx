/** Agents tool window: tasks pinned above the user's groups, then by what they need from the user. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { EDITOR_TAB_MIME, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import {
  EmptyState,
  HighlightedText,
  Icon,
  IconButton,
  Popup,
  SearchField,
  Spinner,
  T,
  Tree,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  type TreeHandle,
} from "@/ui";
import {
  GROUP_DRAG,
  SESSION_KIND,
  TASK_DRAG,
  age,
  branchLabel,
  groupStatus,
  providerIcon,
  sessionKey,
  type TaskGroup,
} from "./model";
import {
  PINNED_SECTION,
  canReorderTask,
  customSection,
  groupMembers,
  pinnedMembers,
  sectionOfTask,
  statusGroups,
  statusSection,
  type OrganizeGroup,
} from "./organize";
import {
  externalKey,
  forkExternalSession,
  importExternalSession,
  moveTasksToGroup,
  moveTasksToStatusGroup,
  openHome,
  pinTasks,
  refreshExternalSessions,
  reorderTask,
  reorderTaskGroup,
  showImportSessions,
  useAgents,
} from "./store";
import { canArchive, groupMenu, taskMenu } from "./taskActions";
import { setFocusedTaskList } from "./taskListFocus";
import { matchTask } from "./taskSearch";
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

type Node =
  | { kind: "pinned"; tasks: AgentTask[] }
  | { kind: "custom"; group: OrganizeGroup; tasks: AgentTask[] }
  | { kind: "group"; group: TaskGroup }
  | { kind: "task"; task: AgentTask };

function nodeKey(n: Node): string {
  switch (n.kind) {
    case "pinned":
      return PINNED_SECTION;
    case "custom":
      return customSection(n.group.id);
    case "group":
      return statusSection(n.group.status);
    case "task":
      return n.task.id;
  }
}

/** Where a task shows: the pinned section first, else its group, else its status group. */
function keysOf(task: AgentTask): string[] {
  return [sectionOfTask(task, useAgents.getState().organize)];
}

type DropIndicator = { kind: "section"; key: string } | { kind: "row"; key: string; position: "before" | "after" };

const sameIndicator = (a: DropIndicator | null, b: DropIndicator | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    a.key === b.key &&
    (a.kind !== "row" || b.kind !== "row" || a.position === b.position));

/** A group header row inside the task tree. */
function GroupRow({ label, count }: { label: ReactNode; count: number }) {
  return (
    <span className={styles.row}>
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
  const importing = useAgents((s) => s.importing);
  // Sessions started elsewhere (a terminal, another editor) list on demand (#312).
  useEffect(() => {
    if (historyOpen) void refreshExternalSessions();
  }, [historyOpen]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => {
    const task = sessionTask(maybeEditorService()?.activeInput?.());
    return new Set(task ? [task] : []);
  });
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => () => setFocusedTaskList(null), []);
  const organize = useAgents((s) => s.organize);
  const pinned = useMemo(() => new Set(organize.pinned), [organize.pinned]);
  const [query, setQuery] = useState("");
  const treeRef = useRef<TreeHandle>(null);
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
  // While searching: the matching tasks of every section, collapsed ones included; empty sections go.
  const matches = useMemo(() => {
    if (!query.trim()) return null;
    const found = new Map<string, number[]>();
    for (const task of tasks.values()) {
      const hit = matchTask(task, query);
      if (hit) found.set(task.id, hit);
    }
    return found;
  }, [tasks, query]);
  const roots = useMemo<Node[]>(() => {
    const all = [...tasks.values()].filter((t) => !matches || matches.has(t.id));
    const pinned = pinnedMembers(all, organize);
    return [
      ...(pinned.length ? [{ kind: "pinned", tasks: pinned } as Node] : []),
      ...organize.groups.flatMap((group): Node[] => {
        const members = groupMembers(all, organize, group.id);
        return matches && !members.length ? [] : [{ kind: "custom", group, tasks: members }];
      }),
      ...statusGroups(all, organize).map((group): Node => ({ kind: "group", group })),
    ];
  }, [tasks, organize, matches]);
  const expanded = useMemo(
    () => new Set(roots.map(nodeKey).filter((k) => matches || !collapsed.has(k))),
    [roots, collapsed, matches],
  );
  const searchingRef = useRef(false);
  useEffect(() => {
    searchingRef.current = matches !== null;
  }, [matches]);
  const cancelDragRef = useRef<(() => void) | undefined>(undefined);
  const [tasksEl, setTasksEl] = useState<HTMLDivElement | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  useEffect(() => {
    if (!tasksEl) return;
    let frame = 0;
    let pointer: { data: { type: string; payload: string }; x: number; y: number } | null = null;
    const resolveDrop = (data: { type: string; payload: string }, x: number, y: number) => {
      const rowEl = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tree-key]");
      if (!rowEl || !tasksEl.contains(rowEl)) return null;
      const targetKey = rowEl.dataset.treeKey;
      if (!targetKey) return null;
      const rect = rowEl.getBoundingClientRect();
      const position: "before" | "after" = y < rect.top + rect.height / 2 ? "before" : "after";

      if (data.type === GROUP_DRAG) {
        if (searchingRef.current || !targetKey.startsWith("ug:")) return null;
        const targetGroup = targetKey.slice(3);
        if (targetGroup === data.payload) return null;
        return {
          indicator: { kind: "row", key: targetKey, position } as DropIndicator,
          apply: () => reorderTaskGroup(data.payload, targetGroup, position),
        };
      }

      if (data.type !== TASK_DRAG) return null;
      const { tasks, organize } = useAgents.getState();
      const source = tasks.get(data.payload);
      if (!source) return null;

      if (targetKey === PINNED_SECTION) {
        return {
          indicator: { kind: "section", key: targetKey } as DropIndicator,
          apply: () => pinTasks([source.id], true),
        };
      }
      if (targetKey.startsWith("ug:")) {
        const groupId = targetKey.slice(3);
        if (!organize.groups.some((g) => g.id === groupId)) return null;
        return {
          indicator: { kind: "section", key: targetKey } as DropIndicator,
          apply: () => moveTasksToGroup([source.id], groupId),
        };
      }
      if (targetKey.startsWith("g:")) {
        if (sectionOfTask(source, organize) === targetKey) return null;
        if (statusSection(groupStatus(source.status)) !== targetKey) return null;
        return {
          indicator: { kind: "section", key: targetKey } as DropIndicator,
          apply: () => moveTasksToStatusGroup([source.id]),
        };
      }
      if (searchingRef.current) return null;
      const target = tasks.get(targetKey);
      if (!target || !canReorderTask(source, target, organize)) return null;
      return {
        indicator: { kind: "row", key: targetKey, position } as DropIndicator,
        apply: () => reorderTask(source.id, target.id, position),
      };
    };
    const update = () => {
      const next = pointer ? (resolveDrop(pointer.data, pointer.x, pointer.y)?.indicator ?? null) : null;
      setDropIndicator((cur) => (sameIndicator(cur, next) ? cur : next));
    };
    const scroll = () => {
      frame = 0;
      if (!pointer) return;
      const scroller = tasksEl.querySelector<HTMLElement>('[role="tree"]');
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const delta = pointer.y < rect.top + 24 ? -8 : pointer.y > rect.bottom - 24 ? 8 : 0;
      if (!delta) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, before + delta));
      if (scroller.scrollTop !== before) {
        update();
        frame = requestAnimationFrame(scroll);
      }
    };
    const leave = () => {
      pointer = null;
      cancelAnimationFrame(frame);
      frame = 0;
      setDropIndicator(null);
    };
    const unregister = registerDropTarget(tasksEl, {
      accepts: (type) => type === TASK_DRAG || type === GROUP_DRAG,
      over: (data, x, y) => {
        pointer = { data, x, y };
        update();
        if (!frame) frame = requestAnimationFrame(scroll);
      },
      leave,
      drop: (data, x, y) => {
        const hit = resolveDrop(data, x, y);
        leave();
        hit?.apply();
      },
    });
    return () => {
      cancelDragRef.current?.();
      leave();
      unregister();
    };
  }, [tasksEl]);
  const suppressClickRef = useRef(false);
  const mouseSelectingRef = useRef(false);
  const mouseSelectTimerRef = useRef<number | undefined>(undefined);
  const resetMouseSelecting = () => {
    mouseSelectingRef.current = false;
    if (mouseSelectTimerRef.current !== undefined) {
      window.clearTimeout(mouseSelectTimerRef.current);
      mouseSelectTimerRef.current = undefined;
    }
  };
  useEffect(() => resetMouseSelecting, []);
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
  const dragTask = (e: ReactPointerEvent<HTMLElement>, task: string, source: HTMLElement = e.currentTarget) => {
    suppressClickRef.current = false;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    cancelDragRef.current?.();
    cancelDragRef.current = startPointerDrag(
      e,
      source,
      { type: TASK_DRAG, payload: task },
      {
        onEnd: (dragged) => {
          suppressClickRef.current = dragged;
          cancelDragRef.current = undefined;
        },
      },
    );
  };
  const dragGroup = (e: ReactPointerEvent<HTMLElement>, group: string, source: HTMLElement = e.currentTarget) => {
    if (matches || organize.groups.length < 2 || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    cancelDragRef.current?.();
    cancelDragRef.current = startPointerDrag(
      e,
      source,
      { type: GROUP_DRAG, payload: group },
      {
        onEnd: () => {
          cancelDragRef.current = undefined;
        },
      },
    );
  };

  // The tasks under `task` in its section, for Archive All Below.
  const tasksBelow = (task: string): AgentTask[] => {
    for (const root of roots) {
      const members = root.kind === "group" ? root.group.tasks : root.kind === "task" ? [] : root.tasks;
      const at = members.findIndex((t) => t.id === task);
      if (at >= 0) return members.slice(at + 1);
    }
    return [];
  };
  const rowButton = (label: string, icon: "pin" | "archive", run: () => void) => (
    <button
      type="button"
      className={styles.rowAction}
      aria-label={tx(label)}
      title={tx(label)}
      // The row selects on mouse down and opens on double click; these buttons do neither.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );

  const taskList = (
    <div
      ref={setTasksEl}
      className={styles.tasks}
      onPointerDownCapture={() => {
        suppressClickRef.current = false;
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if ((e.target as Element).closest("button, input, textarea, [data-tree-toggle]")) return;
        const rowEl = (e.target as Element).closest<HTMLElement>("[data-tree-key]");
        const key = rowEl?.dataset.treeKey;
        if (!rowEl || !key) return;
        const ghostSource = rowEl.querySelector<HTMLElement>(`.${styles.row}`) ?? rowEl;
        if (tasks.has(key)) dragTask(e, key, ghostSource);
        else if (key.startsWith("ug:")) dragGroup(e, key.slice(3), ghostSource);
      }}
      onMouseDownCapture={(e) => {
        if (e.button !== 0 || (e.target as Element).closest("button, input, textarea, [data-tree-toggle]")) return;
        // Macrotask fallback (not microtask): browsers flush microtasks between React's capture
        // and bubble root listeners on real user clicks, which would clear this flag too early.
        mouseSelectingRef.current = true;
        if (mouseSelectTimerRef.current !== undefined) window.clearTimeout(mouseSelectTimerRef.current);
        mouseSelectTimerRef.current = window.setTimeout(resetMouseSelecting, 0);
      }}
      onMouseDown={resetMouseSelecting}
      onKeyDownCapture={resetMouseSelecting}
      onClick={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        if ((e.target as Element).closest("button, input, textarea, [data-tree-toggle]")) return;
        const key = (e.target as Element).closest<HTMLElement>("[data-tree-key]")?.dataset.treeKey;
        if (key && tasks.has(key)) showTask(key);
      }}
      onFocus={() => setFocusedTaskList(() => [...selectedRef.current])}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Element && e.currentTarget.contains(e.relatedTarget)))
          setFocusedTaskList(null);
      }}
    >
      {tasks.size > 0 && (
        <SearchField
          className={styles.taskSearch}
          variant="bare"
          value={query}
          onChange={setQuery}
          clearable
          placeholder={tx("Search tasks")}
          aria-label={tx("Search tasks")}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              treeRef.current?.moveSelection(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter") {
              const lead = treeRef.current?.leadKey();
              if (lead && tasks.has(lead)) {
                e.preventDefault();
                showTask(lead);
              }
            } else if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
      )}
      <Tree<Node>
        aria-label="Agent tasks"
        handleRef={treeRef}
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
        onSelectionChange={(sel, lead, reason) => {
          setSelected(sel);
          // Mouse clicks open on release (`onClick`) so starting a drag never opens the task.
          if (
            reason !== "contextMenu" &&
            !mouseSelectingRef.current &&
            !inline &&
            sel.size === 1 &&
            lead?.kind === "task" &&
            sel.has(lead.task.id)
          )
            showTask(lead.task.id);
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
          showContextMenu(e, taskMenu(selection, selection.length === 1 ? tasksBelow(n.task.id) : []));
        }}
        rowClassName={(n) => {
          if (!dropIndicator || dropIndicator.key !== nodeKey(n)) return undefined;
          if (dropIndicator.kind === "section") return styles.dropOver;
          return dropIndicator.position === "before" ? styles.dropBefore : styles.dropAfter;
        }}
        renderNode={(n) => {
          switch (n.kind) {
            case "pinned":
              return <GroupRow label={<T>Pinned</T>} count={n.tasks.length} />;
            case "custom":
              return <GroupRow label={n.group.name} count={n.tasks.length} />;
            case "group":
              return <GroupRow label={<T>{n.group.label}</T>} count={n.group.tasks.length} />;
            case "task":
              return (
                <span className={styles.row} title={n.task.error ?? n.task.title}>
                  <Icon name={providerIcon(n.task.provider)} size={16} label={providerName(n.task.provider)} />
                  <span className={styles.title} data-unread={unread.has(n.task.id) || undefined}>
                    {matches?.get(n.task.id)?.length ? (
                      <HighlightedText text={n.task.title} indices={matches.get(n.task.id)!} />
                    ) : (
                      n.task.title
                    )}
                  </span>
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
                  <span className={styles.rowActions}>
                    {pinned.has(n.task.id)
                      ? rowButton("Unpin", "pin", () => pinTasks([n.task.id], false))
                      : rowButton("Pin", "pin", () => pinTasks([n.task.id], true))}
                    {canArchive(n.task) &&
                      rowButton("Archive", "archive", () => void executeAction("agents.archiveTasks", [n.task.id]))}
                  </span>
                  {/* Ready tasks say so by their group; the others show what they're doing, in a column
                      beside the age so the marks line up whatever the title length. */}
                  {n.task.status !== "ready" && (
                    <span className={styles.status}>
                      <TaskStatusIcon status={n.task.status} />
                    </span>
                  )}
                  <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
                </span>
              );
          }
        }}
        empty={
          matches ? (
            <div className={styles.empty}>
              <T>No matching tasks</T>
            </div>
          ) : (
            <div className={styles.empty}>
              <T>No agent tasks yet</T>
              <button type="button" className={styles.link} onClick={() => openHome()}>
                <T>New Task…</T>
              </button>
              {/* Docked, the list shows in the history popup, which lists the sessions itself. */}
              {!inline && (
                <button type="button" className={styles.link} onClick={showImportSessions}>
                  <T>Import Sessions…</T>
                </button>
              )}
            </div>
          )
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
                      const key = externalKey(s.provider, s.sessionId);
                      return (
                        <div key={key} className={styles.row} title={s.cwd ?? s.sessionId}>
                          <Icon name={providerIcon(s.provider)} size={16} label={providerName(s.provider)} />
                          <span className={styles.title}>{s.title}</span>
                          <span className={styles.age}>{age(s.updatedMs ?? 0)}</span>
                          <button
                            type="button"
                            className={styles.link}
                            disabled={importing.has(key)}
                            onClick={() => void importExternalSession(s.provider, s.sessionId).catch(() => {})}
                          >
                            <T>Import</T>
                          </button>
                          <button
                            type="button"
                            className={styles.link}
                            disabled={importing.has(key)}
                            title={tx("Fork into a new task")}
                            onClick={() =>
                              void forkExternalSession(
                                s.provider,
                                s.sessionId,
                                s.cwd ?? useProject.getState().project?.root ?? "",
                              ).catch(() => {})
                            }
                          >
                            <T>Fork</T>
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
