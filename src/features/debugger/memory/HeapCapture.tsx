/** Heap snapshot capture in the Memory tab: its toolbar button, and the progress or refusal row above the table. */
import clsx from "clsx";
import { IconButton, ProgressBar } from "@/ui";
import { tx, useTx } from "@/platform/i18n";
import type { HeapProgress, JvmHeapUnavailable } from "@/platform/ipc";
import { sessionSupports, type DebugSession } from "../state";
import { useActionEnabled } from "../ui/useActionEnabled";
import { cancelCapture, progressFraction, useHeap, type CaptureState } from "../heap/heapState";
import { formatBytes } from "./rows";
import { unavailableText } from "./unavailableText";
import styles from "./MemoryView.module.css";

const isRunning = (c: CaptureState | undefined): c is CaptureState => !!c && c.error === null && c.unavailable === null;

export function progressText(p: HeapProgress | null): string {
  if (p?.type !== "analyzing") return tx("Writing the heap dump…");
  switch (p.phase) {
    case "reading":
      return tx("Reading the dump…");
    case "linking":
      return tx("Linking objects…");
    case "dominators":
      return tx("Computing dominators…");
    case "retained":
      return tx("Computing retained sizes…");
    case "paths":
      return tx("Finding paths to GC roots…");
    case "saving":
      return tx("Saving the index…");
  }
}

function refusalText(reason: JvmHeapUnavailable): string {
  switch (reason.kind) {
    case "memory": {
      const memory = reason.reason;
      // The class table's wording sends the user to Refresh; a refused dump is retried with Capture.
      if (memory.kind !== "unsafeWhileSuspended") return unavailableText(memory);
      const v = memory.javaMajor;
      return v > 0
        ? tx`JDK ${v} cannot write a heap dump while suspended. Resume the program, then capture again.`
        : tx("This JDK cannot write a heap dump while suspended. Resume the program, then capture again.");
    }
    case "notEnoughDiskSpace": {
      const needed = formatBytes(reason.needed);
      const available = formatBytes(reason.available);
      return tx`Not enough disk space for the heap dump: ${needed} needed, ${available} free.`;
    }
    case "dumpFailed": {
      const { message } = reason;
      return tx`The JVM could not write the heap dump: ${message}`;
    }
    case "dumpTimedOut": {
      const n = reason.seconds;
      return tx`The JVM did not finish the heap dump within ${n} seconds.`;
    }
  }
}

/** Capture, or Cancel while a capture of `session` runs; nothing for a session that cannot be dumped. */
export function HeapCaptureButton({ session }: { session: DebugSession }) {
  const tx = useTx();
  const id = session.id;
  const capture = useHeap((s) => s.captures[id]);
  const canCapture = useActionEnabled("debug.heap.capture");
  if (!sessionSupports("jvmHeap", session)) return null;
  if (isRunning(capture)) {
    return (
      <IconButton
        icon="stop"
        title="Cancel Heap Snapshot"
        size="small"
        iconSize={16}
        onClick={() => cancelCapture(id)}
      />
    );
  }
  const tooltip = `${tx("Capture Heap Snapshot")} — ${tx(
    "Writing the dump pauses the program for about a second per gigabyte of heap.",
  )}`;
  return (
    <IconButton
      icon="heap-snapshot"
      action="debug.heap.capture"
      title="Capture Heap Snapshot"
      size="small"
      iconSize={16}
      data-tooltip={tooltip}
      disabled={!canCapture}
    />
  );
}

export function HeapCaptureStatus({ session }: { session: DebugSession }) {
  // Also re-renders the progress and refusal texts, which read the catalog when called.
  const tx = useTx();
  const capture = useHeap((s) => s.captures[session.id]);
  if (!capture) return null;
  if (capture.unavailable) {
    return (
      <div className={styles.banner} role="status">
        {refusalText(capture.unavailable)}
      </div>
    );
  }
  if (capture.error) {
    return (
      <div className={styles.error} role="alert">
        {capture.error}
      </div>
    );
  }
  return (
    <div className={clsx(styles.note, styles.capture)} role="status">
      <span>{progressText(capture.progress)}</span>
      <ProgressBar
        className={styles.captureBar}
        value={progressFraction(capture.progress)}
        aria-label={tx("Capture Heap Snapshot")}
      />
    </div>
  );
}
