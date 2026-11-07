import { create } from "zustand";
import { call, commands, type DebugSessionId, type JvmMemoryResult, type JvmMemorySnapshot } from "@/platform/ipc";
import { useDebug } from "../state";
import type { RowQuery } from "./rows";

export interface MemoryEntry {
  /** The latest answer, which may say why no snapshot could be taken. */
  result: JvmMemoryResult | null;
  /** The last snapshot taken: it stays on screen when a later refresh is refused or fails. */
  snapshot: JvmMemorySnapshot | null;
  loading: boolean;
  error: string | null;
  /** The session's `stops` when `snapshot` was requested; compare with the current value to tell the table is stale. */
  takenAtStop: number;
  query: RowQuery;
}

export const DEFAULT_QUERY: RowQuery = { filter: "", sort: "bytes", desc: true, changedOnly: false };

const emptyEntry = (): MemoryEntry => ({
  result: null,
  snapshot: null,
  loading: false,
  error: null,
  takenAtStop: 0,
  query: DEFAULT_QUERY,
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
  const stop = useDebug.getState().sessions[id]?.stops ?? 0;
  patchEntry(id, () => ({ loading: true, error: null }));
  try {
    const result = await call(commands.debugJvmMemoryClasses(id));
    if (inflight.get(id) !== token) return;
    patchEntry(id, () =>
      result.status === "ready" ? { result, snapshot: result.snapshot, takenAtStop: stop } : { result },
    );
  } catch (e) {
    if (inflight.get(id) !== token) return;
    patchEntry(id, () => ({ error: e instanceof Error ? e.message : String(e) }));
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

export function isOutdated(entry: MemoryEntry, sessionStops: number): boolean {
  return entry.takenAtStop !== sessionStops;
}

export function forgetMemory(id: DebugSessionId): void {
  inflight.delete(id);
  useMemory.setState((s) => {
    if (!(id in s.bySession)) return s;
    const { [id]: _gone, ...rest } = s.bySession;
    return { bySession: rest };
  });
}
