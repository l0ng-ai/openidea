import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent, type WindowTab } from "./ipc";
import { startupLaunchHandled, useProject } from "./project";
import { setContext } from "./context";

export const useWindowGroup = create<{ tabs: WindowTab[] }>(() => ({ tabs: [] }));

export function reorderedTabs(tabs: readonly WindowTab[], source: string, target: string): string[] {
  const labels = tabs.map((tab) => tab.label);
  const from = labels.indexOf(source);
  const to = labels.indexOf(target);
  if (from < 0 || to < 0 || from === to) return labels;
  labels.splice(to, 0, labels.splice(from, 1)[0]!);
  return labels;
}

export async function refreshWindowGroup() {
  if (!isTauri()) return;
  useWindowGroup.setState({ tabs: await call(commands.windowGroupCurrent()) });
  setContext("windowGrouped", useWindowGroup.getState().tabs.length > 1);
}

export async function selectWindowTab(label: string) {
  await call(commands.windowGroupSelect(label));
}

export async function cycleWindowTab(forward: boolean) {
  const tabs = useWindowGroup.getState().tabs;
  if (tabs.length < 2) return;
  const index = tabs.findIndex((tab) => tab.current);
  await selectWindowTab(tabs[(index + (forward ? 1 : -1) + tabs.length) % tabs.length]!.label);
}

export function installWindowGroups(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  const refresh = () => void refreshWindowGroup().catch(console.warn);
  const restore = async () => {
    await startupLaunchHandled();
    if (disposed || !useProject.getState().project) return;
    await call(commands.windowGroupRestore());
    if (!disposed) await refreshWindowGroup();
  };
  const offEvent = onIdeEvent("windowGroupsChanged", refresh);
  const offProject = useProject.subscribe((state, prev) => {
    if (state.project?.root !== prev.project?.root) void restore().catch(console.warn);
  });
  refresh();
  void restore().catch(console.warn);
  return () => {
    disposed = true;
    offEvent();
    offProject();
  };
}
