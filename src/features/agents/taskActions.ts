import type { AgentTask } from "@/bindings";
import type { Action } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { MenuItem } from "@/ui";
import { confirm, showError, confirmChecked } from "@/workbench/messages";
import { promptInput } from "@/workbench/inputDialogs";
import { isBusy } from "./model";
import { groupNameError, type OrganizeGroup } from "./organize";
import {
  archiveTask,
  deleteTaskGroup,
  moveTasksToGroup,
  newTaskGroup,
  pinTasks,
  renameTaskGroup,
  taskGroups,
  unarchiveTask,
  deleteTask,
  dockTask,
  forkTask,
  loadEntries,
  openTask,
  openTaskInEditorLocation,
  renameTask,
  setSessionLocation,
  undockTask,
  useAgents,
} from "./store";

/** The Agents tool window's options menu: where conversations open, and a new list group. */
export function useAgentsHeaderMenu(): MenuItem[] {
  const location = useAgents((s) => s.sessionLocation);
  return [
    // A radio pair: check marks only, no action icons beside them.
    { kind: "action", action: "agents.useToolWindow", icon: "", checked: location === "toolWindow" },
    { kind: "action", action: "agents.useEditor", icon: "", checked: location === "editor" },
    { kind: "separator" },
    { kind: "action", action: "agents.newTaskGroup", label: "New Group…", icon: "plus" },
  ];
}

const canArchive = (task: AgentTask) => !isBusy(task.status) && task.status !== "archived";
const canFork = (task: AgentTask) => canArchive(task) && !!task.capabilities?.fork;

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

/** Asks for a name, then adds a group with `tasks` in it. */
async function promptNewGroup(tasks: readonly string[]) {
  const name = await promptInput({
    title: "New Group",
    label: "Group name:",
    okLabel: "Create",
    validate: (v) => groupNameError(v, taskGroups()),
  });
  if (name !== null) newTaskGroup(name.trim(), tasks);
}

async function promptRenameGroup(group: string) {
  const current = useAgents.getState().organize.groups.find((g) => g.id === group);
  if (!current) return;
  const name = await promptInput({
    title: "Rename Group",
    label: "Group name:",
    initial: current.name,
    okLabel: "Rename",
    validate: (v) => groupNameError(v, taskGroups(), current.name),
  });
  if (name !== null) renameTaskGroup(group, name.trim());
}

async function confirmRemoveGroup(group: string) {
  const current = useAgents.getState().organize.groups.find((g) => g.id === group);
  if (!current) return;
  if (
    await confirm({
      title: tx("Remove Group"),
      message: tx`Remove “${current.name}”? Its tasks move back to their status groups.`,
      ok: tx("Remove"),
      icon: "warning",
    })
  )
    deleteTaskGroup(group);
}

/** Pins and unpins of the selected tasks, then where they go. */
function arrangeMenu(tasks: AgentTask[], ids: string[]): MenuItem[] {
  const { groups, groupOf, pinned } = useAgents.getState().organize;
  const isPinned = new Set(pinned);
  const toPin = tasks.filter((t) => !isPinned.has(t.id));
  const toUnpin = tasks.filter((t) => isPinned.has(t.id));
  return [
    ...(toPin.length
      ? ([
          {
            kind: "action",
            action: "agents.pinTasks",
            label: toPin.length > 1 ? tx`Pin (${toPin.length})` : "Pin",
            icon: "pin",
            arg: toPin.map((t) => t.id),
          },
        ] satisfies MenuItem[])
      : []),
    ...(toUnpin.length
      ? ([
          {
            kind: "action",
            action: "agents.unpinTasks",
            label: toUnpin.length > 1 ? tx`Unpin (${toUnpin.length})` : "Unpin",
            icon: "pin",
            arg: toUnpin.map((t) => t.id),
          },
        ] satisfies MenuItem[])
      : []),
    {
      kind: "item",
      id: "move-to-group",
      label: "Move to Group",
      icon: "folder",
      submenu: groupSubmenu(
        ids,
        groups,
        ids.map((id) => groupOf[id]),
      ),
    },
  ];
}

/** The groups to move the tasks into; the one they all belong to is checked. */
function groupSubmenu(ids: string[], groups: OrganizeGroup[], current: Array<string | undefined>): MenuItem[] {
  return [
    ...groups.map((group): MenuItem => ({
      kind: "item",
      id: `group:${group.id}`,
      label: group.name,
      verbatim: true,
      checked: current.every((g) => g === group.id),
      run: () => moveTasksToGroup(ids, group.id),
    })),
    ...(groups.length ? ([{ kind: "separator" }] satisfies MenuItem[]) : []),
    { kind: "item", id: "group:new", label: "New Group…", icon: "plus", run: () => void promptNewGroup(ids) },
    ...(current.some(Boolean)
      ? ([
          {
            kind: "item",
            id: "group:none",
            label: "Remove from Group",
            run: () => moveTasksToGroup(ids, null),
          },
        ] satisfies MenuItem[])
      : []),
  ];
}

/** A user group's row menu. */
export function groupMenu(group: OrganizeGroup): MenuItem[] {
  return [
    { kind: "action", action: "agents.renameTaskGroup", label: "Rename Group…", icon: "edit", arg: group.id },
    { kind: "action", action: "agents.removeTaskGroup", label: "Remove Group", icon: "close", arg: group.id },
  ];
}

export const taskActions: Action[] = [
  {
    id: "agents.retryConversation",
    title: "Retry Loading Conversation",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      const request = arg as { task?: unknown; subagent?: unknown } | null;
      if (typeof request?.task === "string" && (request.subagent == null || typeof request.subagent === "string"))
        return loadEntries(request.task, request.subagent ?? null);
    },
  },
  {
    id: "agents.useToolWindow",
    title: "Chat in Tool Window",
    category: "Agents",
    icon: "open-in-tool-window",
    run: () => setSessionLocation("toolWindow"),
  },
  {
    id: "agents.useEditor",
    title: "Chat in Editor",
    category: "Agents",
    icon: "editor-only",
    run: () => setSessionLocation("editor"),
  },
  {
    id: "agents.openTaskInEditor",
    title: "Open Agent Task in Editor",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      if (typeof arg === "string") openTaskInEditorLocation(arg);
    },
  },
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
    id: "agents.dockTask",
    title: "Open Agent Task in Tool Window",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      if (typeof arg === "string") dockTask(arg);
    },
  },
  {
    id: "agents.undockTask",
    title: "Open Agent Task in Editor",
    category: "Agents",
    hidden: true,
    run: () => undockTask(),
  },
  {
    id: "agents.renameTask",
    title: "Rename Agent Task",
    category: "Agents",
    hidden: true,
    run: async ({ arg }) => {
      const task = resolveTasks([arg])[0];
      if (!task) return;
      const title = await promptInput({
        title: "Rename Agent Task",
        label: "Name",
        initial: task.title,
        okLabel: "Rename",
      });
      if (title !== null)
        await renameTask(task.id, title).catch((e: unknown) => showError(tx("Couldn't rename the task"), String(e)));
    },
  },
  {
    id: "agents.forkTask",
    title: "Fork Agent Task",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      const task = resolveTasks([arg])[0];
      if (task && canFork(task))
        return forkTask(task.id, null).catch((e: unknown) => showError(tx("Couldn't fork the task"), String(e)));
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
    id: "agents.unarchiveTasks",
    title: "Unarchive Agent Tasks",
    category: "Agents",
    hidden: true,
    run: ({ arg }) =>
      runTasks(
        resolveTasks(arg).filter((task) => task.status === "archived"),
        (task) => unarchiveTask(task.id),
        tx("Cannot unarchive agent tasks"),
      ),
  },
  {
    id: "agents.deleteTasks",
    title: "Delete Agent Tasks",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => confirmDelete(resolveTasks(arg)),
  },
  {
    id: "agents.pinTasks",
    title: "Pin Agent Tasks",
    category: "Agents",
    hidden: true,
    run: ({ arg }) =>
      pinTasks(
        resolveTasks(arg).map((task) => task.id),
        true,
      ),
  },
  {
    id: "agents.unpinTasks",
    title: "Unpin Agent Tasks",
    category: "Agents",
    hidden: true,
    run: ({ arg }) =>
      pinTasks(
        resolveTasks(arg).map((task) => task.id),
        false,
      ),
  },
  {
    id: "agents.newTaskGroup",
    title: "New Agent Task Group",
    category: "Agents",
    hidden: true,
    run: ({ arg }) =>
      promptNewGroup(Array.isArray(arg) ? arg.filter((id): id is string => typeof id === "string") : []),
  },
  {
    id: "agents.renameTaskGroup",
    title: "Rename Agent Task Group",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      if (typeof arg === "string") return promptRenameGroup(arg);
    },
  },
  {
    id: "agents.removeTaskGroup",
    title: "Remove Agent Task Group",
    category: "Agents",
    hidden: true,
    run: ({ arg }) => {
      if (typeof arg === "string") return confirmRemoveGroup(arg);
    },
  },
];

export function taskMenu(tasks: AgentTask[]): MenuItem[] {
  if (!tasks.length) return [];
  const ids = tasks.map((task) => task.id);
  const task = tasks[0]!;
  const multiple = tasks.length > 1;
  const archived = tasks.filter((task) => task.status === "archived").length;
  const archivable = tasks.filter(canArchive).length;
  return [
    ...(!multiple
      ? ([
          { kind: "action", action: "agents.renameTask", label: "Rename…", icon: "edit", arg: task.id },
          { kind: "action", action: "terminal.openAt", label: "Terminal", icon: "terminal", arg: task.cwd },
          ...(task.capabilities?.fork && task.status !== "archived"
            ? ([
                {
                  kind: "action",
                  action: "agents.forkTask",
                  label: "Fork",
                  icon: "branch",
                  arg: task.id,
                  disabled: !canFork(task),
                },
              ] satisfies MenuItem[])
            : []),
          { kind: "separator" },
        ] satisfies MenuItem[])
      : []),
    ...arrangeMenu(tasks, ids),
    { kind: "separator" },
    ...(archived
      ? ([
          {
            kind: "action",
            action: "agents.unarchiveTasks",
            label: multiple ? tx`Unarchive (${archived})` : "Unarchive",
            arg: ids,
          },
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
