import { registerActions, type ActionContext } from "@/platform/actions";
import { agentRunSettings } from "@/platform/workflowSettings";
import type { MenuItem } from "@/ui";
import { toolWindowService } from "@/workbench/contributions";
import { archivedAgentSessions } from "./agentRuns";
import { closeStackTrace, useStackTraces } from "./stackTrace";
import { closeSessionTab, pinSession, useRun } from "./store";

/** Ids of the tabs in the Run tool window's strip: sessions (less archived agent tabs), then stack traces. */
export function runTabIds(): string[] {
  const { sessions } = useRun.getState();
  const archived = new Set(archivedAgentSessions(sessions, agentRunSettings().tabLimit).map((s) => s.id));
  return [
    ...sessions.filter((s) => !archived.has(s.id)).map((s) => s.id),
    ...useStackTraces.getState().tabs.map((t) => t.id),
  ];
}

/** Closes a session or stack trace tab; as in IDEA, the tool window goes away with its last tab. */
export async function closeRunTab(id: string): Promise<boolean> {
  if (useStackTraces.getState().tabs.some((t) => t.id === id)) closeStackTrace(id);
  else if (!(await closeSessionTab(id))) return false;
  if (!useRun.getState().sessions.length && !useStackTraces.getState().tabs.length)
    toolWindowService().hide("run", { removeFromStripe: true });
  return true;
}

/** Closes the tabs one after another; a running process the user keeps stops the rest. */
async function closeTabs(ids: readonly string[]) {
  for (const id of ids) if (!(await closeRunTab(id))) return;
}

function target({ arg }: ActionContext): string | null {
  const id = typeof arg === "string" ? arg : useRun.getState().activeSession;
  return id != null && runTabIds().includes(id) ? id : null;
}

const session = (id: string | null) => useRun.getState().sessions.find((s) => s.id === id);

export function registerRunTabActions(): () => void {
  return registerActions([
    {
      id: "run.closeTab",
      title: "Close Tab",
      category: "Run",
      enabled: (c) => target(c) !== null,
      run: (c) => void closeRunTab(target(c)!),
    },
    {
      id: "run.closeOtherTabs",
      title: "Close Other Tabs",
      category: "Run",
      enabled: (c) => target(c) !== null && runTabIds().length > 1,
      run: async (c) => {
        const id = target(c)!;
        await closeTabs(runTabIds().filter((t) => t !== id));
        if (session(id)) useRun.setState({ activeSession: id });
      },
    },
    {
      id: "run.closeAllTabs",
      title: "Close All Tabs",
      category: "Run",
      enabled: () => runTabIds().length > 0,
      run: () => closeTabs(runTabIds()),
    },
    {
      id: "run.pinTab",
      title: "Pin / Unpin Tab",
      category: "Run",
      icon: "pin",
      enabled: (c) => !!session(target(c)),
      run: (c) => {
        const s = session(target(c));
        if (s) pinSession(s.id, !s.pinned);
      },
    },
  ]);
}

/** The context menu of a Run tab (IDEA's content tab menu). */
export function runTabMenu(id: string): MenuItem[] {
  const s = session(id);
  return [
    { kind: "action", action: "run.closeTab", arg: id },
    { kind: "action", action: "run.closeAllTabs", arg: id },
    { kind: "action", action: "run.closeOtherTabs", arg: id },
    ...(s
      ? ([
          { kind: "separator" },
          { kind: "action", action: "run.pinTab", arg: id, label: s.pinned ? "Unpin Tab" : "Pin Tab" },
        ] satisfies MenuItem[])
      : []),
  ];
}
