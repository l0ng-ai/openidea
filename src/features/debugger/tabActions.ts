import { registerActions, type ActionContext } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import type { DebugSessionId } from "@/platform/ipc";
import { closeSessionTab, pinSession, useDebug } from "./state";
import { sessionTabs } from "./ui/sessionTabs";

/** The sessions the Debug tabs close: each tab's owner, in tab order. */
function owners(): DebugSessionId[] {
  return [...new Set(sessionTabs(Object.values(useDebug.getState().sessions)).map((t) => t.owner))];
}

/** The tab owner an action is for: its argument, else the selected tab's. */
function target({ arg }: ActionContext): DebugSessionId | null {
  const { sessions, active } = useDebug.getState();
  const id = typeof arg === "number" ? arg : active;
  if (id == null || !sessions[id]) return null;
  return sessionTabs(Object.values(sessions)).find((t) => t.session.id === id || t.owner === id)?.owner ?? null;
}

/** `id` and the sessions it runs under: closing one of those would close `id` too. */
function lineage(id: DebugSessionId): Set<DebugSessionId> {
  const { sessions } = useDebug.getState();
  const out = new Set<DebugSessionId>();
  for (let cur = sessions[id]; cur && !out.has(cur.id); cur = cur.parent != null ? sessions[cur.parent] : undefined)
    out.add(cur.id);
  return out;
}

/** Closes the tabs one after another; a running session the user keeps stops the rest. */
async function closeTabs(ids: readonly DebugSessionId[]) {
  for (const id of ids) if (useDebug.getState().sessions[id] && !(await closeSessionTab(id))) return;
}

/** A pinnable tab: a user-started session's (a child's tab goes with its parent). */
function pinnable(id: DebugSessionId | null) {
  const s = id != null ? useDebug.getState().sessions[id] : undefined;
  return s && s.parent == null ? s : undefined;
}

export function registerDebugTabActions(): () => void {
  return registerActions([
    {
      id: "debug.closeTab",
      title: "Close Tab",
      category: "Debug",
      enabled: (c) => target(c) !== null,
      run: (c) => void closeSessionTab(target(c)!),
    },
    {
      id: "debug.closeOtherTabs",
      title: "Close Other Tabs",
      category: "Debug",
      enabled: (c) => target(c) !== null && owners().length > 1,
      run: async (c) => {
        const keep = lineage(target(c)!);
        await closeTabs(owners().filter((id) => !keep.has(id)));
      },
    },
    {
      id: "debug.closeAllTabs",
      title: "Close All Tabs",
      category: "Debug",
      enabled: () => owners().length > 0,
      run: () => closeTabs(owners()),
    },
    {
      id: "debug.pinTab",
      title: "Pin / Unpin Tab",
      category: "Debug",
      icon: "pin",
      enabled: (c) => !!pinnable(target(c)),
      run: (c) => {
        const s = pinnable(target(c));
        if (s) pinSession(s.id, !s.pinned);
      },
    },
  ]);
}

/** The context menu of a Debug tab (IDEA's content tab menu); `owner` is the session the tab stands for. */
export function debugTabMenu(owner: DebugSessionId): MenuItem[] {
  const s = pinnable(owner);
  return [
    { kind: "action", action: "debug.closeTab", arg: owner },
    { kind: "action", action: "debug.closeAllTabs", arg: owner },
    { kind: "action", action: "debug.closeOtherTabs", arg: owner },
    ...(s
      ? ([
          { kind: "separator" },
          { kind: "action", action: "debug.pinTab", arg: owner, label: s.pinned ? "Unpin Tab" : "Pin Tab" },
        ] satisfies MenuItem[])
      : []),
  ];
}
