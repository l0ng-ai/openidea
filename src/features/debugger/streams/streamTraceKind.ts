import { lazyComponent } from "@/ui";
import { tx } from "@/platform/i18n";
import type { EditorKindContribution } from "@/workbench/contributions";
import { STREAM_TRACE_KIND } from "./streamTraceInput";

/** Not `restorable`: the values belong to one stop of a debug session that a restart ends. */
export const streamTraceKind: EditorKindContribution = {
  kind: STREAM_TRACE_KIND,
  component: lazyComponent(() => import("./StreamTraceEditor").then((m) => m.StreamTraceEditor)),
  title: () => tx("Stream Trace"),
  icon: () => "stream-trace",
};
