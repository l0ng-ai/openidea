/** Profiler snapshots of this project window (the last few stay open as tabs). */
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import type { Profile } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

export const MAX_SNAPSHOTS = 5;

export interface Snapshot {
  id: string;
  /** Run configuration name. */
  name: string;
  createdAt: number;
  profile: Profile;
  /** Why the numbers may mislead; shown above the views. */
  notice: string | null;
  /** The `.cpuprofile` it was opened from; opening the file again replaces it. */
  path?: string;
}

export type ProfilerTab = "flame" | "tree" | "methods";

interface ProfilerState {
  /** Newest first. */
  snapshots: Snapshot[];
  activeId: string | null;
  tab: ProfilerTab;
  query: string;
}

export const useProfiler = create<ProfilerState>(() => ({ snapshots: [], activeId: null, tab: "flame", query: "" }));

let seq = 0;

/** Adds a snapshot in front; the oldest beyond {@link MAX_SNAPSHOTS} close, with a notification. */
export function addSnapshot(name: string, profile: Profile, notice: string | null = null, path?: string): Snapshot {
  const prev = useProfiler.getState().snapshots;
  const same = path === undefined ? undefined : prev.find((x) => x.path === path);
  const snapshot: Snapshot = {
    id: same?.id ?? `profile${++seq}`,
    name,
    createdAt: Date.now(),
    profile,
    notice,
    ...(path !== undefined && { path }),
  };
  const rest = prev.filter((x) => x !== same);
  const dropped = rest.slice(MAX_SNAPSHOTS - 1);
  useProfiler.setState({ snapshots: [snapshot, ...rest.slice(0, MAX_SNAPSHOTS - 1)], activeId: snapshot.id });
  if (dropped.length) {
    const max = MAX_SNAPSHOTS;
    const names = dropped.map((x) => x.name).join(", ");
    notifications().notify({
      group: "run",
      level: "info",
      title: "Closed older profiler snapshots",
      body: tx`The Profiler keeps the last ${max} snapshots open; closed ${names}.`,
    });
  }
  return snapshot;
}

export function activeSnapshot(s: ProfilerState = useProfiler.getState()): Snapshot | null {
  return s.snapshots.find((x) => x.id === s.activeId) ?? null;
}

export function closeSnapshot(id: string) {
  useProfiler.setState((s) => {
    const snapshots = s.snapshots.filter((x) => x.id !== id);
    return { snapshots, activeId: s.activeId === id ? (snapshots[0]?.id ?? null) : s.activeId };
  });
}

export function resetProfiler() {
  useProfiler.setState({ snapshots: [], activeId: null, query: "" });
}
