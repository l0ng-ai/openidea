import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import type {
  DirectoryCompareEntry,
  DirectoryCompareMode,
  DirectoryCompareProgress,
  DirectoryCompareStatus,
  DirectorySyncAction,
  DirectorySyncOperation,
  DirectorySyncProgress,
} from "@/bindings";
import { call, commands, emitLocalIdeEvent, isCancelled, nextRequestId } from "@/platform/ipc";
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
import { editorService, type EditorInput } from "@/workbench/contributions";
import { choosePath } from "@/platform/choosePath";
import { upsertTask } from "@/workbench/tasks";
import { confirmDialog } from "./dialogs";
import { diffInput, openVcsDiff, type DiffData, type DiffSide } from "./diffInput";
import { compareFilesData } from "./compareData";
import { directoryCompareInput, type DirectoryCompareData } from "./directoryCompareKind";
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
/** A row's synchronisation (IDEA's "*" column); `none` leaves the entry alone. */
export type SyncAction = DirectorySyncAction | "none";
const SYNC_ICON: Record<DirectorySyncAction, IconName> = {
  copyToRight: "diff-arrow-right",
  copyToLeft: "diff-arrow-left",
  deleteLeft: "trash",
  deleteRight: "trash",
};
const SYNC_LABEL: Record<SyncAction, string> = {
  copyToRight: "Copy to Right",
  copyToLeft: "Copy to Left",
  deleteLeft: "Delete",
  deleteRight: "Delete",
  none: "Do nothing",
};

/** The operations a row cycles through with Space or a click, its default first. */
export function syncChoices(e: DirectoryCompareEntry): SyncAction[] {
  if (!e.rightKind) return ["copyToRight", "deleteLeft", "none"];
  if (!e.leftKind) return ["copyToLeft", "deleteRight", "none"];
  return ["none", "copyToRight", "copyToLeft"];
}

/** The batch for these rows, skipping `none`; a copy onto an existing entry overwrites it. */
export function syncOperations(
  entries: readonly DirectoryCompareEntry[],
  actionOf: (e: DirectoryCompareEntry) => SyncAction,
): DirectorySyncOperation[] {
  const ops: DirectorySyncOperation[] = [];
  for (const e of entries) {
    const action = actionOf(e);
    if (action === "none") continue;
    const target = action === "copyToRight" ? e.rightKind : action === "copyToLeft" ? e.leftKind : null;
    ops.push({ path: e.path, action, overwrite: !!target });
  }
  return ops;
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
  return (
    <DirectoryCompare
      left={left}
      right={right}
      onPathsChange={(l, r) => {
        // ponytail: reopens as a new tab and closes this one; an in-place input update would keep the tab's position.
        void editorService()
          .openInput(directoryCompareInput(l, r), { focus: true })
          .then(() => editorService().closeInput?.(input.key));
      }}
    />
  );
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

/** The status marker, and a button that changes the row's operation (IDEA's "*" column). */
function SyncCell({
  entry,
  action,
  disabled,
  onCycle,
}: {
  entry: DirectoryCompareEntry;
  action: SyncAction;
  disabled: boolean;
  onCycle: () => void;
}) {
  const t = useTx();
  // Rows left alone keep only the "differ" marker, so a skipped one-sided row shows no arrow.
  const icon = action !== "none" ? SYNC_ICON[action] : entry.status === "different" ? "diff" : null;
  const label = `${t(STATUS[entry.status])}: ${t(SYNC_LABEL[action])}`;
  return (
    <span role="gridcell" className={clsx(styles.cell, styles.marker)}>
      <button
        type="button"
        className={clsx(styles.sync, action !== "none" && styles.planned)}
        aria-label={label}
        title={label}
        tabIndex={-1}
        disabled={disabled}
        // Keep the focus in the table, so Space keeps cycling the selected row.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onCycle();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {icon && <Icon name={icon} size={14} />}
      </button>
    </span>
  );
}

/** An editable folder path with a chooser; Enter or leaving the field compares the typed folder. */
function PathField({
  side,
  path,
  disabled,
  onCommit,
}: {
  side: "left" | "right";
  path: string;
  disabled: boolean;
  onCommit: (path: string) => void;
}) {
  const [draft, setDraft] = useState(path);
  const label = side === "left" ? "Left folder" : "Right folder";
  const commit = (next: string) => {
    if (next.trim() && next.trim() !== path) onCommit(next.trim());
  };
  return (
    <span className={styles.path}>
      <Input
        className={styles.pathInput}
        aria-label={label}
        title={path}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(draft);
          else if (e.key === "Escape" && draft !== path) {
            e.stopPropagation();
            setDraft(path);
          }
        }}
      />
      <IconButton
        icon="folder"
        title="Browse…"
        aria-label={side === "left" ? "Choose left folder" : "Choose right folder"}
        size="small"
        disabled={disabled}
        onClick={async () => {
          const picked = await choosePath({ directory: true, title: label, defaultPath: path });
          if (picked) {
            setDraft(picked);
            commit(picked);
          }
        }}
      />
    </span>
  );
}

export function DirectoryCompare({
  left,
  right,
  onPathsChange,
}: {
  left: string;
  right: string;
  /** Compares other folders (the tab is replaced); without it the paths are read-only. */
  onPathsChange?: (left: string, right: string) => void;
}) {
  const rowHeight = useRowHeight(22);
  const t = useTx();
  const [entries, setEntries] = useState<DirectoryCompareEntry[]>([]);
  const [current, setCurrent] = useState<DirectoryCompareEntry | null>(null);
  const [shown, setShown] = useState<ReadonlySet<DirectoryCompareStatus>>(DEFAULT_SHOWN);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState(loadMode);
  const [actions, setActions] = useState<ReadonlyMap<string, SyncAction>>(new Map());
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(true);
  const [operating, setOperating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
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
        setActions(new Map());
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

  const changePath = async (side: "left" | "right", path: string) => {
    setPathError(null);
    const next = side === "left" ? { left: path, right } : { left, right: path };
    try {
      if ((await call(commands.fsEntryKind(path))) !== "dir") throw new Error(tx`${path} is not a folder`);
      if (next.left === next.right) throw new Error(tx("Choose two different folders"));
      onPathsChange?.(next.left, next.right);
    } catch (e) {
      if (mounted.current) setPathError(e instanceof Error ? e.message : String(e));
    }
  };

  const actionOf = (e: DirectoryCompareEntry) => actions.get(e.path) ?? syncChoices(e)[0]!;
  const cycle = (e: DirectoryCompareEntry) => {
    if (busy || operating) return;
    const choices = syncChoices(e);
    const next = choices[(choices.indexOf(actionOf(e)) + 1) % choices.length]!;
    setActions((m) => new Map(m).set(e.path, next));
  };
  const visible = rows.flatMap((r) => ("entry" in r ? [r.entry] : []));

  const synchronize = async (targets: readonly DirectoryCompareEntry[]) => {
    const ops = syncOperations(targets, actionOf);
    if (!ops.length || busy || operating) return;
    const deletes = ops.filter((o) => o.action === "deleteLeft" || o.action === "deleteRight").length;
    const overwrites = ops.filter((o) => o.overwrite).length;
    const count = ops.length;
    if (
      (deletes || overwrites) &&
      !(await confirmDialog({
        title: "Synchronize",
        message: tx`Synchronize ${count} entries? ${deletes} will be deleted and ${overwrites} overwritten.`,
        okLabel: "Synchronize",
        danger: true,
      }))
    )
      return;
    setOperating(true);
    setOperationError(null);
    const request = nextRequestId();
    const task = {
      id: `directory-sync-${request}`,
      title: tx("Synchronizing directories"),
      message: null as string | null,
      fraction: null as number | null,
      cancel: () => {
        void commands.cancelRequest(request);
      },
    };
    upsertTask({ ...task, done: false });
    const channel = new Channel<DirectorySyncProgress>();
    channel.onmessage = (p) => {
      task.message = p.path;
      task.fraction = p.total ? p.done / p.total : null;
      upsertTask({ ...task, done: false });
    };
    try {
      const failures = await call(commands.fsSynchronizeDirectories(left, right, ops, request, channel));
      const failed = new Set(failures.map((f) => f.path));
      const created: string[] = [];
      const removed: string[] = [];
      for (const o of ops) {
        if (failed.has(o.path)) continue;
        if (o.action === "copyToLeft") created.push(join(left, o.path));
        else if (o.action === "copyToRight") created.push(join(right, o.path));
        else removed.push(join(o.action === "deleteLeft" ? left : right, o.path));
      }
      if (created.length) notifyFileOperation({ kind: "created", paths: created });
      if (removed.length) notifyFileOperation({ kind: "deleted", paths: removed });
      if (created.length || removed.length)
        emitLocalIdeEvent({ type: "fsChanged", created, modified: created, removed });
      if (failures.length && mounted.current)
        setOperationError(failures.map((f) => `${f.path}: ${tx(f.message)}`).join("\n"));
    } catch (e) {
      if (mounted.current && !isCancelled(e)) setOperationError(e instanceof Error ? e.message : String(e));
    } finally {
      upsertTask({ ...task, done: true });
      if (mounted.current) {
        setOperating(false);
        refresh();
      }
    }
  };

  const idle = !busy && !operating;
  const table = (
    <div
      className={styles.table}
      role="grid"
      aria-label={t("Compared files")}
      aria-rowcount={rows.length + 1}
      onKeyDown={(e) => {
        if (e.key !== " " || !selected) return;
        e.preventDefault();
        cycle(selected);
      }}
    >
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
              <SyncCell entry={r.entry} action={actionOf(r.entry)} disabled={!idle} onCycle={() => cycle(r.entry)} />
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
          <Button
            size="small"
            disabled={!idle || !selected || actionOf(selected) === "none"}
            onClick={() => void synchronize(selected ? [selected] : [])}
          >
            Synchronize Selected
          </Button>
          <Button
            size="small"
            disabled={!idle || !visible.some((e) => actionOf(e) !== "none")}
            onClick={() => void synchronize(visible)}
          >
            Synchronize All
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
        {(["left", "right"] as const).map((side) => (
          <PathField
            key={`${side}:${side === "left" ? left : right}`}
            side={side}
            path={side === "left" ? left : right}
            disabled={!onPathsChange || operating}
            onCommit={(path) => void changePath(side, path)}
          />
        ))}
      </div>
      {pathError && (
        <div className={styles.error} role="alert">
          {tx(pathError)}
        </div>
      )}
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
