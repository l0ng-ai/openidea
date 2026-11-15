import type { DebugSessionId } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";

export const STREAM_TRACE_KIND = "stream-trace";

/** One tab per session: it shows the session's latest trace from the store, so its data is only the session id. */
export function openStreamTraceTab(session: DebugSessionId): void {
  void maybeEditorService()
    ?.openInput({ kind: STREAM_TRACE_KIND, key: `${STREAM_TRACE_KIND}:${session}`, data: { session } }, { focus: true })
    .catch((e) => console.warn("cannot open the stream trace tab", e));
}
