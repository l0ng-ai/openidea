/**
 * Coding agents (Claude Code, Codex, Gemini CLI over ACP, run by `ide-agent`): the
 * Agents tool window lists tasks by what they need from the user, a task opens as an
 * editor tab (conversation + changed files), and New Task is an editor page.
 */
import { createElement } from "react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { executeAction } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { isVirtualUri } from "@/platform/virtualDocs";
import {
  registerEditorDropHandler,
  registerEditorKind,
  registerMenuGroup,
  registerSettingsPage,
  registerStatusItem,
  registerToolWindow,
  toolWindowService,
} from "@/workbench/contributions";
import { AgentsStatus } from "./AgentsStatus";
import {
  AGENTS_GROUP,
  HOME_KIND,
  MCP_PAGE,
  POLICY_PAGE,
  REGISTRY_PAGE,
  SESSION_KIND,
  TASK_DRAG,
  TOOL_WINDOW,
  providerIcon,
} from "./model";
import { sendPaths, sendSelection } from "./references";
import { focusedSession } from "./sessionFocus";
import { closeActiveTask, closeAndNewTask, connect, disconnect, openHome, refreshProviders, useAgents } from "./store";
import { TaskStatusMark } from "./TaskStatusMark";
import { taskActions, useAgentsHeaderMenu } from "./taskActions";
import { replyActions } from "./replyActions";

/** Settings › Agents › Coding Agents and Settings › Agents › External MCP Servers (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  const disposers = [
    registerSettingsPage({
      id: REGISTRY_PAGE,
      title: "Coding Agents",
      group: AGENTS_GROUP,
      // First in Agents, which sits after Languages & Frameworks and before Tools.
      order: 450,
      keywords: ["agent", "acp", "registry", "install", "update", "coding agent"],
      component: lazyComponent(() => import("./AgentRegistryPage").then((m) => m.AgentRegistryPage)),
    }),
    registerSettingsPage({
      id: MCP_PAGE,
      title: "External MCP Servers",
      group: AGENTS_GROUP,
      order: 475,
      keywords: ["mcp", "model context protocol", "servers", "tools", "agent"],
      component: lazyComponent(() => import("./McpServersPage").then((m) => m.McpServersPage)),
    }),
    registerSettingsPage({
      id: POLICY_PAGE,
      title: "Command Permissions",
      group: AGENTS_GROUP,
      order: 490,
      keywords: ["agent", "policy", "security", "whitelist", "blacklist", "permission", "command", "exec"],
      component: lazyComponent(() => import("./AgentPolicyPage").then((m) => m.AgentPolicyPage)),
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  const sync = (root: string | null | undefined) => {
    disconnect();
    if (root) void connect().catch((e: unknown) => console.warn("agents unavailable", e));
  };
  sync(useProject.getState().project?.root);
  const disposers = [
    activateSettingsPages(),
    // The performance harness (`perf/`): long conversations to switch between and scroll.
    import.meta.env.DEV || import.meta.env.MODE === "perf"
      ? registerActions([
          {
            id: "agents.openSampleConversations",
            title: "Open Sample Conversations",
            category: "Agents",
            hidden: true,
            run: async ({ arg }) => {
              const { tasks = 2, turns = 150 } = (arg ?? {}) as { tasks?: number; turns?: number };
              const { openSampleConversations } = await import("./sampleConversation");
              openSampleConversations(tasks, turns);
            },
          },
        ])
      : () => {},
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root || s.project?.trusted !== prev.project?.trusted) sync(s.project?.root);
      // What new tasks start with comes from the agents' list.
      else if (s.settings?.agents?.newTaskApprovals !== prev.settings?.agents?.newTaskApprovals && s.project?.root)
        void refreshProviders();
    }),
    registerToolWindow({
      id: TOOL_WINDOW,
      title: "Agents",
      icon: "toolwindow-agents",
      anchor: "right",
      order: 0.5,
      component: lazyComponent(() => import("./AgentsView").then((m) => m.AgentsView)),
      headerMenu: useAgentsHeaderMenu,
      plainTitle: true,
      headerActions: lazyComponent(() => import("./AgentsView").then((m) => m.AgentsHeaderActions)),
      useBadge: () => {
        const n = useAgents(
          (s) => [...s.tasks.values()].filter((t) => t.status === "needsInput" || s.unread.has(t.id)).length,
        );
        return n || null;
      },
    }),
    registerEditorKind({
      kind: SESSION_KIND,
      component: lazyComponent(() => import("./SessionEditor").then((m) => m.SessionEditor)),
      title: (input) => {
        const data = input.data as { task: string; title?: string };
        return useAgents.getState().tasks.get(data.task)?.title ?? data.title ?? "Agent Task";
      },
      icon: (input) => {
        const task = useAgents.getState().tasks.get((input.data as { task: string }).task);
        return task ? providerIcon(task.provider) : "toolwindow-agents";
      },
      // Busy / done marker in the tab's trailing slot (#2233).
      trailing: (input) => createElement(TaskStatusMark, { task: (input.data as { task: string }).task }),
      // Tabs of tasks deleted meanwhile are closed when the tasks load (`connect`).
      restorable: true,
      // Rebuilding a long conversation on every switch back is slow.
      keepAlive: true,
    }),
    registerEditorKind({
      kind: HOME_KIND,
      component: lazyComponent(() => import("./HomeEditor").then((m) => m.HomeEditor)),
      title: () => "New Agent Task",
      icon: (input) => {
        const task = useAgents.getState().tasks.get((input.data as { task: string }).task);
        return task ? providerIcon(task.provider) : "toolwindow-agents";
      },
      restorable: true,
    }),
    // An explicit editor drop sets the placement for subsequent sessions too.
    registerEditorDropHandler({
      accepts: (type) => type === TASK_DRAG,
      drop: ({ payload }) => void executeAction("agents.openTaskInEditor", payload),
    }),
    registerStatusItem({ id: "agents.status", align: "right", priority: 3, title: "Agents", component: AgentsStatus }),
    registerMenuGroup({
      id: "agents.send",
      menus: ["editor", "projectView"],
      order: 80,
      items: (menu, { paths }) =>
        paths.length && !paths.some(isVirtualUri)
          ? [{ kind: "action", action: "agents.sendToAgent", arg: menu === "projectView" ? paths : undefined }]
          : [],
    }),
    registerActions([
      ...taskActions,
      ...replyActions,
      {
        id: "agents.findInConversation",
        title: "Find in Conversation",
        category: "Agents",
        icon: "search",
        when: "agentSessionFocus",
        run: () => focusedSession()?.openFind(),
      },
      {
        id: "agents.newTask",
        title: "New Agent Task",
        description: "Opens the New Task page; a string `arg` pre-fills the task description.",
        category: "Agents",
        icon: "plus",
        when: "projectOpen",
        keywords: ["agent", "claude", "codex", "gemini", "ai"],
        run: ({ arg }) => openHome(typeof arg === "string" ? arg : undefined),
      },
      {
        id: "agents.closeTask",
        title: "Close Agent Task",
        description: "Closes the agent task tab in the editor; the task keeps running in the Agents tool window.",
        category: "Agents",
        when: "projectOpen",
        keywords: ["agent", "tab"],
        run: async () => {
          await closeActiveTask();
        },
      },
      {
        id: "agents.closeAndNewTask",
        title: "Close and New Agent Task",
        description: "Closes the agent task tab in the editor, then opens the New Task page.",
        category: "Agents",
        when: "projectOpen",
        keywords: ["agent", "tab"],
        run: () => closeAndNewTask(),
      },
      {
        id: "agents.addAgent",
        title: "More Agents…",
        description: "Opens Settings › Tools › Agents: installs, updates or removes agents from the ACP Registry.",
        category: "Agents",
        icon: "plugin",
        keywords: ["agent", "acp", "registry", "install", "update"],
        run: () => void executeAction("file.settings", REGISTRY_PAGE),
      },
      {
        id: "agents.mcpServers",
        title: "External MCP Servers…",
        description:
          "Opens Settings › Agents › External MCP Servers: configures the User and Workspace MCP servers coding agents use.",
        category: "Agents",
        icon: "settings",
        keywords: ["mcp", "model context protocol", "servers", "tools", "agent"],
        run: () => void executeAction("file.settings", MCP_PAGE),
      },
      {
        id: "agents.sendToAgent",
        title: "Send to Agent",
        description:
          "Adds the editor selection (or the file) as an @ reference to the agent message typed last; a string[] `arg` sends those paths.",
        category: "Agents",
        icon: "toolwindow-agents",
        when: "projectOpen",
        keywords: ["agent", "chat", "context", "reference", "selection"],
        run: ({ arg }) => {
          if (Array.isArray(arg)) sendPaths(arg.filter((p): p is string => typeof p === "string"));
          else sendSelection();
        },
      },
      {
        id: "agents.showToolWindow",
        title: "Agents",
        category: "Agents",
        icon: "toolwindow-agents",
        when: "projectOpen",
        keywords: ["agent", "tasks"],
        run: () => toolWindowService().show(TOOL_WINDOW, true),
      },
    ]),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    disconnect();
  };
}
