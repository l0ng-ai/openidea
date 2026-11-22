/**
 * Shelf: Shelve Changes… (named patch under `.openidea/shelf`, changes reverted),
 * the Shelf tab of the Commit tool window, Unshelve (3-way, conflicts go to the
 * merge UI), rename and delete.
 */
import { writeClipboardText } from "@/platform/clipboard";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import type {
  ApplyOutcome,
  ChangedFile,
  ChangelistState,
  FileStatus,
  ShelvedChangeList,
  ShelfDiffFile,
} from "@/bindings";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { openDiff, openVcsDiff, withChain, type DiffData } from "./diffInput";
import { showCreatePatchForShelf } from "./patches";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import {
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tree,
  fileIconName,
  showContextMenu,
  T,
} from "@/ui";
import { notifications } from "@/workbench/contributions";
import { groupOf } from "./changes";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { activeList, listOf, moveFiles, relOf, updateChangelists, useChangelists } from "./changelists";
import { useCommit } from "./commitStore";
import { showLocalChanges } from "./commitUi";
import { confirmDialog, openDialog, promptText } from "./dialogs";
import {
  KIND_COLOR,
  KIND_LABEL,
  baseName,
  dirName,
  effectiveKind,
  fileCount,
  formatTime,
  relTo,
  stripSlash,
} from "./model";
import { errorMessage, logConsole, runOp, saveAll } from "./ops";
import { conflictedFiles, currentRepo, refreshNow, useVcs } from "./store";
import { repositoryPath } from "./repositoryPaths";
import styles from "./common.module.css";
import viewStyles from "./CommitView.module.css";
import shelfStyles from "./Shelf.module.css";
import { tx } from "@/platform/i18n";

interface ShelfState {
  shelves: ShelvedChangeList[];
  loaded: boolean;
  diffs: Record<string, ShelfDiffFile[]>;
}

export const useShelf = create<ShelfState>(() => ({ shelves: [], loaded: false, diffs: {} }));

export async function loadShelves(): Promise<ShelvedChangeList[]> {
  const root = useVcs.getState().root;
  const shelves = await call(commands.vcsShelves());
  if (useVcs.getState().root !== root) return shelves;
  useShelf.setState({ shelves, loaded: true, diffs: {} });
  for (const entry of shelves) {
    void call(commands.vcsShelfDiff(entry.id))
      .then((files) => {
        if (useShelf.getState().shelves !== shelves) return;
        useShelf.setState((state) => ({ diffs: { ...state.diffs, [entry.id]: files } }));
      })
      .catch(() => undefined);
  }
  return shelves;
}

export function showShelf() {
  showLocalChanges("shelf");
  void loadShelves().catch(() => undefined);
}

/** Files a Shelve / Create Patch action applies to: explicit paths, else the active list's changes. */
export function defaultChangeFiles(paths?: readonly string[]): FileStatus[] {
  const { status, root } = useVcs.getState();
  const changes = status.filter((f) => groupOf(f) === "changes" || (paths?.length && groupOf(f) === "unversioned"));
  if (paths?.length) {
    const set = new Set(paths.map(stripSlash));
    return changes.filter((f) => {
      const p = stripSlash(f.path);
      if (set.has(p)) return true;
      for (const s of set) if (p.startsWith(`${s}/`)) return true;
      return false;
    });
  }
  const state = useChangelists.getState().state;
  return changes.filter(
    (f) => groupOf(f) === "changes" && listOf(state, relTo(root ?? "", stripSlash(f.path))) === state.active,
  );
}

/** Name a shelf of `list`'s changes gets by default: the list's name once the project has several. */
function shelfName(state: ChangelistState, list: string): string {
  return state.lists.length > 1
    ? (state.lists.find((l) => l.id === list) ?? activeList(state)).name
    : "Uncommitted changes";
}

export function shelveChanges(paths?: readonly string[]) {
  const files = defaultChangeFiles(paths);
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to shelve" });
    return;
  }
  const state = useChangelists.getState().state;
  openDialog((close) => <ShelveDialog files={files} initialName={shelfName(state, state.active)} onClose={close} />);
}

/** IDEA's Shelve Silently: no dialog, one shelf per changelist the changes belong to, named after it. */
export async function shelveSilently(paths?: readonly string[]) {
  // Without a dialog to review the files, pick them after unsaved edits reach the disk.
  await saveAll();
  await refreshNow();
  const files = defaultChangeFiles(paths);
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to shelve" });
    return;
  }
  const state = useChangelists.getState().state;
  const byList = new Map<string, string[]>();
  for (const f of files) {
    const list = listOf(state, relOf(f.path));
    const own = byList.get(list);
    if (own) own.push(stripSlash(f.path));
    else byList.set(list, [stripSlash(f.path)]);
  }
  for (const [list, chosen] of byList) if (!(await shelveFiles(shelfName(state, list), chosen))) return;
}

async function shelveFiles(name: string, paths: string[]): Promise<ShelvedChangeList | undefined> {
  const entry = await runOp(tx`Shelve changes “${name}”`, () => call(commands.vcsShelve(name, paths)));
  void loadShelves().catch(() => undefined);
  if (!entry) return undefined;
  notifications().notify({
    group: "vcs",
    level: "info",
    title: `Shelved ${entry.files.length} file${entry.files.length === 1 ? "" : "s"}`,
    body: entry.name,
    actions: [{ label: "Show Shelf", run: showShelf }],
  });
  return entry;
}

/** Files of `node` and everything below it. */
function filesBelow<F>(node: FileTreeNode<F>, out: F[] = []): F[] {
  if (node.file) out.push(node.file);
  for (const child of node.children) filesBelow(child, out);
  return out;
}

/**
 * A checkable tree of changed files under the repository's node, grouped by directory (Shelve,
 * Unshelve, Create Patch), as IDEA's changes tree: a directory's box checks or clears every file
 * below it and shows a dash when only some are included.
 */
function ChangeChecklist<F>({
  files,
  keyOf,
  relPath,
  colorOf,
  detailOf,
  rootName,
  selected,
  onChange,
  label,
  className,
}: {
  files: readonly F[];
  keyOf: (f: F) => string;
  relPath: (f: F) => string;
  colorOf: (f: F) => string | undefined;
  /** Muted text after a file name, e.g. its change kind. */
  detailOf?: (f: F) => string;
  rootName: string;
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  label: string;
  className?: string;
}) {
  const tree: FileTreeNode<F>[] = [
    { key: "r:", name: rootName, file: null, children: buildFileTree(files, relPath), count: files.length },
  ];
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const toggle = (node: FileTreeNode<F>) => {
    const below = filesBelow(node);
    const include = !below.every((f) => selected.has(keyOf(f)));
    const next = new Set(selected);
    for (const f of below) {
      if (include) next.add(keyOf(f));
      else next.delete(keyOf(f));
    }
    onChange(next);
  };
  return (
    <div className={clsx(styles.fileTree, className)}>
      <Tree<FileTreeNode<F>>
        roots={tree}
        getKey={(n) => n.key}
        getLabel={(n) => n.name}
        getChildren={(n) => (n.file ? undefined : n.children)}
        isExpandable={(n) => !n.file}
        expanded={expanded ?? new Set(dirKeys(tree))}
        onExpandedChange={setExpanded}
        onActivate={toggle}
        aria-label={label}
        className={styles.fileTreeView}
        renderNode={(n) => {
          const below = filesBelow(n);
          const on = below.filter((f) => selected.has(keyOf(f))).length;
          const path = n.file ? relPath(n.file) : undefined;
          return (
            <span className={styles.fileTreeRow}>
              <Checkbox
                tabIndex={-1}
                aria-label={tx`Include ${n.name}`}
                checked={on > 0 && on === below.length}
                indeterminate={on > 0 && on < below.length}
                onChange={() => toggle(n)}
              />
              <Icon name={path === undefined ? "folder" : fileIconName(n.name, path)} size={14} />
              <span className={styles.fileName} style={{ color: n.file ? colorOf(n.file) : undefined }} title={path}>
                {n.name}
              </span>
              <span className={styles.fileDir}>{n.file ? (detailOf?.(n.file) ?? "") : fileCount(n.count)}</span>
            </span>
          );
        }}
      />
    </div>
  );
}

/** The checkable tree of working tree changes (Shelve, Create Patch). */
export function FileChecklist({
  files,
  selected,
  onChange,
  label,
  className,
}: {
  files: readonly FileStatus[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  label: string;
  className?: string;
}) {
  const root = useVcs((s) => s.root) ?? "";
  return (
    <ChangeChecklist
      files={files}
      keyOf={(f) => f.path}
      relPath={(f) => relTo(root, stripSlash(f.path))}
      colorOf={(f) => KIND_COLOR[effectiveKind(f) ?? "modified"]}
      rootName={baseName(root)}
      selected={selected}
      onChange={onChange}
      label={label}
      className={className}
    />
  );
}
function ShelveDialog({
  files,
  initialName,
  onClose,
}: {
  files: FileStatus[];
  initialName: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => new Set(files.map((f) => f.path)));
  const [name, setName] = useState(initialName);
  const run = async () => {
    const chosen = files.filter((f) => selected.has(f.path)).map((f) => stripSlash(f.path));
    if (!chosen.length || !name.trim()) return;
    onClose();
    await saveAll();
    await shelveFiles(name.trim(), chosen);
  };
  return (
    <Dialog
      open
      title="Shelve Changes"
      onClose={onClose}
      width={540}
      buttons={[
        {
          label: "Shelve Changes",
          role: "default",
          disabled: !selected.size || !name.trim(),
          onClick: () => void run(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {files.length === 1
          ? tx`${selected.size} of ${files.length} file will be shelved and reverted in the working tree.`
          : tx`${selected.size} of ${files.length} files will be shelved and reverted in the working tree.`}
      </div>
      <FileChecklist files={files} selected={selected} onChange={setSelected} label="Files to shelve" />
      <div className={styles.form}>
        <label className={styles.fieldLabel} htmlFor="openidea-shelf-name">
          <T>Name:</T>
        </label>
        <Input id="openidea-shelf-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
    </Dialog>
  );
}

/** Opens the merge UI for conflicts an apply left, or reports success. */
export async function reportApply(
  outcome: ApplyOutcome,
  what: string,
  repositories?: string[],
  afterRefresh?: () => Promise<void>,
) {
  await refreshNow();
  await afterRefresh?.();
  if (outcome.conflicts.length || (!repositories && conflictedFiles().length)) {
    const resolve = () =>
      repositories ? executeAction("vcs.resolveConflicts", { repositories }) : executeAction("vcs.resolveConflicts");
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: `${what}: ${outcome.conflicts.length} file${outcome.conflicts.length === 1 ? "" : "s"} with conflicts`,
      body: outcome.conflicts.slice(0, 3).join(", "),
      actions: [{ label: "Resolve…", run: () => void resolve() }],
    });
    void resolve();
    return;
  }
  const n = outcome.applied.length;
  notifications().notify({ group: "vcs", level: "info", title: `${what}: ${n} file${n === 1 ? "" : "s"} changed` });
}

export function unshelve(entry: ShelvedChangeList, path?: string) {
  openDialog((close) => <UnshelveDialog entry={entry} path={path} onClose={close} />);
}

/** Applies the shelved `paths` of `entry`: in one go when that is all of it, else file by file. */
async function unshelveFiles(entry: ShelvedChangeList, paths: readonly string[], remove: boolean) {
  if (paths.length === entry.files.length) return call(commands.vcsUnshelve(entry.id, remove, null));
  const outcome: ApplyOutcome = { applied: [], conflicts: [] };
  for (const path of paths) {
    const one = await call(commands.vcsUnshelve(entry.id, remove, path));
    outcome.applied.push(...one.applied);
    outcome.conflicts.push(...one.conflicts);
  }
  return outcome;
}

/** Unshelves `paths` of `entry` into the `target` changelist. */
async function applyShelf(entry: ShelvedChangeList, paths: readonly string[], remove: boolean, target: string) {
  const outcome = await runOp(tx`Unshelve “${entry.name}”`, () => unshelveFiles(entry, paths, remove), {
    refresh: false,
  });
  await refreshNow();
  void loadShelves().catch(() => undefined);
  if (!outcome) return;
  const base = shelfPathBase(entry);
  const rels = [...outcome.applied, ...outcome.conflicts].map((p) => relOf(repositoryPath(base, p)));
  updateChangelists((s) => moveFiles(s, rels, target));
  await reportApply(outcome, `Unshelved “${entry.name}”`);
}

/**
 * IDEA's Unshelve Silently: no dialog; into the changelist named like the shelf, else the active one,
 * removing applied files from the shelf as the Shelf setting says.
 */
export async function unshelveSilently(entry: ShelvedChangeList, path?: string) {
  const paths = path === undefined ? entry.files.map((f) => f.path) : [path];
  if (!paths.length) return;
  const state = useChangelists.getState().state;
  const target = state.lists.find((l) => l.name === entry.name)?.id ?? state.active;
  await saveAll();
  await applyShelf(entry, paths, workflowSettings().vcs.shelf.removeApplied, target);
}

function UnshelveDialog({ entry, path, onClose }: { entry: ShelvedChangeList; path?: string; onClose: () => void }) {
  const lists = useChangelists((s) => s.state);
  const [target, setTarget] = useState(lists.active);
  const [remove, setRemove] = useState(() => workflowSettings().vcs.shelf.removeApplied);
  const base = shelfPathBase(entry);
  const files = useMemo<ChangedFile[]>(() => {
    if (path === undefined) return entry.files;
    const own = entry.files.filter((f) => f.path === path);
    return own.length ? own : [{ path, kind: "modified", oldPath: null }];
  }, [entry, path]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(files.map((f) => f.path)));
  const projectRoot = useVcs((s) => s.root);
  const root = base ?? projectRoot ?? "";
  const run = async () => {
    const chosen = files.filter((f) => selected.has(f.path)).map((f) => f.path);
    if (!chosen.length) return;
    onClose();
    await saveAll();
    await applyShelf(entry, chosen, remove, target);
  };
  return (
    <Dialog
      open
      title="Unshelve Changes"
      onClose={onClose}
      width={560}
      buttons={[
        { label: "Unshelve", role: "default", autoFocus: true, disabled: !selected.size, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>{entry.name}</div>
      <ChangeChecklist
        files={files}
        keyOf={(f) => f.path}
        relPath={(f) => f.path}
        colorOf={(f) => KIND_COLOR[f.kind === "untracked" ? "added" : f.kind]}
        detailOf={(f) => tx(KIND_LABEL[f.kind === "untracked" ? "added" : f.kind])}
        rootName={baseName(root)}
        selected={selected}
        onChange={setSelected}
        label="Files to unshelve"
      />
      <div className={styles.form}>
        <label className={styles.fieldLabel}>
          <T>Changelist:</T>
        </label>
        <Select
          value={target}
          aria-label="Target changelist"
          onChange={setTarget}
          options={lists.lists.map((l) => ({
            value: l.id,
            label: l.id === lists.active ? tx`${l.name} (active)` : l.name,
          }))}
        />
        <Checkbox checked={remove} onChange={setRemove} label="Remove successfully applied files from the shelf" />
      </div>
    </Dialog>
  );
}

export async function deleteShelf(entry: ShelvedChangeList, path?: string) {
  const ok = await confirmDialog({
    title: "Delete Shelved Changes",
    message: tx`Delete “${path ?? entry.name}” from the shelf? This cannot be undone.`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await runOp(tx`Delete shelved changes “${entry.name}”`, () => call(commands.vcsShelfDelete(entry.id, path ?? null)), {
    refresh: false,
  });
  void loadShelves().catch(() => undefined);
}

export async function renameShelf(entry: ShelvedChangeList) {
  const r = await promptText({
    title: "Rename Shelved Changes",
    label: "Name:",
    initial: entry.name,
    okLabel: "Rename",
  });
  if (!r || r.value === entry.name) return;
  await runOp(tx("Rename shelved changes"), () => call(commands.vcsShelfRename(entry.id, r.value)), { refresh: false });
  void loadShelves().catch(() => undefined);
}

export async function copyShelfPatch(entry: ShelvedChangeList, path?: string) {
  try {
    await writeClipboardText(await call(commands.vcsShelfPatch(entry.id, path ?? null, null)));
    notifications().notify({ group: "vcs", level: "info", title: "Patch copied to the clipboard" });
  } catch (e) {
    logConsole("err", errorMessage(e));
  }
}

// ---------------------------------------------------------------------------

interface ShelfNode {
  key: string;
  entry: ShelvedChangeList;
  file?: ShelvedChangeList["files"][number];
}

export interface ShelfTarget {
  id: string;
  path?: string;
}

export function shelfTarget(arg?: unknown): { entry: ShelvedChangeList; path?: string } | null {
  const key = typeof arg === "string" ? arg : useCommit.getState().selectedShelf;
  const target =
    arg && typeof arg === "object" && "id" in arg
      ? (arg as ShelfTarget)
      : key
        ? { id: key.split("\u0000")[0]!, path: key.split("\u0000")[1] }
        : null;
  const entry = useShelf.getState().shelves.find((s) => s.id === target?.id);
  if (!entry || (target?.path && !entry.files.some((f) => f.path === target.path))) return null;
  return { entry, path: target?.path };
}

/** Legacy shelves were created in the primary repository, regardless of the selected one. */
function shelfPathBase(entry?: ShelvedChangeList): string | null {
  const state = useVcs.getState();
  return entry?.repo ?? state.roots[0] ?? state.root;
}

export function shelfDiffs(target: ShelfTarget, local = false): DiffData[] {
  const state = useShelf.getState();
  const root = shelfPathBase(state.shelves.find((entry) => entry.id === target.id));
  if (!root) return [];
  return (state.diffs[target.id] ?? [])
    .filter((f) => (!target.path || f.path === target.path) && f.before !== null && f.after !== null)
    .map((f) => ({
      path: repositoryPath(root, f.path),
      left: {
        type: "text",
        text: (local ? f.after : f.before)!,
        label: tx(local ? "Shelved version" : "Shelved base"),
      },
      right: local
        ? { type: "worktree", label: tx("Local version") }
        : { type: "text", text: f.after!, label: tx("Shelved version") },
      context: { kind: "vcs.shelf", id: target.id, path: f.path },
    }));
}

export async function showShelfDiff(arg?: unknown, local = false, newTab = false) {
  const target = shelfTarget(arg);
  if (!target) return;
  if (!useShelf.getState().diffs[target.entry.id]) {
    const root = useVcs.getState().root;
    const files = await call(commands.vcsShelfDiff(target.entry.id));
    if (useVcs.getState().root !== root) return;
    useShelf.setState((s) => ({ diffs: { ...s.diffs, [target.entry.id]: files } }));
  }
  let items = shelfDiffs({ id: target.entry.id, path: target.path }, local);
  if (local) {
    const supported = await Promise.all(
      items.map(async (d) => {
        try {
          const probe = await call(commands.fsProbe(d.path));
          return !probe.binary;
        } catch {
          return false;
        }
      }),
    );
    items = items.filter((_, i) => supported[i]);
  }
  if (!items.length) return;
  // "Show Diff in a New Tab" asks for an editor tab whatever the commit interface.
  if (newTab) await openDiff(withChain(items, 0), { preview: false });
  else await openVcsDiff(withChain(items, 0), { preview: true });
}

export async function importShelfPatches(paths?: string[]) {
  const repo = currentRepo();
  const picked =
    paths ??
    (await import("@/platform/dialog").then(({ open }) =>
      open({ multiple: true, directory: false, filters: [{ name: "Patch", extensions: ["patch", "diff"] }] }),
    ));
  if (!picked) return;
  for (const path of typeof picked === "string" ? [picked] : picked) {
    await runOp(
      tx("Import patches"),
      async () => call(commands.vcsShelfImport(repo, baseName(path), await call(commands.fsReadText(path)))),
      { refresh: false },
    );
  }
  await loadShelves();
}

function shelfMenu(node: ShelfNode, canCompare: boolean) {
  const target: ShelfTarget = { id: node.entry.id, path: node.file?.path };
  const available =
    node.entry.files.length > 0 && (!node.file || node.entry.files.some((f) => f.path === node.file?.path));
  const canDiff = shelfDiffs(target).length > 0;
  const action = (id: string) => () => void executeAction(id, target);
  return [
    { label: "Unshelve…", icon: "unshelve", disabled: !available, run: action("vcs.unshelve") },
    { kind: "separator" as const },
    {
      label: "Show Diff",
      icon: "diff",
      shortcut: shortcutLabel("vcs.showDiff"),
      disabled: !canDiff,
      run: action("vcs.shelf.showDiff"),
    },
    { label: "Show Diff in a New Tab", disabled: !canDiff, run: action("vcs.shelf.showDiffNewTab") },
    { label: "Compare with Local", disabled: !canCompare, run: action("vcs.shelf.compareLocal") },
    { kind: "separator" as const },
    { label: "Create Patch…", icon: "file-patch", disabled: !available, run: action("vcs.shelf.createPatch") },
    { label: "Copy as Patch to Clipboard", icon: "copy", disabled: !available, run: action("vcs.shelf.copyPatch") },
    { label: "Import Patches…", run: action("vcs.shelf.importPatches") },
    { kind: "separator" as const },
    { label: "Rename…", disabled: !!node.file, run: action("vcs.shelf.rename") },
    { label: "Delete…", icon: "trash", danger: true, disabled: !available, run: action("vcs.shelf.delete") },
  ];
}

export function createShelfPatch(arg?: unknown) {
  const target = shelfTarget(arg);
  if (target) showCreatePatchForShelf(target.entry, target.path);
}

function ShelfTree({
  nodes,
  kind,
  selectedKey,
  empty,
}: {
  nodes: ShelfNode[];
  kind: "changes" | "files";
  selectedKey: string | null;
  empty: string;
}) {
  const selected = useMemo(() => new Set(selectedKey ? [selectedKey] : []), [selectedKey]);
  const filePane = kind === "files";
  return (
    <Tree<ShelfNode>
      roots={nodes}
      getKey={(n) => n.key}
      getLabel={(n) => (n.file ? baseName(n.file.path) : n.entry.name)}
      getChildren={() => undefined}
      isExpandable={() => false}
      selected={selected}
      onSelectionChange={(sel) => useCommit.setState({ selectedShelf: [...sel][0] ?? null })}
      horizontalScroll={filePane}
      rowHeight={filePane ? 40 : undefined}
      multiSelect={false}
      onActivate={(n) => {
        void executeAction(n.file ? "vcs.shelf.showDiff" : "vcs.unshelve", { id: n.entry.id, path: n.file?.path });
      }}
      onContextMenu={(node, _sel, e: MouseEvent) => {
        if (!node) return;
        e.preventDefault();
        useCommit.setState({ selectedShelf: node.key });
        const point = { x: e.clientX, y: e.clientY };
        const target = { id: node.entry.id, path: node.file?.path };
        void Promise.all(
          shelfDiffs(target, true).map(async (d) => {
            try {
              return !(await call(commands.fsProbe(d.path))).binary;
            } catch {
              return false;
            }
          }),
        ).then((supported) => showContextMenu(point, shelfMenu(node, supported.some(Boolean))));
      }}
      aria-label={filePane ? "Shelved files" : "Shelved changes"}
      empty={<span className={viewStyles.empty}>{tx(empty)}</span>}
      renderNode={(n) => {
        const file = n.file;
        if (file) {
          const directory = dirName(file.path);
          return (
            <>
              <Icon name={fileIconName(baseName(file.path), file.path)} size={16} className={viewStyles.icon} />
              <span className={shelfStyles.fileText} title={file.path}>
                <span style={{ color: KIND_COLOR[file.kind === "untracked" ? "added" : file.kind] }}>
                  {baseName(file.path)}
                </span>
                {directory && <span className={shelfStyles.detail}>{directory}</span>}
              </span>
            </>
          );
        }
        const time = n.entry.timeMs ? formatTime(n.entry.timeMs) : null;
        return (
          <>
            <Icon name="shelve" size={16} className={viewStyles.icon} />
            <span className={shelfStyles.patchName} title={n.entry.name}>
              {n.entry.name}
            </span>
            <span className={shelfStyles.detail}>{fileCount(n.entry.files.length)}</span>
            {time && (
              <span className={shelfStyles.date} title={time}>
                {time}
              </span>
            )}
          </>
        );
      }}
    />
  );
}

/** The Shelf tab of the Commit tool window. */
export function ShelfPanel() {
  const shelves = useShelf((s) => s.shelves);
  const loaded = useShelf((s) => s.loaded);
  const root = useVcs((s) => s.root);
  const selectedShelf = useCommit((s) => s.selectedShelf);
  const panelRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(true);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => setStacked(panel.clientWidth < 560);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    void loadShelves().catch(() => undefined);
    return () => setContext("shelfFocus", false);
  }, [root]);
  const selectedId = selectedShelf?.split("\u0000", 1)[0];
  const entry = shelves.find((s) => s.id === selectedId);
  const patches = useMemo<ShelfNode[]>(() => shelves.map((s) => ({ key: s.id, entry: s })), [shelves]);
  const files = useMemo<ShelfNode[]>(
    () => entry?.files.map((file) => ({ key: `${entry.id}\u0000${file.path}`, entry, file })) ?? [],
    [entry],
  );
  const current = selectedShelf ? shelfTarget(selectedShelf) : null;
  const patchTree = (
    <ShelfTree
      nodes={patches}
      kind="changes"
      selectedKey={entry?.id ?? null}
      empty={loaded ? "No shelved changes" : "Loading…"}
    />
  );
  return (
    <div
      className={viewStyles.changes}
      ref={panelRef}
      data-shelf-panel
      onFocusCapture={() => setContext("shelfFocus", true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("shelfFocus", false);
      }}
    >
      <div className={viewStyles.toolbar} role="toolbar" aria-label={tx("Shelf")}>
        <IconButton icon="refresh" action="vcs.shelf.refresh" size="small" />
        <IconButton icon="shelve" action="vcs.shelve" size="small" />
        <span className={viewStyles.sep} />
        <IconButton
          icon="unshelve"
          title="Unshelve…"
          size="small"
          disabled={!current}
          onClick={() => current && void executeAction("vcs.unshelve", { id: current.entry.id, path: current.path })}
        />
        <IconButton
          icon="trash"
          title="Delete"
          size="small"
          disabled={!current}
          onClick={() =>
            current && void executeAction("vcs.shelf.delete", { id: current.entry.id, path: current.path })
          }
        />
      </div>
      {patches.length ? (
        <SplitGroup
          id="shelf-panes"
          className={shelfStyles.split}
          orientation={stacked ? "vertical" : "horizontal"}
          storageKey={`openidea.vcs.shelf.layout.${stacked ? "stacked" : "sideBySide"}`}
        >
          <SplitPanel id="shelf-changes" defaultSize="50%" minSize="25%">
            {patchTree}
          </SplitPanel>
          <SplitHandle aria-label={tx("Resize shelf panes")} />
          <SplitPanel id="shelf-files" defaultSize="50%" minSize="25%">
            <div className={shelfStyles.filesHeader}>
              <T>Shelved files</T>
            </div>
            <ShelfTree
              nodes={files}
              kind="files"
              selectedKey={current?.path ? selectedShelf : null}
              empty={entry ? "No files" : "Select a shelf to view its files"}
            />
          </SplitPanel>
        </SplitGroup>
      ) : (
        <div className={viewStyles.treeWrap}>{patchTree}</div>
      )}
    </div>
  );
}
