/** Open Heap Dump… and Save Heap Dump As…: the native dialogs, the open's progress, and what went wrong. */
import { ProgressBar } from "@/ui";
import { setContext } from "@/platform/context";
import { tx, useTx } from "@/platform/i18n";
import { call, commands, IpcError } from "@/platform/ipc";
import { open as openDialog, save as saveDialog } from "@/platform/dialog";
import { ipcPath } from "@/platform/paths";
import { basename } from "@/platform/project";
import { isRemoteWindow, useRemote } from "@/platform/remote";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { formatBytes } from "../memory/rows";
import { progressText } from "../memory/HeapCapture";
import { heapSnapshotOf } from "./heapInput";
import { cancelOpen, openHeapFile, progressFraction, useHeap } from "./heapState";
import styles from "./HeapSnapshotEditor.module.css";

const OPENING = "debug.heap.open";
const FILTERS = () => [{ name: tx("Heap dump"), extensions: ["hprof"] }];

function OpenProgress() {
  // Also re-renders the phase text, which reads the catalog when called.
  const tx = useTx();
  const opening = useHeap((s) => s.opening);
  if (!opening) return null;
  const { progress } = opening;
  return (
    <div className={styles.openProgress}>
      <span>{progress?.type === "analyzing" ? progressText(progress) : tx("Reading the dump…")}</span>
      <ProgressBar value={progressFraction(progress)} aria-label={tx("Open Heap Dump…")} />
    </div>
  );
}

function openFailure(e: unknown): string {
  if (!(e instanceof IpcError)) return e instanceof Error ? e.message : String(e);
  const { message } = e;
  return e.kind === "invalidInput" ? tx`This file is not a heap dump the IDE can read: ${message}` : message;
}

export async function openHeapDump(): Promise<void> {
  if (isRemoteWindow()) {
    notifications().notify({ group: "run", level: "info", title: "Heap dumps can be opened in local windows only." });
    return;
  }
  // One file at a time; the running open keeps its progress notification.
  if (useHeap.getState().opening) return;
  const picked = await openDialog({ multiple: false, directory: false, filters: FILTERS() });
  if (typeof picked !== "string" || useHeap.getState().opening) return;
  const path = ipcPath(picked);
  const name = basename(path);
  notifications().notify({
    group: "run",
    level: "info",
    key: OPENING,
    sticky: true,
    title: tx`Opening ${name}…`,
    body: <OpenProgress />,
    actions: [{ label: "Cancel", run: cancelOpen }],
  });
  try {
    const result = await openHeapFile(path);
    if (result?.status === "notEnoughDiskSpace") {
      const needed = formatBytes(result.needed);
      const available = formatBytes(result.available);
      notifications().notify({
        group: "run",
        level: "warning",
        key: OPENING,
        title: tx`Not enough disk space for the heap dump: ${needed} needed, ${available} free.`,
      });
      return;
    }
    notifications().expire?.(OPENING);
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      key: OPENING,
      title: "Cannot open the heap dump",
      body: openFailure(e),
    });
  }
}

export async function saveHeapDump(id: number): Promise<void> {
  const entry = useHeap.getState().snapshots[id];
  if (!entry || entry.info.origin.kind !== "captured" || isRemoteWindow()) return;
  const picked = await saveDialog({
    defaultPath: `${entry.info.label.replace(/[/\\:*?"<>|]/g, "-")}.hprof`,
    filters: FILTERS(),
  });
  if (!picked) return;
  try {
    // The save dialog already confirmed replacing an existing file.
    await call(commands.debugHeapSave(id, ipcPath(picked)));
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: "Cannot save the heap dump",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The captured snapshot whose tab is active, which Save Heap Dump As… writes; `null` in a remote window. */
export function activeCapturedSnapshot(): number | null {
  const id = heapSnapshotOf(maybeEditorService()?.activeInput?.() ?? null);
  if (id === null || isRemoteWindow()) return null;
  return useHeap.getState().snapshots[id]?.info.origin.kind === "captured" ? id : null;
}

/** Keeps `debugHeapSnapshotCaptured` (the `when` of Save Heap Dump As…) in step with the active tab. */
export function installHeapContext(): () => void {
  const sync = () => setContext("debugHeapSnapshotCaptured", activeCapturedSnapshot() !== null);
  sync();
  const offs = [
    maybeEditorService()?.onActiveInputChange?.(sync),
    useHeap.subscribe((s, prev) => s.snapshots !== prev.snapshots && sync()),
    useRemote.subscribe(sync),
  ];
  return () => {
    for (const off of offs) off?.();
    setContext("debugHeapSnapshotCaptured", false);
  };
}
