/**
 * Coding agents (Claude Code, Codex, Gemini CLI over ACP, run by `ide-agent`): the
 * Agents tool window lists tasks by what they need from the user, a task opens as an
 * editor tab (conversation + changed files), and New Task is an editor page.
 */
import { createElement } from "react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { executeAction } from "@/platform/actions";
import { lazyComponent, lazyWhen } from "@/ui";
import { isVirtualUri } from "@/platform/virtualDocs";
import { call, commands } from "@/platform/ipc";
import {
  maybeEditorService,
  registerAgentContextSource,
  registerEditorDropHandler,
  registerEditorKind,
  registerMenuGroup,
  registerMenuSlotItem,
  registerOverlay,
  registerStatusItem,
  registerToolWindow,
  toolWindowService,
} from "@/workbench/contributions";
import { AgentsStatus } from "./AgentsStatus";
import { activateSettingsPages } from "./settingsPages";
import { HOME_KIND, MCP_PAGE, REGISTRY_PAGE, SESSION_KIND, TASK_DRAG, TOOL_WINDOW, providerIcon } from "./model";
import { sendPaths, sendSelection, trackEditorCopies } from "./references";
import { focusedSession, inputSession } from "./sessionFocus";
import { cycleFocusedEffort } from "./effortFocus";
import { clearAgentTabFontZoom } from "./fontZoom";
import {
  closeActiveTask,
  closeAndNewTask,
  connect,
  disconnect,
  openHome,
  refreshModels,
  refreshProviders,
  refreshTaskModels,
  releaseClosedTaskCache,
  useAgents,
} from "./store";
import { TaskStatusMark } from "./TaskStatusMark";
import { taskActions, useAgentsHeaderMenu } from "./taskActions";
import { replyActions } from "./replyActions";

export { activateSettingsPages } from "./settingsPages";

export function activate(): () => void {
  const sync = (root: string | null | undefined) => {
    disconnect();
    if (root) void connect().catch((e: unknown) => console.warn("agents unavailable", e));
  };
  sync(useProject.getState().project?.root);
  const disposers = [
    activateSettingsPages(),
    trackEditorCopies(),
    registerAgentContextSource({
      id: "changes",
      title: "Changes",
      description: "Files with uncommitted changes",
      icon: "diff",
      resolve: async () => {
        const changed = await call(commands.vcsStatus());
        return changed.length ? { kind: "files", paths: changed.map((f) => f.path) } : null;
      },
    }),
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
    registerOverlay({
      id: "agents.importSessions",
      component: lazyWhen(
        () => useAgents((s) => s.importOpen),
        () => import("./ImportSessionsDialog").then((m) => m.ImportSessionsOverlay),
      ),
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
      onTabClose: (tabId) => clearAgentTabFontZoom(tabId),
      onClose: (input) => {
        const task = (input.data as { task?: string } | undefined)?.task;
        if (task) releaseClosedTaskCache(task);
      },
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
      onTabClose: (tabId) => clearAgentTabFontZoom(tabId),
      restorable: true,
      // Mounting it again on every switch rebuilds the composer and refetches the agent, models and branches.
      keepAlive: true,
    }),
    // An explicit editor drop sets the placement for subsequent sessions too.
    registerEditorDropHandler({
      accepts: (type) => type === TASK_DRAG,
      drop: ({ payload }) => void executeAction("agents.openTaskInEditor", payload),
    }),
    // The button above the commit message (the Commit tool window and dialog).
    registerMenuSlotItem("commitMessage", {
      action: "agents.generateCommitMessage",
      label: "Generate Commit Message with Agent",
      icon: "toolwindow-agents",
      when: "projectOpen && vcsAvailable",
    }),
    registerStatusItem({ id: "agents.status", align: "right", priority: 3, title: "Agents", component: AgentsStatus }),
    registerMenuGroup({
      id: "agents.send",
      menus: ["editor", "projectView"],
      order: 80,
      items: (menu, { paths, dirs }) =>
        paths.length && !paths.some(isVirtualUri)
          ? [
              {
                kind: "action",
                action: "agents.sendToAgent",
                arg: menu === "projectView" ? paths.map((p, i) => (dirs?.[i] ? `${p}/` : p)) : undefined,
              },
            ]
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
        id: "agents.focusInput",
        title: "Focus Agent Input",
        description:
          "Focuses the message input of the current agent task, or of the one on screen when focus is elsewhere and no panel claims the shortcut, without moving the caret.",
        category: "Agents",
        when: "agentInputAvailable",
        // In a task view it wins over the editor's Go to Line; elsewhere it yields wherever that applies.
        keyWhen: "!popupOpen && (agentSessionFocus || !(textEditorActive && (editorFocus || !toolWindowFocus)))",
        run: () => inputSession()?.focusInput?.(),
      },
      {
        id: "agents.cycleEffort",
        title: "Cycle Agent Effort",
        description: "Cycles the current model's supported effort levels without changing the message.",
        category: "Agents",
        when: "agentEffortAvailable",
        keyWhen: "agentEffortAvailable && !popupOpen",
        run: cycleFocusedEffort,
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
        id: "agents.refreshModels",
        title: "Refresh models",
        category: "Agents",
        when: "projectOpen",
        run: ({ arg }) => {
          if (typeof arg === "string") return refreshTaskModels(arg);
          if (arg === null) return refreshModels(); // Explicitly invoked by the New Task picker.
          const { sessionLocation, docked, homeOpen } = useAgents.getState();
          if (sessionLocation === "toolWindow" && (homeOpen || docked) && toolWindowService().isVisible(TOOL_WINDOW)) {
            return !homeOpen && docked ? refreshTaskModels(docked) : refreshModels();
          }
          const active = maybeEditorService()?.activeInput?.();
          if (active?.kind === SESSION_KIND) {
            const data = active.data;
            if (data && typeof data === "object" && "task" in data && typeof data.task === "string")
              return refreshTaskModels(data.task);
            return;
          }
          return refreshModels();
        },
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
        id: "agents.generateCommitMessage",
        title: "Generate Commit Message with Agent",
        description:
          "Has the coding agent you work with review the changes about to be committed and write the commit message.",
        category: "Agents",
        icon: "toolwindow-agents",
        when: "projectOpen && vcsAvailable",
        keywords: ["agent", "commit", "message", "ai", "copilot", "generate"],
        indicatesRunning: true,
        run: async () => {
          const { generateCommitMessage } = await import("./commitMessage");
          await generateCommitMessage();
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
