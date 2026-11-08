import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DebugSessionId,
  type HeapClassRow,
  type HeapOpenResult,
  type HeapPhase,
  type HeapProgress,
  type HeapSnapshotInfo,
  type JvmHeapUnavailable,
  type RequestId,
} from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { useDebug } from "../state";
import { heapInput } from "./heapInput";

export interface CaptureState {
  request: RequestId;
  progress: HeapProgress | null;
  error: string | null;
  /** Why the JVM could not be dumped; stays until the next capture starts. */
  unavailable: JvmHeapUnavailable | null;
}

export interface HeapSnapshotEntry {
  info: HeapSnapshotInfo;
  /**
   * The session's `stops` when the dump was taken; `null` for a file, and for a capture during which the session
   * stopped again, since the dump may then show another state than the stop it was asked at.
   */
  takenAtStop: number | null;
  /** `null` until the class table is read. */
  classes: HeapClassRow[] | null;
}

interface HeapStore {
  snapshots: Record<number, HeapSnapshotEntry>;
  /** A capture that runs, was refused or failed; removed when it ends in a snapshot or is cancelled. */
  captures: Record<DebugSessionId, CaptureState>;
  /** The `.hprof` being opened (one at a time): analysing a large file takes long enough to need a progress and Cancel. */
  opening: { request: RequestId; progress: HeapProgress | null } | null;
}

export const useHeap = create<HeapStore>(() => ({ snapshots: {}, captures: {}, opening: null }));

const isRunning = (c: CaptureState | undefined): c is CaptureState => !!c && c.error === null && c.unavailable === null;

const stopsOf = (session: DebugSessionId): number | null => useDebug.getState().sessions[session]?.stops ?? null;

/** Applies `patch` while `request` is still the session's capture: a forgotten or restarted capture ignores late replies. */
function patchCapture(session: DebugSessionId, request: RequestId, patch: Partial<CaptureState>) {
  useHeap.setState((s) => {
    const c = s.captures[session];
    return c?.request === request ? { captures: { ...s.captures, [session]: { ...c, ...patch } } } : s;
  });
}

function removeCapture(session: DebugSessionId, request?: RequestId) {
  useHeap.setState((s) => {
    const c = s.captures[session];
    if (!c || (request !== undefined && c.request !== request)) return s;
    const { [session]: _gone, ...rest } = s.captures;
    return { captures: rest };
  });
}

/** Keeps the snapshot, reads its class table and opens its tab; the tab opens even when the table cannot be read. */
async function adopt(info: HeapSnapshotInfo, takenAtStop: number | null): Promise<void> {
  const { id } = info;
  useHeap.setState((s) => ({ snapshots: { ...s.snapshots, [id]: { info, takenAtStop, classes: null } } }));
  try {
    const classes = await call(commands.debugHeapClasses(id));
    useHeap.setState((s) => {
      const entry = s.snapshots[id];
      return entry ? { snapshots: { ...s.snapshots, [id]: { ...entry, classes } } } : s;
    });
  } finally {
    // The tab may have been closed while the table loaded.
    if (id in useHeap.getState().snapshots) await maybeEditorService()?.openInput(heapInput(info), { focus: true });
  }
}

export async function captureHeap(session: DebugSessionId): Promise<void> {
  if (isRunning(useHeap.getState().captures[session])) return;
  const request = nextRequestId();
  const stopAtClick = stopsOf(session);
  useHeap.setState((s) => ({
    captures: { ...s.captures, [session]: { request, progress: null, error: null, unavailable: null } },
  }));
  const channel = new Channel<HeapProgress>();
  channel.onmessage = (progress) => patchCapture(session, request, { progress });
  try {
    const result = await call(commands.debugHeapCapture(session, request, channel));
    if (result.status === "ready") {
      const stopAtReply = stopsOf(session);
      await adopt(result.snapshot, stopAtClick !== null && stopAtClick === stopAtReply ? stopAtClick : null);
      removeCapture(session, request);
    } else if (result.status === "unavailable") {
      patchCapture(session, request, { unavailable: result.reason });
    } else {
      removeCapture(session, request);
    }
  } catch (e) {
    if (isCancelled(e)) removeCapture(session, request);
    else patchCapture(session, request, { error: e instanceof Error ? e.message : String(e) });
  }
}

export function cancelCapture(session: DebugSessionId): void {
  const capture = useHeap.getState().captures[session];
  if (isRunning(capture)) void commands.cancelRequest(capture.request).catch(() => {});
}

/** The session ended: drop its capture state. Snapshots stay, since their tabs may still be open. */
export function forgetHeapCapture(session: DebugSessionId): void {
  removeCapture(session);
}

/**
 * Opens an `.hprof`. Resolves to what the host answered so the caller can say why nothing opened
 * (`notEnoughDiskSpace`), or `null` when another file is still opening; rejects when the request fails.
 */
export async function openHeapFile(path: string): Promise<HeapOpenResult | null> {
  if (useHeap.getState().opening) return null;
  const request = nextRequestId();
  useHeap.setState({ opening: { request, progress: null } });
  const channel = new Channel<HeapProgress>();
  channel.onmessage = (progress) =>
    useHeap.setState((s) => (s.opening?.request === request ? { opening: { request, progress } } : s));
  try {
    const result = await call(commands.debugHeapOpen(path, request, channel));
    if (result.status === "ready") await adopt(result.snapshot, null);
    return result;
  } finally {
    useHeap.setState({ opening: null });
  }
}

export async function closeHeapSnapshot(id: number): Promise<void> {
  useHeap.setState((s) => {
    if (!(id in s.snapshots)) return s;
    const { [id]: _gone, ...rest } = s.snapshots;
    return { snapshots: rest };
  });
  try {
    await call(commands.debugHeapClose(id));
  } catch {
    // The tab is gone either way; the host closes what is left with the window.
  }
}

/**
 * Retained bytes by class name, for the Memory table of stop `tableStop`; `null` unless the table, the dump and the
 * session are all at that same stop (sizes of another state beside these counts would mislead). Names shared by
 * several classes are left out: the name is the only join key and cannot tell them apart.
 */
export function retainedForSession(session: DebugSessionId, tableStop: number): Map<string, number> | null {
  if (stopsOf(session) !== tableStop) return null;
  let latest: HeapSnapshotEntry | null = null;
  for (const entry of Object.values(useHeap.getState().snapshots)) {
    const { origin, createdMs, id } = entry.info;
    if (origin.kind !== "captured" || origin.session !== session || entry.takenAtStop !== tableStop) continue;
    if (!latest || createdMs > latest.info.createdMs || (createdMs === latest.info.createdMs && id > latest.info.id)) {
      latest = entry;
    }
  }
  if (!latest?.classes) return null;
  return new Map(latest.classes.filter((c) => !c.ambiguous).map((c) => [c.name, c.retained]));
}

const PHASES: HeapPhase[] = ["reading", "linking", "dominators", "retained", "paths", "saving"];

/** Share of the analysis done, or `null` while the dump is written (its length is unknown). */
export function progressFraction(p: HeapProgress | null): number | null {
  if (p?.type !== "analyzing") return null;
  const within = p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;
  return (PHASES.indexOf(p.phase) + within) / PHASES.length;
}
