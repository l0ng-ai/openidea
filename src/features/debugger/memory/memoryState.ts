import { create } from "zustand";
import { call, commands, type DebugSessionId, type JvmMemoryResult, type JvmMemorySnapshot } from "@/platform/ipc";
import { sessionSupports, useDebug, type DebugSession } from "../state";
import type { RowQuery } from "./rows";

export interface MemoryEntry {
  /** The latest answer, which may say why no snapshot could be taken. */
  result: JvmMemoryResult | null;
  /** The session when the last answered or failed request was sent: its `stops` and whether it could list instances. */
  asked: { stop: number; listsInstances: boolean } | null;
  /** The last snapshot taken: it stays on screen when a later refresh is refused or fails. */
  snapshot: JvmMemorySnapshot | null;
  loading: boolean;
  error: string | null;
  /** The session's `stops` when `snapshot` was requested; compare with the current value to tell the table is stale. */
  takenAtStop: number;
  query: RowQuery;
  /** Name of the class row the user selected; the Show Instances action runs for it. */
  selected: string | null;
}

export const DEFAULT_QUERY: RowQuery = { filter: "", sort: "bytes", desc: true, changedOnly: false };

const emptyEntry = (): MemoryEntry => ({
  result: null,
  asked: null,
  snapshot: null,
  loading: false,
  error: null,
  takenAtStop: 0,
  query: DEFAULT_QUERY,
  selected: null,
});

export const useMemory = create<{ bySession: Record<DebugSessionId, MemoryEntry> }>(() => ({ bySession: {} }));

/** The request each session is waiting on; `forgetMemory` clears it so a late reply cannot resurrect the entry. */
const inflight = new Map<DebugSessionId, symbol>();

function patchEntry(id: DebugSessionId, patch: (e: MemoryEntry) => Partial<MemoryEntry>) {
  useMemory.setState((s) => {
    const e = s.bySession[id] ?? emptyEntry();
    return { bySession: { ...s.bySession, [id]: { ...e, ...patch(e) } } };
  });
}

export async function refreshMemory(id: DebugSessionId): Promise<void> {
  if (useMemory.getState().bySession[id]?.loading) return;
  const token = Symbol("memory");
  inflight.set(id, token);
  const session = useDebug.getState().sessions[id] ?? null;
  const stop = session?.stops ?? 0;
  const asked = { stop, listsInstances: sessionSupports("jvmInstances", session) };
  patchEntry(id, () => ({ loading: true, error: null }));
  try {
    const result = await call(commands.debugJvmMemoryClasses(id));
    if (inflight.get(id) !== token) return;
    patchEntry(id, () =>
      result.status === "ready" ? { result, asked, snapshot: result.snapshot, takenAtStop: stop } : { result, asked },
    );
  } catch (e) {
    if (inflight.get(id) !== token) return;
    // A failed request was still asked: `isOvertaken` must not send it again at once.
    patchEntry(id, () => ({ asked, error: e instanceof Error ? e.message : String(e) }));
  } finally {
    if (inflight.get(id) === token) {
      inflight.delete(id);
      patchEntry(id, () => ({ loading: false }));
    }
  }
}

export function setMemoryQuery(id: DebugSessionId, patch: Partial<RowQuery>): void {
  patchEntry(id, (e) => ({ query: { ...e.query, ...patch } }));
}

export function selectMemoryClass(id: DebugSessionId, name: string | null): void {
  patchEntry(id, () => ({ selected: name }));
}

export function isOutdated(entry: MemoryEntry, sessionStops: number): boolean {
  return entry.takenAtStop !== sessionStops;
}

/**
 * Whether asking again could now give a table where the last answer gave none: the session got
 * its JVM inspector after a "no" (it attaches after the session starts), or stopped after the
 * "Pause the program to count" hint. A table on screen is never refetched by itself (§8.4).
 */
export function isOvertaken(entry: MemoryEntry, session: DebugSession): boolean {
  const { result, asked } = entry;
  if (entry.snapshot || entry.loading || !asked || result?.status !== "unavailable") return false;
  return result.canCountWhenPaused
    ? session.status === "paused" && session.stops !== asked.stop
    : !asked.listsInstances && sessionSupports("jvmInstances", session);
}

export function forgetMemory(id: DebugSessionId): void {
  inflight.delete(id);
  useMemory.setState((s) => {
    if (!(id in s.bySession)) return s;
    const { [id]: _gone, ...rest } = s.bySession;
    return { bySession: rest };
  });
}
