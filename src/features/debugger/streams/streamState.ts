import { Channel } from "@tauri-apps/api/core";
import {
  call,
  commands,
  nextRequestId,
  type DebugSessionId,
  type RequestId,
  type StreamChainInfo,
  type TraceProgress,
} from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { pausedThread, publishContext, selectedFrame, topFrame, useDebug } from "../state";
import { openStreamChainChooser, useOverlays } from "../ui/popoverStore";
import { isTracing, useStreamTrace, type TraceEntry } from "./streamStore";
import { openStreamTraceTab } from "./streamTraceInput";

/** Applies `patch` while `request` is still the session's trace: a forgotten or newer trace ignores late replies. */
function patchEntry(session: DebugSessionId, request: RequestId, patch: Partial<TraceEntry>) {
  useStreamTrace.setState((s) => {
    const e = s.bySession[session];
    return e?.request === request ? { bySession: { ...s.bySession, [session]: { ...e, ...patch } } } : s;
  });
}

/** The session's running trace, if any. */
function runningEntry(s: DebugSessionId): TraceEntry | null {
  return isTracing(s) ? useStreamTrace.getState().bySession[s]! : null;
}

/** The paused thread and selected frame the trace starts from, as the step actions pick them. */
function tracePoint(session: DebugSessionId) {
  const s = useDebug.getState().sessions[session];
  if (!s || s.status !== "paused") return null;
  const thread = pausedThread(s);
  const frame = selectedFrame(s);
  return thread == null || !frame ? null : { thread, frame, top: topFrame(s.frames)?.id === frame.id };
}

function notify(title: string) {
  notifications().notify({ group: "run", level: "info", key: "debug.streamTrace", title });
}

/** Lists the chains on the paused line: one that can be traced, alone, runs at once; otherwise the user picks. */
export async function traceStreamChain(s: DebugSessionId): Promise<void> {
  const at = tracePoint(s);
  if (!at || isTracing(s)) return;
  const chains = await call(commands.debugStreamChains(s, at.frame, at.top));
  const [only] = chains;
  if (!only) notify(tx("No stream chain on this line"));
  else if (chains.length === 1 && !only.reason) await startTrace(s, only);
  else openStreamChainChooser(s, at.frame.id, chains);
}

/** The chooser's chains belong to the stop and frame they were listed for. */
function chooserStale(c: { session: DebugSessionId; frame: number }): boolean {
  const s = useDebug.getState().sessions[c.session];
  return !s || s.status !== "paused" || selectedFrame(s)?.id !== c.frame;
}

export function closeStaleStreamChooser(): void {
  const c = useOverlays.getState().streamChooser;
  if (c && chooserStale(c)) useOverlays.setState({ streamChooser: null });
}

/** The chooser's pick. A chooser left open past its stop says so instead of tracing another frame's chain. */
export async function pickStreamChain(chain: StreamChainInfo): Promise<void> {
  const c = useOverlays.getState().streamChooser;
  if (!c || chain.reason) return;
  useOverlays.setState({ streamChooser: null });
  if (chooserStale(c)) notify(tx("The stop or the selected frame changed; trace the stream chain again"));
  else await startTrace(c.session, chain);
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
    thread: at.thread,
    endStop: null,
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
  // Left open, it would come back with the session's next trace.
  if (useOverlays.getState().streamAbort === s && !isTracing(s)) useOverlays.setState({ streamAbort: null });
  publishContext();
}

/** Engine R reads a cancelled request as "stop recording": the program runs on and the trace still ends with a result. */
export function stopRecording(s: DebugSessionId): void {
  const e = runningEntry(s);
  if (!e || e.stoppedRecording) return;
  void commands.cancelRequest(e.request).catch(() => {});
  patchEntry(s, e.request, { stoppedRecording: true });
}

/** Cancels the terminal operation itself: the program gets `RuntimeException("oi-cancel:<nonce>")`. */
export async function abortTrace(s: DebugSessionId): Promise<void> {
  const e = runningEntry(s);
  if (!e) return;
  const abort = await call(commands.debugStreamTraceAbort(s));
  if (abort) patchEntry(s, e.request, { abort });
}

export function forgetStreamTrace(s: DebugSessionId): void {
  if (useOverlays.getState().streamChooser?.session === s) useOverlays.setState({ streamChooser: null });
  if (useOverlays.getState().streamAbort === s) useOverlays.setState({ streamAbort: null });
  if (!(s in useStreamTrace.getState().bySession)) return;
  useStreamTrace.setState((st) => {
    const { [s]: _gone, ...rest } = st.bySession;
    return { bySession: rest };
  });
  publishContext();
}
