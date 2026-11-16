/** What the trace tab says about a result. A component passes its `useTx()` so the text follows the locale. */
import type { AbortState, StreamTraceResult, TraceBanner, TraceUnavailable } from "@/platform/ipc";
import { tx as catalogTx } from "@/platform/i18n";
import { formatCount } from "../memory/rows";
import { formatJvmValue } from "../memory/values";

type Tx = typeof catalogTx;
type Ready = Extract<StreamTraceResult, { status: "ready" }>;

export function unavailableText(reason: TraceUnavailable, tx: Tx = catalogTx): string {
  switch (reason.kind) {
    case "noBackend":
      return tx("Stream tracing needs the Java debugger's inspector");
    case "notSuspended":
      return tx("The program is not stopped");
    case "busy":
      return tx("Another stream trace is running");
    case "noSession":
      return tx("The Java debugger has no session for this program");
    case "notAtChainStart":
    case "unsupported":
      return reason.detail;
  }
}

export function bannerText(banner: TraceBanner, result: Ready, tx: Tx = catalogTx): string {
  switch (banner.kind) {
    case "truncated": {
      const n = formatCount(result.records.length);
      const dropped = formatCount(banner.dropped);
      return tx`Recording stopped after ${n} records (${dropped} more not recorded)`;
    }
    case "countFromSize":
      return tx("count() was computed from the source size; the pipeline did not run");
    case "sortedPassThrough":
      return tx("sorted() kept the order: the source was already sorted");
    case "sequentialized":
      return tx("The parallel chain ran sequentially so it could be traced");
    case "breakpointsSkipped": {
      const count = formatCount(banner.count);
      return banner.count === 1
        ? tx`${count} breakpoint was off while the chain ran`
        : tx`${count} breakpoints were off while the chain ran`;
    }
    case "breakpointsResumed": {
      const count = formatCount(banner.count);
      return banner.count === 1
        ? tx`${count} breakpoint hit while the chain ran was resumed`
        : tx`${count} breakpoint hits while the chain ran were resumed`;
    }
    case "threw": {
      const exception = result.terminal.kind === "threw" ? formatJvmValue(result.terminal.exception) : "";
      return tx`The chain threw ${exception}`;
    }
  }
}

/** Why an abort has not ended the operation yet, or `null` when there is nothing to say. */
export function abortText(abort: AbortState | null, tx: Tx = catalogTx): string | null {
  if (abort?.kind !== "stuck") return null;
  if (abort.holders.length === 0) return tx("The operation is stuck; stop the debug session to end it");
  const threads = abort.holders.map(([, name]) => name).join(", ");
  return tx`The operation is stuck: ${threads} hold locks it needs`;
}
