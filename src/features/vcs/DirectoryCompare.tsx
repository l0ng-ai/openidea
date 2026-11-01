import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import type { DirectoryCompareEntry, DirectoryCompareProgress, DirectoryCompareStatus } from "@/bindings";
import { call, commands, emitLocalIdeEvent, IpcError, isCancelled, nextRequestId } from "@/platform/ipc";
import { notifyFileOperation } from "@/platform/fileOps";
import { tx } from "@/platform/i18n";
import { Button, Checkbox, Dialog, Input, Spinner, T } from "@/ui";
import { upsertTask } from "@/workbench/tasks";
import { ComparisonTree } from "./ComparisonTree";
import { buildFileTree } from "./fileTree";
import { confirmDialog, openDialog } from "./dialogs";
import { openDiff, type DiffData, type DiffSide } from "./diffInput";
import { compareFilesData } from "./compareData";
import styles from "./common.module.css";

const STATUS: Record<DirectoryCompareStatus, string> = {
  leftOnly: "Only on left",
  rightOnly: "Only on right",
  different: "Contents differ",
  equal: "Identical",
};
const join = (root: string, path: string) => `${root.replace(/\/$/, "")}/${path}`;
const directory = (e: DirectoryCompareEntry) => e.leftKind === "dir" || e.rightKind === "dir";

export function directoryDiff(left: string, right: string, entry: DirectoryCompareEntry): DiffData | null {
  if (directory(entry)) return null;
  const data = compareFilesData(join(left, entry.path), join(right, entry.path));
  const missing = (): DiffSide => ({ type: "text", text: "", label: tx("(does not exist)") });
  return {
    ...data,
    title: entry.path,
    left:
      entry.leftKind === "symlink"
        ? { type: "text", text: entry.leftLink ?? "", label: data.left.label ?? join(left, entry.path) }
        : entry.leftKind
          ? data.left
          : missing(),
    right:
      entry.rightKind === "symlink"
        ? { type: "text", text: entry.rightLink ?? "", label: data.right.label ?? join(right, entry.path) }
        : entry.rightKind
          ? data.right
          : missing(),
  };
}

export function showDirectoryComparison(left: string, right: string) {
  if (left === right) return;
  openDialog((close) => <DirectoryCompareDialog left={left} right={right} onClose={close} />);
}

export function DirectoryCompareDialog({ left, right, onClose }: { left: string; right: string; onClose: () => void }) {
  const [entries, setEntries] = useState<DirectoryCompareEntry[]>([]);
  const [current, setCurrent] = useState<DirectoryCompareEntry | null>(null);
  const [showEqual, setShowEqual] = useState(false);
  const [filter, setFilter] = useState("");
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(true);
  const [operating, setOperating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DirectoryCompareProgress | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const cancel = useRef<() => void>(() => {});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let pending = true;
    const request = nextRequestId();
    const task = {
      id: `directory-compare-${request}`,
      title: tx("Comparing directories"),
      message: null as string | null,
      fraction: null as number | null,
      cancel: () => {
        void commands.cancelRequest(request);
      },
    };
    cancel.current = task.cancel;
    upsertTask({ ...task, done: false });
    const channel = new Channel<DirectoryCompareProgress>();
    channel.onmessage = (p) => {
      if (!alive) return;
      setProgress(p);
      task.message = p.path;
      task.fraction = p.total ? p.compared / p.total : null;
      upsertTask({ ...task, done: false });
    };
    void call(commands.fsCompareDirectories(left, right, request, channel))
      .then((rows) => {
        if (!alive) return;
        setEntries(rows);
        setCurrent((prev) => rows.find((e) => e.path === prev?.path) ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        if (isCancelled(e)) setCancelled(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        pending = false;
        upsertTask({ ...task, done: true });
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      if (pending) task.cancel();
      upsertTask({ ...task, done: true });
    };
  }, [left, right, generation]);

  const visible = useMemo(() => {
    const paths = new Set<string>();
    const query = filter.trim().toLocaleLowerCase();
    for (const e of entries) {
      if ((!showEqual && e.status === "equal") || !e.path.toLocaleLowerCase().includes(query)) continue;
      let path = e.path;
      while (path) {
        paths.add(path);
        const slash = path.lastIndexOf("/");
        path = slash < 0 ? "" : path.slice(0, slash);
      }
    }
    return entries.filter((e) => paths.has(e.path));
  }, [entries, showEqual, filter]);
  const tree = useMemo(() => buildFileTree(visible, (e) => e.path, directory), [visible]);
  const selected = cancelled || error ? null : (visible.find((e) => e.path === current?.path) ?? null);
  const diff = selected && directoryDiff(left, right, selected);
  const refresh = () => {
    setBusy(true);
    setCancelled(false);
    setError(null);
    setProgress(null);
    setGeneration((g) => g + 1);
  };

  const operate = async (side: "left" | "right" | "delete") => {
    if (!selected || busy || operating) return;
    setOperating(true);
    setOperationError(null);
    let attempted = false;
    const targetRoot = side === "left" ? left : right;
    try {
      if (side === "delete") {
        if (!!selected.leftKind === !!selected.rightKind) return;
        const path = join(selected.leftKind ? left : right, selected.path);
        if (!(await confirmDialog({ title: "Delete", message: tx`Delete ${path}?`, okLabel: "Delete", danger: true })))
          return;
        attempted = true;
        await call(commands.fsDelete(path));
        notifyFileOperation({ kind: "deleted", paths: [path] });
        emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed: [path] });
      } else {
        const sourceRoot = side === "left" ? right : left;
        const to = join(targetRoot, selected.path);
        try {
          attempted = true;
          await call(commands.fsCopyMerge(sourceRoot, targetRoot, selected.path, false));
        } catch (e) {
          if (!(e instanceof IpcError) || e.kind !== "alreadyExists") throw e;
          if (
            !(await confirmDialog({
              title: "Overwrite files?",
              message: tx`Copy to ${to} and overwrite existing files?`,
              okLabel: "Overwrite",
              danger: true,
            }))
          )
            return;
          await call(commands.fsCopyMerge(sourceRoot, targetRoot, selected.path, true));
        }
        notifyFileOperation({ kind: "created", paths: [to] });
        emitLocalIdeEvent({ type: "fsChanged", created: [to], modified: [to], removed: [] });
      }
    } catch (e) {
      if (mounted.current) setOperationError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) {
        setOperating(false);
        if (attempted) refresh();
      }
    }
  };

  return (
    <Dialog
      open
      title="Compare Directories"
      onClose={onClose}
      width={diff ? 1100 : 780}
      buttons={[
        {
          label: "Show Diff",
          disabled: !diff || busy || operating,
          onClick: () => {
            if (diff) {
              void openDiff(diff);
              onClose();
            }
          },
        },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.compareNotice}>{tx`Left: ${left}`}</div>
      <div className={styles.compareNotice}>{tx`Right: ${right}`}</div>
      <div className={styles.compareToolbar}>
        <Input
          aria-label="Filter by name"
          placeholder="Filter by name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Checkbox label="Show identical files" checked={showEqual} onChange={setShowEqual} />
        <Button size="small" disabled={busy || operating} onClick={refresh}>
          Refresh
        </Button>
      </div>
      <div className={styles.compareToolbar}>
        <Button size="small" disabled={!selected?.rightKind || busy || operating} onClick={() => void operate("left")}>
          Copy to Left
        </Button>
        <Button size="small" disabled={!selected?.leftKind || busy || operating} onClick={() => void operate("right")}>
          Copy to Right
        </Button>
        <Button
          size="small"
          disabled={!selected || !!selected.leftKind === !!selected.rightKind || busy || operating}
          onClick={() => void operate("delete")}
        >
          Delete
        </Button>
        {operating && <Spinner size={14} />}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {tx(error)}
        </div>
      )}
      {operationError && (
        <div className={styles.error} role="alert">
          {tx(operationError)}
        </div>
      )}
      {busy && (
        <div className={styles.compareToolbar} role="status">
          <Spinner size={14} />
          <span>
            {progress?.total != null
              ? tx`Compared ${progress.compared} of ${progress.total} entries`
              : tx`Scanned ${progress?.scanned ?? 0} entries`}
          </span>
          <Button size="small" onClick={() => cancel.current()}>
            Cancel
          </Button>
        </div>
      )}
      {cancelled && (
        <div className={styles.compareNotice} role="status">
          <T>Comparison cancelled</T>
        </div>
      )}
      {!busy && !cancelled && !error && !visible.length && (
        <div className={styles.empty} role="status">
          <T>No matching differences</T>
        </div>
      )}
      {!!tree.length && (
        <ComparisonTree
          tree={tree}
          current={busy || operating ? null : selected}
          onSelect={setCurrent}
          diffFor={(e) => directoryDiff(left, right, e)}
          openOnActivate={!busy && !operating}
          onOpen={onClose}
          ariaLabel="Compared files"
          renderDetails={(n) => {
            const entry = n.file ?? n.directory;
            return <span className={styles.fileDir}>{entry ? tx(STATUS[entry.status]) : n.count}</span>;
          }}
        />
      )}
    </Dialog>
  );
}
