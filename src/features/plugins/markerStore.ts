/** Gutter markers of document indexers for the files open in editors: bounded IPC, no file reads. */
import { create } from "zustand";
import { call, commands, isTauri, type FileMarkers } from "@/platform/ipc";
import { navigationEpoch, onNavigationProvidersChanged } from "@/editor/navigationProviders";

export const usePluginMarkers = create<{ entries: ReadonlyMap<string, FileMarkers> }>(() => ({
  entries: new Map(),
}));
const visible = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let session = 0;
let again = false;
let off: (() => void) | undefined;
function schedule() {
  again = true;
  if (!timer && !running)
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, 200);
}
async function refresh() {
  if (!isTauri() || running) return;
  running = true;
  again = false;
  const epoch = navigationEpoch();
  const current = session;
  const paths = [...visible.keys()];
  const entries = new Map<string, FileMarkers>();
  try {
    for (let i = 0; i < paths.length; i += 64) {
      const results = await call(commands.pluginNavigationMarkers(paths.slice(i, i + 64)));
      if (epoch !== navigationEpoch() || current !== session) return;
      for (const result of results) {
        if (!visible.has(result.path)) continue;
        const previous = entries.get(result.path);
        entries.set(
          result.path,
          previous ? { ...previous, markers: [...previous.markers, ...result.markers] } : result,
        );
      }
    }
    if (epoch === navigationEpoch() && current === session) usePluginMarkers.setState({ entries });
  } catch {
    // Plugin navigation may be unavailable during project close or reload.
    if (epoch === navigationEpoch() && current === session) usePluginMarkers.setState({ entries: new Map() });
  } finally {
    running = false;
    if (again) schedule();
  }
}
export function watchPluginMarkers(path: string): () => void {
  if (!path || !isTauri()) return () => {};
  if (!visible.size)
    off = onNavigationProvidersChanged(() => {
      schedule();
    });
  visible.set(path, (visible.get(path) ?? 0) + 1);
  schedule();
  return () => {
    const n = (visible.get(path) ?? 1) - 1;
    if (n) visible.set(path, n);
    else visible.delete(path);
    if (!visible.size) {
      session++;
      off?.();
      off = undefined;
      clearTimeout(timer);
      timer = undefined;
      again = false;
      usePluginMarkers.setState({ entries: new Map() });
    }
  };
}
export function invalidatePluginMarkers(paths?: readonly string[]) {
  const entries = new Map(usePluginMarkers.getState().entries);
  for (const [path, entry] of entries) {
    if (!paths || paths.includes(path) || entry.markers.some((m) => m.targets.some((t) => paths.includes(t.path))))
      entries.delete(path);
  }
  usePluginMarkers.setState({ entries });
}
