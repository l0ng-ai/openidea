/** Shared visible-file plugin presentation cache. Bounded IPC; no file reads. */
import { useEffect } from "react";
import { create } from "zustand";
import { call, commands, isTauri, type FilePresentation } from "./ipc";
import { isIconName, useFileIconRevision, type IconName } from "@/ui/icons";
import { navigationEpoch, onNavigationProvidersChanged } from "@/editor/navigationProviders";

export const usePluginPresentations = create<{ entries: ReadonlyMap<string, FilePresentation> }>(() => ({
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
  const entries = new Map<string, FilePresentation>();
  try {
    for (let i = 0; i < paths.length; i += 64) {
      const results = await call(commands.pluginNavigationPresentations(paths.slice(i, i + 64)));
      if (epoch !== navigationEpoch() || current !== session) return;
      for (const result of results) {
        if (!visible.has(result.path)) continue;
        const previous = entries.get(result.path);
        entries.set(
          result.path,
          previous
            ? {
                ...previous,
                icon: previous.icon ?? result.icon,
                markers: [...previous.markers, ...result.markers],
                regions: [...previous.regions, ...result.regions],
              }
            : result,
        );
      }
    }
    if (epoch === navigationEpoch() && current === session) usePluginPresentations.setState({ entries });
  } catch {
    // Plugin navigation may be unavailable during project close or reload.
    if (epoch === navigationEpoch() && current === session) usePluginPresentations.setState({ entries: new Map() });
  } finally {
    running = false;
    if (again) schedule();
  }
}
export function watchPluginPresentation(path: string): () => void {
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
      usePluginPresentations.setState({ entries: new Map() });
    }
  };
}
export function usePluginFileIcon(path: string): IconName | undefined {
  useFileIconRevision();
  useEffect(() => watchPluginPresentation(path), [path]);
  const icon = usePluginPresentations((s) => s.entries.get(path)?.icon);
  return icon && isIconName(icon) ? icon : undefined;
}

export function invalidatePluginPresentations(paths?: readonly string[]) {
  const entries = new Map(usePluginPresentations.getState().entries);
  for (const [path, entry] of entries) {
    if (!paths || paths.includes(path) || entry.markers.some((m) => m.targets.some((t) => paths.includes(t.path))))
      entries.delete(path);
  }
  usePluginPresentations.setState({ entries });
}
