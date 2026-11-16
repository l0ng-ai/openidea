/** The stream trace store. A leaf: `state.ts` reads it for its context keys, so it must not import `state.ts`. */
import { create } from "zustand";
import type {
  AbortState,
  DebugSessionId,
  RequestId,
  StreamChainInfo,
  StreamTraceResult,
  TraceProgress,
} from "@/platform/ipc";

export interface TraceEntry {
  request: RequestId;
  chain: StreamChainInfo;
  progress: TraceProgress | null;
  result: StreamTraceResult | null;
  error: string | null;
  /** "Stop Recording" was asked: the terminal operation goes on running, the records so far are kept. */
  stoppedRecording: boolean;
  /** How far the host got cancelling the terminal operation; `null` until it is cancelled. */
  abort: AbortState | null;
  /** The thread the chain runs on; the trace ends with this thread's stop after stepping out of the terminal. */
  thread: number;
  /** The session's `stops` at that stop, like the Memory view's `takenAtStop`; `null` until its event arrives. */
  endStop: number | null;
}

/** The latest trace of each session; it stays after it ends, since its tab shows it. */
export const useStreamTrace = create<{ bySession: Record<DebugSessionId, TraceEntry> }>(() => ({ bySession: {} }));

export function isTracing(s: DebugSessionId): boolean {
  const e = useStreamTrace.getState().bySession[s];
  return !!e && e.result === null && e.error === null;
}

/**
 * Called for each stop event: records it as the stop the trace ended in when it is the traced
 * thread's first stop since the trace started, and says whether it was. Another thread may stop
 * meanwhile (an exception breakpoint), so stops are not counted. The reply may come before or
 * after the event, so a `ready` result still takes it.
 */
export function markTraceStop(s: DebugSessionId, thread: number, stops: number): boolean {
  const e = useStreamTrace.getState().bySession[s];
  if (!e || e.endStop !== null || thread !== e.thread || !(isTracing(s) || e.result?.status === "ready")) return false;
  useStreamTrace.setState((st) => ({ bySession: { ...st.bySession, [s]: { ...e, endStop: stops } } }));
  return true;
}

/**
 * A ready trace's values can be opened only in the stop it ended in. Before that stop's event
 * arrives the host is already suspended in it, so they are not outdated yet.
 */
export function traceValuesOutdated(e: TraceEntry, session: { status: string; stops: number } | undefined): boolean {
  if (!session || session.status === "terminated") return true;
  return e.endStop !== null && (session.status !== "paused" || session.stops !== e.endStop);
}
