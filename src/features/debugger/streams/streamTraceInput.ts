import type { DebugSessionId } from "@/platform/ipc";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";

export const STREAM_TRACE_KIND = "stream-trace";

/** One tab per session: it shows the session's latest trace from the store, so its data is only the session id. */
export function openStreamTraceTab(session: DebugSessionId): void {
  void maybeEditorService()
    ?.openInput({ kind: STREAM_TRACE_KIND, key: `${STREAM_TRACE_KIND}:${session}`, data: { session } }, { focus: true })
    .catch((e) => console.warn("cannot open the stream trace tab", e));
}

/** The session a trace tab shows, or `null` for any other tab. */
export function traceSessionOf(input: EditorInput): DebugSessionId | null {
  if (input.kind !== STREAM_TRACE_KIND) return null;
  const session = (input.data as { session?: unknown } | undefined)?.session;
  return typeof session === "number" ? session : null;
}
