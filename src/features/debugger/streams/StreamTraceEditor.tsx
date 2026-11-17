/** The "Stream Trace" editor tab: the session's latest trace while it runs, then what each step did. */
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import type { DebugSessionId } from "@/platform/ipc";
import { Button, ProgressBar, T } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { formatCount } from "../memory/rows";
import { useDebug } from "../state";
import { useActionEnabled } from "../ui/useActionEnabled";
import { traceValuesOutdated, useStreamTrace, type TraceEntry } from "./streamStore";
import { traceSessionOf } from "./streamTraceInput";
import { abortText, bannerText, unavailableText } from "./traceText";
import { TraceResultView } from "./TraceResultView";
import styles from "./StreamTraceEditor.module.css";

export function StreamTraceEditor({ input }: { input: EditorInput }) {
  const session = traceSessionOf(input);
  const entry = useStreamTrace((s) => (session == null ? undefined : s.bySession[session]));
  // The store forgets a trace with its session, and a tab moved into another window finds none.
  if (session == null || !entry) {
    return (
      <div className={styles.root}>
        <div className={styles.note} role="status">
          <T>This stream trace is no longer available.</T>
        </div>
      </div>
    );
  }
  return <TraceView key={entry.request} session={session} entry={entry} />;
}

function TraceView({ session, entry }: { session: DebugSessionId; entry: TraceEntry }) {
  const tx = useTx();
  const debug = useDebug((s) => s.sessions[session]);
  const running = entry.result === null && entry.error === null;
  const result = entry.result;
  const terminal = entry.chain.terminal;
  const stuck = running ? abortText(entry.abort, tx) : null;
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <code className={styles.chain} title={entry.chain.text}>
          {entry.chain.text.replace(/\s*\n\s*/g, "")}
        </code>
        {running && <RunningTools session={session} entry={entry} />}
      </header>
      {running && <ProgressBar aria-label={tx("Tracing the stream chain")} />}
      {running && entry.stoppedRecording && (
        <div className={styles.banner} role="status">
          {tx`Breakpoints stay off until ${terminal} finishes`}
        </div>
      )}
      {stuck && (
        <div className={styles.error} role="alert">
          {stuck}
        </div>
      )}
      {entry.error && (
        <div className={styles.error} role="alert">
          {entry.error}
        </div>
      )}
      {result?.status === "unavailable" && (
        <div className={styles.error} role="alert">
          {unavailableText(result.reason, tx)}
        </div>
      )}
      {result?.status === "failed" && (
        <div className={styles.error} role="alert">
          {result.detail}
        </div>
      )}
      {result?.status === "cancelled" && (
        <div className={styles.note}>
          {entry.stoppedRecording ? (
            <T>Recording stopped before the trace started</T>
          ) : (
            <T>The trace was cancelled before the chain ran</T>
          )}
        </div>
      )}
      {result?.status === "ready" && (
        <>
          {result.banners.map((b, i) => (
            <div key={i} className={styles.banner} role="status">
              {bannerText(b, result, tx)}
            </div>
          ))}
          <TraceResultView session={session} result={result} outdated={traceValuesOutdated(entry, debug)} />
        </>
      )}
    </div>
  );
}

function RunningTools({ session, entry }: { session: DebugSessionId; entry: TraceEntry }) {
  const tx = useTx();
  // The tab's own session: another one may be the active session.
  const canStop = useActionEnabled("debug.streamTrace.stopRecording", session);
  const canAbort = useActionEnabled("debug.streamTrace.abort", session);
  const records = formatCount(entry.progress?.records ?? 0);
  const seconds = Math.floor((entry.progress?.elapsedMs ?? 0) / 1000);
  return (
    <div className={styles.tools}>
      <span className={styles.progressText}>{tx`${records} records · ${seconds} s`}</span>
      <Button
        variant="primary"
        size="small"
        disabled={!canStop}
        onClick={() => void executeAction("debug.streamTrace.stopRecording", session)}
      >
        Stop Recording
      </Button>
      <Button size="small" disabled={!canAbort} onClick={() => void executeAction("debug.streamTrace.abort", session)}>
        Abort Operation…
      </Button>
    </div>
  );
}
