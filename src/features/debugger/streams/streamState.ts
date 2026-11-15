import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  call,
  commands,
  nextRequestId,
  type AbortState,
  type DebugSessionId,
  type RequestId,
  type StreamChainInfo,
  type StreamTraceResult,
  type TraceProgress,
} from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import {
  pausedThread,
  publishContext,
  selectedFrame,
  sessionSupports,
  topFrame,
  useDebug,
  type DebugSession,
} from "../state";
import { openStreamChainChooser, useOverlays } from "../ui/popoverStore";
import { openStreamTraceTab } from "./streamTraceInput";

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

/** Applies `patch` while `request` is still the session's trace: a forgotten or newer trace ignores late replies. */
function patchEntry(session: DebugSessionId, request: RequestId, patch: Partial<TraceEntry>) {
  useStreamTrace.setState((s) => {
    const e = s.bySession[session];
    return e?.request === request ? { bySession: { ...s.bySession, [session]: { ...e, ...patch } } } : s;
  });
}

const running = (e: TraceEntry | undefined): e is TraceEntry => !!e && e.result === null && e.error === null;

export function isTracing(s: DebugSessionId): boolean {
  return running(useStreamTrace.getState().bySession[s]);
}

export function canTraceStream(s: DebugSession | null): boolean {
  return !!s && s.status === "paused" && sessionSupports("streamTrace", s) && !isTracing(s.id);
}

/** The paused thread and selected frame the trace starts from, as the step actions pick them. */
function tracePoint(session: DebugSessionId) {
  const s = useDebug.getState().sessions[session];
  if (!s || s.status !== "paused") return null;
  const thread = pausedThread(s);
  const frame = selectedFrame(s);
  return thread == null || !frame ? null : { thread, frame, top: topFrame(s.frames)?.id === frame.id };
}

/** Lists the chains on the paused line: one that can be traced, alone, runs at once; otherwise the user picks. */
export async function traceStreamChain(s: DebugSessionId): Promise<void> {
  const at = tracePoint(s);
  if (!at || isTracing(s)) return;
  const chains = await call(commands.debugStreamChains(s, at.frame, at.top));
  const [only] = chains;
  if (!only) {
    notifications().notify({
      group: "run",
      level: "info",
      key: "debug.streamTrace",
      title: tx("No stream chain on this line"),
    });
  } else if (chains.length === 1 && !only.reason) {
    await startTrace(s, only);
  } else {
    openStreamChainChooser(s, chains);
  }
}

export async function startTrace(s: DebugSessionId, chain: StreamChainInfo): Promise<void> {
  const at = tracePoint(s);
  if (!at || chain.reason || isTracing(s)) return;
  const request = nextRequestId();
  const entry: TraceEntry = {
    request,
    chain,
    progress: null,
    result: null,
    error: null,
    stoppedRecording: false,
    abort: null,
  };
  useStreamTrace.setState((st) => ({ bySession: { ...st.bySession, [s]: entry } }));
  publishContext();
  openStreamTraceTab(s);
  const channel = new Channel<TraceProgress>();
  channel.onmessage = (progress) => patchEntry(s, request, { progress });
  try {
    // The host checks `range` against the chain it finds again at this frame, so it goes unchanged.
    const result = await call(
      commands.debugStreamTrace(s, request, at.thread, at.frame, chain.index, chain.range, channel),
    );
    patchEntry(s, request, { result });
  } catch (e) {
    patchEntry(s, request, { error: e instanceof Error ? e.message : String(e) });
  }
  publishContext();
}

/** Engine R reads a cancelled request as "stop recording": the program runs on and the trace still ends with a result. */
export function stopRecording(s: DebugSessionId): void {
  const e = useStreamTrace.getState().bySession[s];
  if (!running(e) || e.stoppedRecording) return;
  void commands.cancelRequest(e.request).catch(() => {});
  patchEntry(s, e.request, { stoppedRecording: true });
}

/** Cancels the terminal operation itself: the program gets `RuntimeException("oi-cancel:<nonce>")`. */
export async function abortTrace(s: DebugSessionId): Promise<void> {
  const e = useStreamTrace.getState().bySession[s];
  if (!running(e)) return;
  const abort = await call(commands.debugStreamTraceAbort(s));
  if (abort) patchEntry(s, e.request, { abort });
}

export function forgetStreamTrace(s: DebugSessionId): void {
  if (useOverlays.getState().streamChooser?.session === s) useOverlays.setState({ streamChooser: null });
  if (!(s in useStreamTrace.getState().bySession)) return;
  useStreamTrace.setState((st) => {
    const { [s]: _gone, ...rest } = st.bySession;
    return { bySession: rest };
  });
  publishContext();
}
