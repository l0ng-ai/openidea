import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import type {
  DirectoryCompareEntry,
  DirectoryCompareMode,
  DirectoryCompareProgress,
  DirectoryCompareStatus,
} from "@/bindings";
import { call, commands, emitLocalIdeEvent, IpcError, isCancelled, nextRequestId } from "@/platform/ipc";
import { notifyFileOperation } from "@/platform/fileOps";
import { tx, useTx } from "@/platform/i18n";
import {
  Button,
  Icon,
  IconButton,
  Input,
  List,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  T,
  fileIconName,
  lazyComponent,
  type IconName,
} from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { upsertTask } from "@/workbench/tasks";
import { confirmDialog } from "./dialogs";
import { diffInput, openVcsDiff, type DiffData, type DiffSide } from "./diffInput";
import { compareFilesData, displayPath } from "./compareData";
import type { DirectoryCompareData } from "./directoryCompareKind";
import { formatSize, formatTime } from "./model";
import styles from "./DirectoryCompare.module.css";
import { useRowHeight } from "@/ui/density";

const DiffEditor = lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor));

const STATUS: Record<DirectoryCompareStatus, string> = {
  leftOnly: "Only on left",
  rightOnly: "Only on right",
  different: "Contents differ",
  equal: "Identical",
};
/** Status filter toggles, in the order of the toolbar. */
const FILTERS: { status: DirectoryCompareStatus; title: string; icon: IconName }[] = [
  { status: "leftOnly", title: "Show files only on left", icon: "diff-arrow-right" },
  { status: "different", title: "Show different files", icon: "diff" },
  { status: "equal", title: "Show identical files", icon: "check" },
  { status: "rightOnly", title: "Show files only on right", icon: "diff-arrow-left" },
];
const MARKER: Partial<Record<DirectoryCompareStatus, IconName>> = {
  leftOnly: "diff-arrow-right",
  rightOnly: "diff-arrow-left",
  different: "diff",
};
/** IDEA's "Compare by" choices; the last one picked is kept for the next comparison. */
export const COMPARE_MODES: ReadonlyArray<{ value: DirectoryCompareMode; label: string }> = [
  { value: "content", label: "Binary content" },
  { value: "text", label: "Text" },
  { value: "size", label: "Size" },
  { value: "sizeAndTimestamp", label: "Size and timestamp" },
];
const MODE_KEY = "openidea.directoryCompare.mode";
function loadMode(): DirectoryCompareMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return COMPARE_MODES.find((m) => m.value === saved)?.value ?? "content";
  } catch {
    return "content";
  }
}
function saveMode(mode: DirectoryCompareMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}
const DEFAULT_SHOWN: ReadonlySet<DirectoryCompareStatus> = new Set(["leftOnly", "rightOnly", "different"]);

const join = (root: string, path: string) => `${root.replace(/\/$/, "")}/${path}`;
const directory = (e: DirectoryCompareEntry) => e.leftKind === "dir" || e.rightKind === "dir";
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function directoryDiff(left: string, right: string, entry: DirectoryCompareEntry): DiffData | null {
  if (directory(entry)) return null;
  const data = compareFilesData(join(left, entry.path), join(right, entry.path));
  const missing = (): DiffSide => ({ type: "text", text: "", label: tx("(does not exist)"), absent: true });
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

/** A separator naming a folder (one present on both sides heads its group as a selectable `folder` row). */
export type DirectoryRow = { section: string } | { entry: DirectoryCompareEntry; folder?: boolean };

/**
 * The table's rows: entries grouped under a row per folder (files at the top level first). A
 * folder present on both sides heads its group and can be copied as a whole; a folder on one
 * side only is one row, its contents going with it. `shown` filters by status, `query` by path
 * (a one-sided folder matches by its contents too).
 */
export function directoryRows(
  entries: readonly DirectoryCompareEntry[],
  shown: ReadonlySet<DirectoryCompareStatus>,
  query: string,
): DirectoryRow[] {
  const q = query.trim().toLocaleLowerCase();
  const both = (e: DirectoryCompareEntry) => e.leftKind === "dir" && e.rightKind === "dir";
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const oneSided = new Set(entries.filter((e) => directory(e) && (!e.leftKind || !e.rightKind)).map((e) => e.path));
  // The outermost one-sided folder: the only row shown for its whole subtree.
  const owner = (path: string) => {
    let found: string | null = null;
    for (let p = parentOf(path); p; p = parentOf(p)) if (oneSided.has(p)) found = p;
    return found;
  };
  const matched = new Set<string>();
  for (const e of entries) if (q && e.path.toLocaleLowerCase().includes(q)) matched.add(owner(e.path) ?? e.path);
  const groups = new Map<string, DirectoryCompareEntry[]>();
  for (const e of entries) {
    if (both(e) || owner(e.path) || !shown.has(e.status) || (q && !matched.has(e.path))) continue;
    const parent = parentOf(e.path);
    groups.set(parent, [...(groups.get(parent) ?? []), e]);
  }
  const rows: DirectoryRow[] = [];
  for (const parent of [...groups.keys()].sort()) {
    const folder = byPath.get(parent);
    if (folder && both(folder)) rows.push({ entry: folder, folder: true });
    else if (parent) rows.push({ section: parent });
    const items = groups.get(parent)!;
    items.sort((a, b) => (nameOf(a.path) < nameOf(b.path) ? -1 : 1));
    for (const entry of items) rows.push({ entry });
  }
  return rows;
}

export function DirectoryCompareEditor({ input }: { input: EditorInput }) {
  const { left, right } = input.data as DirectoryCompareData;
  return <DirectoryCompare left={left} right={right} />;
}

const COLUMNS = {
  left: ["name", "size", "date"],
  right: ["date", "size", "name"],
} as const;
const COLUMN_LABELS = { name: "Name", size: "Size", date: "Date" };

function SideHeaders({ side }: { side: "left" | "right" }) {
  return COLUMNS[side].map((column) => (
    <span key={column} role="columnheader" className={clsx(styles.cell, column !== "name" && styles[column])}>
      <T>{COLUMN_LABELS[column]}</T>
    </span>
  ));
}

function Side({ entry, side, folder }: { entry: DirectoryCompareEntry; side: "left" | "right"; folder?: boolean }) {
  const kind = side === "left" ? entry.leftKind : entry.rightKind;
  const size = side === "left" ? entry.leftSize : entry.rightSize;
  const modified = side === "left" ? entry.leftModified : entry.rightModified;
  const name = folder ? entry.path : nameOf(entry.path);
  const values = {
    name: kind && (
      <>
        <Icon name={kind === "dir" ? "folder" : fileIconName(name)} size={14} />
        <span className={styles.text}>{name}</span>
      </>
    ),
    size: size != null ? formatSize(size) : "",
    date: kind ? formatTime(modified) : "",
  };
  const details = kind ? [name, values.size, values.date].filter(Boolean).join(" · ") : undefined;
  return COLUMNS[side].map((column) => (
    <span
      key={column}
      role="gridcell"
      className={clsx(styles.cell, column !== "name" && styles[column])}
      title={column === "name" ? details : undefined}
    >
      {values[column]}
    </span>
  ));
}

export function DirectoryCompare({ left, right }: { left: string; right: string }) {
  const rowHeight = useRowHeight(22);
  const t = useTx();
  const [entries, setEntries] = useState<DirectoryCompareEntry[]>([]);
  const [current, setCurrent] = useState<DirectoryCompareEntry | null>(null);
  const [shown, setShown] = useState<ReadonlySet<DirectoryCompareStatus>>(DEFAULT_SHOWN);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState(loadMode);
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
    void call(commands.fsCompareDirectories(left, right, mode, request, channel))
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
  }, [left, right, mode, generation]);

  const rows = useMemo(() => directoryRows(entries, shown, filter), [entries, shown, filter]);
  const activeIndex = rows.findIndex((r) => "entry" in r && r.entry.path === current?.path);
  const selected =
    cancelled || error || activeIndex < 0 ? null : (rows[activeIndex] as { entry: DirectoryCompareEntry }).entry;
  const diff = selected && !busy && !operating ? directoryDiff(left, right, selected) : null;
  const preview = diff && diffInput(diff);
  const refresh = () => {
    setBusy(true);
    setCancelled(false);
    setError(null);
    setProgress(null);
    setGeneration((g) => g + 1);
  };
  const toggle = (status: DirectoryCompareStatus) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(status)) next.add(status);
      return next;
    });
  const open = (entry: DirectoryCompareEntry) => {
    const data = !busy && !operating && directoryDiff(left, right, entry);
    if (data) void openVcsDiff(data);
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

  const idle = !busy && !operating;
  const table = (
    <div className={styles.table} role="grid" aria-label={t("Compared files")} aria-rowcount={rows.length + 1}>
      <div role="rowgroup">
        <div className={styles.head} role="row" aria-rowindex={1}>
          <SideHeaders side="left" />
          <span role="columnheader" aria-label={t("Status")} />
          <SideHeaders side="right" />
        </div>
      </div>
      <List<DirectoryRow>
        className={styles.list}
        items={rows}
        getKey={(r) => ("section" in r ? `/${r.section}` : r.entry.path)}
        isSection={(r) => "section" in r}
        renderSection={(r) =>
          "section" in r && (
            <span className={styles.section}>
              <Icon name="folder" size={14} />
              <span className={styles.text}>{r.section}</span>
            </span>
          )
        }
        activeIndex={activeIndex}
        onActiveChange={(i) => {
          const row = rows[i];
          if (row && "entry" in row) setCurrent(row.entry);
        }}
        onActivate={(r, _i, e) => {
          if ("entry" in r && e.type === "keydown") open(r.entry);
        }}
        rowHeight={rowHeight}
        tableBody={{ headerRows: 1 }}
        empty={
          !busy && !cancelled && !error ? (
            <span className={styles.message} role="status">
              <T>No matching differences</T>
            </span>
          ) : undefined
        }
        renderItem={(r) =>
          "entry" in r && (
            <div
              role="none"
              className={clsx(styles.row, styles[r.entry.status], r.folder && styles.folder)}
              onDoubleClick={() => open(r.entry)}
            >
              <Side entry={r.entry} side="left" folder={r.folder} />
              <span
                role="gridcell"
                className={clsx(styles.cell, styles.marker)}
                aria-label={t(STATUS[r.entry.status])}
                title={t(STATUS[r.entry.status])}
              >
                {MARKER[r.entry.status] && <Icon name={MARKER[r.entry.status]!} size={14} />}
              </span>
              <Side entry={r.entry} side="right" folder={r.folder} />
            </div>
          )
        }
      />
    </div>
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <IconButton icon="refresh" title="Refresh" size="small" disabled={!idle} onClick={refresh} />
          <Select<DirectoryCompareMode>
            className={styles.select}
            value={mode}
            options={COMPARE_MODES}
            disabled={operating}
            title="Compare by"
            aria-label="Compare by"
            onChange={(next) => {
              saveMode(next);
              setMode(next);
              refresh();
            }}
          />
          {FILTERS.map((f) => (
            <IconButton
              key={f.status}
              icon={f.icon}
              title={f.title}
              size="small"
              pressed={shown.has(f.status)}
              onClick={() => toggle(f.status)}
            />
          ))}
        </div>
        <div className={styles.toolbarGroup}>
          <Button size="small" disabled={!selected?.rightKind || !idle} onClick={() => void operate("left")}>
            Copy to Left
          </Button>
          <Button size="small" disabled={!selected?.leftKind || !idle} onClick={() => void operate("right")}>
            Copy to Right
          </Button>
          <Button
            size="small"
            disabled={!selected || !!selected.leftKind === !!selected.rightKind || !idle}
            onClick={() => void operate("delete")}
          >
            Delete
          </Button>
        </div>
        <Input
          className={styles.filter}
          aria-label="Filter by name"
          placeholder="Filter by name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {operating && <Spinner size={14} />}
        {busy && (
          <span className={styles.progress} role="status">
            <Spinner size={14} />
            <span className={styles.text}>
              {progress?.total != null
                ? tx`Compared ${progress.compared} of ${progress.total} entries`
                : tx`Scanned ${progress?.scanned ?? 0} entries`}
            </span>
            <Button size="small" onClick={() => cancel.current()}>
              Cancel
            </Button>
          </span>
        )}
      </div>
      <div className={styles.paths}>
        <span className={styles.path} title={left}>
          <Icon name="folder" size={14} />
          <span className={styles.text}>{tx`Left: ${displayPath(left)}`}</span>
        </span>
        <span className={styles.path} title={right}>
          <Icon name="folder" size={14} />
          <span className={styles.text}>{tx`Right: ${displayPath(right)}`}</span>
        </span>
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
      {cancelled && (
        <div className={styles.notice} role="status">
          <T>Comparison cancelled</T>
        </div>
      )}
      <div className={styles.body}>
        <SplitGroup
          orientation="vertical"
          storageKey="openidea.directoryCompare.layout"
          defaultLayout={{ files: 40, preview: 60 }}
        >
          <SplitPanel id="files" minSize="15%" className={styles.panel}>
            {table}
          </SplitPanel>
          <SplitHandle aria-label={t("Preview")} />
          <SplitPanel id="preview" minSize="15%" className={styles.panel}>
            {preview ? (
              <DiffEditor key={preview.key} input={preview} />
            ) : (
              <div className={styles.message}>
                <T>Select a file to compare its contents</T>
              </div>
            )}
          </SplitPanel>
        </SplitGroup>
      </div>
    </div>
  );
}
