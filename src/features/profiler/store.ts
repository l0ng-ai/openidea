/** Profiler snapshots of this project window (the last few stay open as tabs). */
import { create } from "zustand";
import type { Profile } from "@/platform/ipc";

export const MAX_SNAPSHOTS = 5;

export interface Snapshot {
  id: string;
  /** Run configuration name. */
  name: string;
  createdAt: number;
  profile: Profile;
  /** Why the numbers may mislead; shown above the views. */
  notice: string | null;
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

export function addSnapshot(name: string, profile: Profile, notice: string | null = null): Snapshot {
  const snapshot: Snapshot = { id: `profile${++seq}`, name, createdAt: Date.now(), profile, notice };
  useProfiler.setState((s) => ({
    snapshots: [snapshot, ...s.snapshots].slice(0, MAX_SNAPSHOTS),
    activeId: snapshot.id,
  }));
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
