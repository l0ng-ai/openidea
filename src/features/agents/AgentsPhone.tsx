/**
 * The Agents page on a phone: the task list, and a task's conversation or New Task as a
 * page of its own with a way back, as a phone's chat apps are laid out. The conversation,
 * composer and changes are the desktop's (`SessionEditor` / `HomeEditor` docked); what
 * belongs to a mouse and a large window (dragging tasks between groups, chat placement, the
 * history popup, organising groups, importing sessions) is left out. Long press opens a task's menu.
 */
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentTask } from "@/bindings";
import { Button, EmptyState, HighlightedText, Icon, IconButton, Menu, SearchField, Spinner, T } from "@/ui";
import { showContextMenu } from "@/ui";
import { tx, useTx } from "@/platform/i18n";
import { basename, useProject } from "@/platform/project";
import { useOwnToolWindowHeader, useToolWindowPageNav } from "@/workbench/toolwindows/ToolWindows";
import { SESSION_KIND, age, branchLabel, groupTasks, providerIcon, sessionKey, statusLabel } from "./model";
import { groupMembers, pinnedMembers, ungroupedMembers } from "./organize";
import { closeInline, openHome, openTask, useAgents } from "./store";
import { taskMenu } from "./taskActions";
import { matchTask } from "./taskSearch";
import { SessionEditor } from "./SessionEditor";
import { HomeEditor } from "./HomeEditor";
import { TaskStatusMark } from "./TaskStatusMark";
import styles from "./AgentsPhone.module.css";

export function AgentsPhone() {
  useOwnToolWindowHeader(true);
  const docked = useAgents((s) => s.docked);
  const homeOpen = useAgents((s) => s.homeOpen);
  const title = useAgents((s) => (docked ? (s.tasks.get(docked)?.title ?? docked) : null));
  const hasTask = useAgents((s) => !!docked && s.tasks.has(docked));
  // The shell's top bar leads back to the list from a task or New Task.
  const nav = useMemo(
    () =>
      homeOpen
        ? { title: tx("New Task"), back: closeInline }
        : docked
          ? {
              title,
              detail: hasTask ? <TaskDetail id={docked} /> : undefined,
              back: closeInline,
              actions: hasTask ? <TaskMenuButton id={docked} /> : undefined,
            }
          : null,
    [homeOpen, docked, title, hasTask],
  );
  useToolWindowPageNav(nav);
  if (homeOpen) return <HomeEditor docked />;
  if (docked) {
    return (
      <SessionEditor
        docked
        input={{ kind: SESSION_KIND, key: sessionKey(docked), data: { task: docked, title: title ?? undefined } }}
      />
    );
  }
  return <TaskList />;
}

function TaskMenuButton({ id }: { id: string }) {
  const task = useAgents((s) => s.tasks.get(id));
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!task) return null;
  return (
    <>
      <IconButton
        ref={ref}
        icon="more"
        title="Task Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={open ? taskMenu([task]) : []}
        placement="bottom-end"
      />
    </>
  );
}

function TaskDetail({ id }: { id: string }) {
  const task = useAgents((s) => s.tasks.get(id));
  if (!task) return null;
  return (
    <>
      <TaskStatusMark task={task.id} />
      <T>{statusLabel(task.status)}</T>
      {task.isolation === "worktree" && <span>· {branchLabel(task.branch)}</span>}
    </>
  );
}

interface Section {
  key: string;
  label: string;
  tasks: AgentTask[];
}

function TaskList() {
  const t = useTx();
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const organize = useAgents((s) => s.organize);
  const providers = useAgents((s) => s.providers);
  const project = useProject((s) => s.project);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const matches = useMemo(() => {
    if (!query.trim()) return null;
    const found = new Map<string, number[]>();
    for (const task of tasks.values()) {
      const hit = matchTask(task, query);
      if (hit) found.set(task.id, hit);
    }
    return found;
  }, [tasks, query]);
  const sections = useMemo<Section[]>(() => {
    const all = [...tasks.values()].filter((task) => !matches || matches.has(task.id));
    const pinned = pinnedMembers(all, organize);
    return [
      ...(pinned.length ? [{ key: "pinned", label: "Pinned", tasks: pinned }] : []),
      ...organize.groups.map((g) => ({ key: `c:${g.id}`, label: g.name, tasks: groupMembers(all, organize, g.id) })),
      ...groupTasks(ungroupedMembers(all, organize)).map((g) => ({
        key: `g:${g.status}`,
        label: g.label,
        tasks: g.tasks,
      })),
    ].filter((s) => s.tasks.length > 0);
  }, [tasks, organize, matches]);

  if (!loaded)
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  if (error) return <EmptyState title="Cannot load agent tasks">{error}</EmptyState>;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  return (
    <div className={styles.page}>
      <div className={styles.listBar}>
        {tasks.size > 0 ? (
          <SearchField
            className={styles.search}
            variant="bare"
            value={query}
            onChange={setQuery}
            clearable
            placeholder={t("Search tasks")}
            aria-label={t("Search tasks")}
          />
        ) : (
          <span className={styles.search} />
        )}
        <IconButton icon="plus" size="small" title="New Task" onClick={() => openHome()} />
      </div>
      <div className={styles.list}>
        {sections.length === 0 &&
          (matches ? (
            <p className={styles.empty}>
              <T>No matching tasks</T>
            </p>
          ) : (
            <div className={styles.center}>
              <Icon name="toolwindow-agents" size={32} />
              <p className={styles.empty}>
                <T>No agent tasks yet</T>
              </p>
              <Button variant="primary" onClick={() => openHome()}>
                <T>New Task</T>
              </Button>
            </div>
          ))}
        {sections.map((section) => {
          // Archived tasks stay folded until asked for (or found by a search).
          const folded = section.key === "g:archived" && !matches && !open.has(section.key);
          return (
            <section key={section.key} className={styles.section}>
              <button
                type="button"
                className={styles.sectionHead}
                aria-expanded={!folded}
                onClick={() =>
                  setOpen((o) => {
                    const next = new Set(o);
                    if (folded) next.add(section.key);
                    else next.delete(section.key);
                    return next;
                  })
                }
              >
                <span>{tx(section.label)}</span>
                <span className={styles.count}>{section.tasks.length}</span>
                {section.key === "g:archived" && <Icon name={folded ? "chevron-right" : "chevron-down"} size={14} />}
              </button>
              {!folded && (
                <ul className={styles.rows}>
                  {section.tasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={styles.row}
                        onClick={() => openTask(task.id)}
                        onContextMenu={(e) => showContextMenu(e, taskMenu([task]))}
                      >
                        <Icon name={providerIcon(task.provider)} size={20} label={providerName(task.provider)} />
                        <span className={styles.rowText}>
                          <span className={clsx(styles.rowTitle, unread.has(task.id) && styles.unread)}>
                            {matches?.get(task.id)?.length ? (
                              <HighlightedText text={task.title} indices={matches.get(task.id)!} />
                            ) : (
                              task.title
                            )}
                          </span>
                          <span className={styles.rowDetail}>
                            {task.status !== "ready" && task.status !== "archived" && (
                              <>
                                <TaskStatusMark task={task.id} />
                                <T>{statusLabel(task.status)}</T>
                                <span aria-hidden="true">·</span>
                              </>
                            )}
                            {project?.workspace && <span>{basename(task.projectRoot ?? project.root)} ·</span>}
                            {task.isolation === "worktree" && <span>{branchLabel(task.branch)} ·</span>}
                            <span>{age(task.updatedMs ?? 0)}</span>
                          </span>
                        </span>
                        {unread.has(task.id) && (
                          <span className={styles.unreadDot} role="img" aria-label={t("Unread")} />
                        )}
                        <Icon name="chevron-right" size={16} className={styles.chevron} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
