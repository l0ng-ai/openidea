import type { AgentTask } from "@/bindings";
import type { Action } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { MenuItem } from "@/ui";
import { showError, confirmChecked } from "@/workbench/messages";
import { isBusy } from "./model";
import { archiveTask, deleteTask, openTask, useAgents } from "./store";

const canArchive = (task: AgentTask) => !isBusy(task.status) && task.status !== "archived";

function resolveTasks(arg: unknown): AgentTask[] {
  if (!Array.isArray(arg)) return [];
  return [...new Set(arg)].flatMap((id: unknown) => {
    const task = typeof id === "string" ? useAgents.getState().tasks.get(id) : undefined;
    return task ? [task] : [];
  });
}

async function runTasks(tasks: AgentTask[], run: (task: AgentTask) => Promise<unknown>, title: string) {
  const errors: string[] = [];
  for (const task of tasks) {
    try {
      await run(task);
    } catch (error) {
      errors.push(`${task.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) await showError(title, errors.join("\n"));
}

async function confirmDelete(tasks: AgentTask[]) {
  if (!tasks.length) return;
  const task = tasks[0]!;
  const multiple = tasks.length > 1;
  const worktree = tasks.some((t) => t.isolation === "worktree");
  const r = await confirmChecked({
    title: multiple ? "Delete Agent Tasks" : "Delete Agent Task",
    message: multiple
      ? tx`Delete ${tasks.length} agent tasks? Their branches and files outside worktrees are kept.`
      : worktree
        ? tx`Delete “${task.title}”? Its branch ${task.branch ?? ""} is kept.`
        : tx`Delete “${task.title}”? Files it changed are kept.`,
    ok: "Delete",
    icon: "warning",
    checkbox: worktree
      ? multiple
        ? "Also remove their worktree folders"
        : "Also remove its worktree folder"
      : undefined,
    checked: worktree,
  });
  if (r)
    await runTasks(
      tasks,
      (t) => deleteTask(t.id, t.isolation === "worktree" && r.checked),
      tx("Cannot delete agent tasks"),
    );
}

export const taskActions: Action[] = [
  {
    id: "agents.openTask",
    title: "Open Agent Task",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      if (typeof arg === "string") openTask(arg);
    },
  },
  {
    id: "agents.archiveTasks",
    title: "Archive Agent Tasks",
    category: "Agents",
    hidden: true,
    run: ({ arg }) =>
      runTasks(resolveTasks(arg).filter(canArchive), (task) => archiveTask(task.id), tx("Cannot archive agent tasks")),
  },
  {
    id: "agents.deleteTasks",
    title: "Delete Agent Tasks",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => confirmDelete(resolveTasks(arg)),
  },
];

export function taskMenu(tasks: AgentTask[]): MenuItem[] {
  if (!tasks.length) return [];
  const ids = tasks.map((task) => task.id);
  const task = tasks[0]!;
  const multiple = tasks.length > 1;
  const archivable = tasks.filter(canArchive).length;
  return [
    ...(!multiple
      ? ([
          { kind: "action", action: "agents.openTask", label: "Open", arg: task.id },
          { kind: "action", action: "terminal.openAt", label: "Open in Terminal", icon: "terminal", arg: task.cwd },
          { kind: "separator" },
        ] satisfies MenuItem[])
      : []),
    {
      kind: "action",
      action: "agents.archiveTasks",
      label: multiple ? tx`Archive (${archivable})` : "Archive",
      arg: ids,
      disabled: !archivable,
    },
    {
      kind: "action",
      action: "agents.deleteTasks",
      label: multiple ? tx`Delete (${tasks.length})…` : "Delete…",
      arg: ids,
    },
  ];
}
