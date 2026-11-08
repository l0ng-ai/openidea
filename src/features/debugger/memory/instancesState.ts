import { create } from "zustand";
import {
  call,
  commands,
  type DebugSessionId,
  type JvmFieldsResult,
  type JvmInstancesResult,
  type JvmObjectRef,
  type JvmReferrersResult,
} from "@/platform/ipc";
import { useDebug } from "../state";
import { refKey } from "./values";

const INSTANCE_LIMIT = 1000;
const REFERRER_LIMIT = 50;

export interface NodeEntry {
  fields: JvmFieldsResult | null;
  referrers: JvmReferrersResult | null;
  loadingFields: boolean;
  loadingReferrers: boolean;
  error: string | null;
}

export interface InstancesEntry {
  className: string;
  /** The latest answer, which may say why the instances could not be listed (`timedOut` is worth a retry). */
  result: JvmInstancesResult | null;
  loading: boolean;
  error: string | null;
  /** The session's `stops` when the list was requested; compare with the current value to tell the objects are from an earlier stop. */
  takenAtStop: number;
  /** Opened objects by `refKey`. */
  nodes: Record<string, NodeEntry>;
}

const emptyNode = (): NodeEntry => ({
  fields: null,
  referrers: null,
  loadingFields: false,
  loadingReferrers: false,
  error: null,
});

export const useInstances = create<{ bySession: Record<DebugSessionId, InstancesEntry> }>(() => ({ bySession: {} }));

/**
 * The list each session is showing. A reply (of the list or of one of its objects) counts only
 * while its token is still current: closing, forgetting or replacing the list drops the token.
 */
const current = new Map<DebugSessionId, symbol>();

function patchEntry(id: DebugSessionId, token: symbol, patch: (e: InstancesEntry) => Partial<InstancesEntry>) {
  if (current.get(id) !== token) return;
  useInstances.setState((s) => {
    const e = s.bySession[id];
    return e ? { bySession: { ...s.bySession, [id]: { ...e, ...patch(e) } } } : s;
  });
}

function patchNode(id: DebugSessionId, token: symbol, ref: JvmObjectRef, patch: Partial<NodeEntry>) {
  const key = refKey(ref);
  patchEntry(id, token, (e) => ({ nodes: { ...e.nodes, [key]: { ...(e.nodes[key] ?? emptyNode()), ...patch } } }));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function showInstances(id: DebugSessionId, className: string): Promise<void> {
  const open = useInstances.getState().bySession[id];
  if (open?.loading && open.className === className) return;
  const token = Symbol("instances");
  current.set(id, token);
  const stop = useDebug.getState().sessions[id]?.stops ?? 0;
  useInstances.setState((s) => ({
    bySession: {
      ...s.bySession,
      [id]: { className, result: null, loading: true, error: null, takenAtStop: stop, nodes: {} },
    },
  }));
  try {
    const result = await call(commands.debugJvmMemoryInstances(id, className, INSTANCE_LIMIT));
    patchEntry(id, token, () => ({ result }));
  } catch (e) {
    patchEntry(id, token, () => ({ error: messageOf(e) }));
  } finally {
    patchEntry(id, token, () => ({ loading: false }));
  }
}

export function closeInstances(id: DebugSessionId): void {
  forgetInstances(id);
}

export function forgetInstances(id: DebugSessionId): void {
  current.delete(id);
  useInstances.setState((s) => {
    if (!(id in s.bySession)) return s;
    const { [id]: _gone, ...rest } = s.bySession;
    return { bySession: rest };
  });
}

export function loadFields(id: DebugSessionId, ref: JvmObjectRef): Promise<void> {
  return loadNode(id, ref, "loadingFields", async () => {
    const fields = await call(commands.debugJvmMemoryFields(id, ref));
    return { fields };
  });
}

export function loadReferrers(id: DebugSessionId, ref: JvmObjectRef): Promise<void> {
  return loadNode(id, ref, "loadingReferrers", async () => {
    const referrers = await call(commands.debugJvmMemoryReferrers(id, ref, REFERRER_LIMIT));
    return { referrers };
  });
}

async function loadNode(
  id: DebugSessionId,
  ref: JvmObjectRef,
  flag: "loadingFields" | "loadingReferrers",
  fetch: () => Promise<Partial<NodeEntry>>,
): Promise<void> {
  const token = current.get(id);
  const entry = useInstances.getState().bySession[id];
  if (!token || !entry || entry.nodes[refKey(ref)]?.[flag]) return;
  patchNode(id, token, ref, { [flag]: true, error: null });
  try {
    patchNode(id, token, ref, await fetch());
  } catch (e) {
    patchNode(id, token, ref, { error: messageOf(e) });
  } finally {
    patchNode(id, token, ref, { [flag]: false });
  }
}

export function instancesOutdated(entry: InstancesEntry, sessionStops: number): boolean {
  return entry.takenAtStop !== sessionStops;
}
