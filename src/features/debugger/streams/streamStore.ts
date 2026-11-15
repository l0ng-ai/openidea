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
}

/** The latest trace of each session; it stays after it ends, since its tab shows it. */
export const useStreamTrace = create<{ bySession: Record<DebugSessionId, TraceEntry> }>(() => ({ bySession: {} }));

export function isTracing(s: DebugSessionId): boolean {
  const e = useStreamTrace.getState().bySession[s];
  return !!e && e.result === null && e.error === null;
}
