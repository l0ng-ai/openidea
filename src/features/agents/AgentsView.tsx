/** Agents tool window: tasks grouped by what they need from the user. */
import { useMemo, useState } from "react";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { confirmChecked } from "@/workbench/messages";
import { EmptyState, Icon, IconButton, Spinner, T, Tree, showContextMenu, type MenuItem } from "@/ui";
import { age, branchLabel, groupTasks, isBusy, type TaskGroup } from "./model";
import { archiveTask, deleteTask, openHome, openTask, useAgents } from "./store";
import styles from "./Agents.module.css";
import { tx } from "@/platform/i18n";

export function AgentsHeaderActions() {
  return <IconButton icon="plus" action="agents.newTask" size="small" />;
}

type Node = { kind: "group"; group: TaskGroup } | { kind: "task"; task: AgentTask };

const nodeKey = (n: Node) => (n.kind === "group" ? `g:${n.group.status}` : n.task.id);

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
    case "archived":
      return <Icon name="minus" size={13} className={styles.archived} label="Archived" />;
  }
}

export function AgentsView() {
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const providers = useAgents((s) => s.providers);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const roots = useMemo<Node[]>(() => groupTasks(tasks.values()).map((group) => ({ kind: "group", group })), [tasks]);
  const expanded = useMemo(() => new Set(roots.map(nodeKey).filter((k) => !collapsed.has(k))), [roots, collapsed]);
  if (!loaded)
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  if (error) return <EmptyState title="Cannot load agent tasks">{error}</EmptyState>;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  return (
    <div className={styles.view}>
      <Tree<Node>
        aria-label="Agent tasks"
        roots={roots}
        getKey={nodeKey}
        getLabel={(n) => (n.kind === "group" ? n.group.label : n.task.title)}
        getChildren={(n) => (n.kind === "group" ? n.group.tasks.map((task) => ({ kind: "task", task }) as Node) : undefined)}
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
          if (lead?.kind === "task") openTask(lead.task.id);
        }}
        onActivate={(n) => n.kind === "task" && openTask(n.task.id)}
        onContextMenu={(n, _sel, e) => n?.kind === "task" && showContextMenu(e, taskMenu(n.task))}
        renderNode={(n) =>
          n.kind === "group" ? (
            <span className={styles.row}>
              <span className={styles.groupLabel}>
                <T>{n.group.label}</T>
              </span>
              <span className={styles.count}>{n.group.tasks.length}</span>
            </span>
          ) : (
            <span className={styles.row} title={n.task.error ?? n.task.title}>
              <TaskStatusIcon status={n.task.status} />
              <span className={styles.title}>{n.task.title}</span>
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
}

function taskMenu(task: AgentTask): MenuItem[] {
  const busy = isBusy(task.status);
  return [
    { label: "Open", run: () => openTask(task.id) },
    { label: "Open in Terminal", icon: "terminal", run: () => void executeAction("terminal.openAt", task.cwd) },
    { kind: "separator" },
    { label: "Archive", disabled: busy || task.status === "archived", run: () => void archiveTask(task.id) },
    { label: "Delete…", run: () => void confirmDelete(task) },
  ];
}

async function confirmDelete(task: AgentTask) {
  const worktree = task.isolation === "worktree";
  const r = await confirmChecked({
    title: "Delete Agent Task",
    message: worktree
      ? tx`Delete “${task.title}”? Its branch ${task.branch ?? ""} is kept.`
      : tx`Delete “${task.title}”? Files it changed are kept.`,
    ok: "Delete",
    icon: "warning",
    checkbox: worktree ? "Also remove its worktree folder" : undefined,
    checked: worktree,
  });
  if (r) await deleteTask(task.id, worktree && r.checked);
}
