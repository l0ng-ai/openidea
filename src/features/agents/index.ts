/**
 * Coding agents (Claude Code, Codex, Gemini CLI over ACP, run by `ide-agent`): the
 * Agents tool window lists tasks by what they need from the user, a task opens as an
 * editor tab (conversation + changed files), and New Task is an editor page.
 */
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { executeAction } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { isVirtualUri } from "@/platform/virtualDocs";
import {
  registerEditorKind,
  registerMenuGroup,
  registerSettingsPage,
  registerStatusItem,
  registerToolWindow,
  toolWindowService,
} from "@/workbench/contributions";
import { AgentsStatus } from "./AgentsStatus";
import { HOME_KIND, REGISTRY_PAGE, SESSION_KIND, TOOL_WINDOW } from "./model";
import { sendPaths, sendSelection } from "./references";
import { focusedSession } from "./sessionFocus";
import { connect, disconnect, openHome, useAgents } from "./store";

/** Settings › Tools › Agents (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: REGISTRY_PAGE,
    title: "Agents",
    group: "Tools",
    order: 500,
    keywords: ["agent", "acp", "registry", "install", "update", "coding agent"],
    component: lazyComponent(() => import("./AgentRegistryPage").then((m) => m.AgentRegistryPage)),
  });
}

export function activate(): () => void {
  const sync = (root: string | null | undefined) => {
    disconnect();
    if (root) void connect().catch((e: unknown) => console.warn("agents unavailable", e));
  };
  sync(useProject.getState().project?.root);
  const disposers = [
    activateSettingsPages(),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) sync(s.project?.root);
    }),
    registerToolWindow({
      id: TOOL_WINDOW,
      title: "Agents",
      icon: "toolwindow-agents",
      anchor: "right",
      order: 0.5,
      component: lazyComponent(() => import("./AgentsView").then((m) => m.AgentsView)),
      headerActions: lazyComponent(() => import("./AgentsView").then((m) => m.AgentsHeaderActions)),
      useBadge: () => {
        const n = useAgents((s) => [...s.tasks.values()].filter((t) => t.status === "needsInput").length);
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
      icon: () => "toolwindow-agents",
      // Tabs of tasks deleted meanwhile are closed when the tasks load (`connect`).
      restorable: true,
    }),
    registerEditorKind({
      kind: HOME_KIND,
      component: lazyComponent(() => import("./HomeEditor").then((m) => m.HomeEditor)),
      title: () => "New Agent Task",
      icon: () => "toolwindow-agents",
      restorable: true,
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
        id: "agents.addAgent",
        title: "More Agents…",
        description: "Opens Settings › Tools › Agents: installs, updates or removes agents from the ACP Registry.",
        category: "Agents",
        icon: "plugin",
        keywords: ["agent", "acp", "registry", "install", "update"],
        run: () => void executeAction("file.settings", REGISTRY_PAGE),
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
