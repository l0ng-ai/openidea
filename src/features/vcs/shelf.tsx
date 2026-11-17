/**
 * Shelf: Shelve Changes… (named patch under `.openidea/shelf`, changes reverted),
 * the Shelf tab of the Commit tool window, Unshelve (3-way, conflicts go to the
 * merge UI), rename and delete.
 */
import { writeClipboardText } from "@/platform/clipboard";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { create } from "zustand";
import type { ApplyOutcome, ChangedFile, FileStatus, ShelvedChangeList, ShelfDiffFile } from "@/bindings";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { openDiff, openVcsDiff, withChain, type DiffData } from "./diffInput";
import { showCreatePatchForShelf } from "./patches";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { Checkbox, Dialog, Icon, IconButton, Input, Select, Tree, fileIconName, showContextMenu, T } from "@/ui";
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

export function shelveChanges(paths?: readonly string[]) {
  const files = defaultChangeFiles(paths);
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to shelve" });
    return;
  }
  const state = useChangelists.getState().state;
  const name = state.lists.length > 1 ? activeList(state).name : "Uncommitted changes";
  openDialog((close) => <ShelveDialog files={files} initialName={name} onClose={close} />);
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
    <div className={styles.fileTree}>
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
          return (
            <span className={styles.fileTreeRow}>
              <Checkbox
                tabIndex={-1}
                aria-label={tx`Include ${n.name}`}
                checked={on > 0 && on === below.length}
                indeterminate={on > 0 && on < below.length}
                onChange={() => toggle(n)}
              />
              <Icon name={n.file ? fileIconName(n.name, relPath(n.file)) : "folder"} size={14} />
              <span className={styles.fileName} style={{ color: n.file ? colorOf(n.file) : undefined }}>
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
}: {
  files: readonly FileStatus[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  label: string;
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
    const entry = await runOp(tx`Shelve changes “${name.trim()}”`, () => call(commands.vcsShelve(name.trim(), chosen)));
    if (!entry) return;
    void loadShelves().catch(() => undefined);
    notifications().notify({
      group: "vcs",
      level: "info",
      title: `Shelved ${entry.files.length} file${entry.files.length === 1 ? "" : "s"}`,
      body: entry.name,
      actions: [{ label: "Show Shelf", run: showShelf }],
    });
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
export async function reportApply(outcome: ApplyOutcome, what: string) {
  await refreshNow();
  if (outcome.conflicts.length || conflictedFiles().length) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: `${what}: ${outcome.conflicts.length} file${outcome.conflicts.length === 1 ? "" : "s"} with conflicts`,
      body: outcome.conflicts.slice(0, 3).join(", "),
      actions: [{ label: "Resolve…", run: () => void executeAction("vcs.resolveConflicts") }],
    });
    void executeAction("vcs.resolveConflicts");
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

function UnshelveDialog({ entry, path, onClose }: { entry: ShelvedChangeList; path?: string; onClose: () => void }) {
  const lists = useChangelists((s) => s.state);
  const [target, setTarget] = useState(lists.active);
  const [remove, setRemove] = useState(() => workflowSettings().vcs.shelf.removeApplied);
  const repo = shelfRepository(entry);
  const files = useMemo<ChangedFile[]>(() => {
    if (path === undefined) return entry.files;
    const own = entry.files.filter((f) => f.path === path);
    return own.length ? own : [{ path, kind: "modified", oldPath: null }];
  }, [entry, path]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(files.map((f) => f.path)));
  const projectRoot = useVcs((s) => s.root);
  const root = repo ?? projectRoot ?? "";
  const run = async () => {
    const chosen = files.filter((f) => selected.has(f.path)).map((f) => f.path);
    if (!chosen.length) return;
    onClose();
    await saveAll();
    const outcome = await runOp(tx`Unshelve “${entry.name}”`, () => unshelveFiles(entry, chosen, remove), {
      refresh: false,
    });
    if (!outcome) return;
    await refreshNow();
    const rels = [...outcome.applied, ...outcome.conflicts].map((p) => relOf(repositoryPath(repo, p)));
    updateChangelists((s) => moveFiles(s, rels, target));
    void loadShelves().catch(() => undefined);
    await reportApply(outcome, `Unshelved “${entry.name}”`);
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
    await writeClipboardText(await call(commands.vcsShelfPatch(entry.id, path ?? null)));
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
  children?: ShelfNode[];
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
function shelfRepository(entry?: ShelvedChangeList): string | null {
  const state = useVcs.getState();
  return entry?.repo ?? state.roots[0] ?? state.root;
}

export function shelfDiffs(target: ShelfTarget, local = false): DiffData[] {
  const state = useShelf.getState();
  const root = shelfRepository(state.shelves.find((entry) => entry.id === target.id));
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

/** The Shelf tab of the Commit tool window. */
export function ShelfPanel() {
  const shelves = useShelf((s) => s.shelves);
  const loaded = useShelf((s) => s.loaded);
  const root = useVcs((s) => s.root);
  useShelf((s) => s.diffs);
  const selectedShelf = useCommit((s) => s.selectedShelf);
  const selected = useMemo(() => new Set(selectedShelf ? [selectedShelf] : []), [selectedShelf]);
  useEffect(() => {
    void loadShelves().catch(() => undefined);
    return () => setContext("shelfFocus", false);
  }, [root]);
  const roots = useMemo<ShelfNode[]>(
    () =>
      shelves.map((entry) => ({
        key: entry.id,
        entry,
        children: entry.files.map((file) => ({ key: `${entry.id}\u0000${file.path}`, entry, file })),
      })),
    [shelves],
  );
  const current = shelfTarget([...selected][0]);
  return (
    <div
      className={viewStyles.changes}
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
      <div className={viewStyles.treeWrap}>
        <Tree<ShelfNode>
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) => (n.file ? baseName(n.file.path) : n.entry.name)}
          getChildren={(n) => n.children}
          isExpandable={(n) => !n.file}
          selected={selected}
          onSelectionChange={(sel) => {
            const key = [...sel][0];
            useCommit.setState({ selectedShelf: key ?? null });
          }}
          multiSelect={false}
          onActivate={(n) => {
            void executeAction(n.file ? "vcs.shelf.showDiff" : "vcs.unshelve", { id: n.entry.id, path: n.file?.path });
          }}
          onContextMenu={(node, _sel, e: MouseEvent) => {
            if (!node) return;
            e.preventDefault();
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
          aria-label="Shelved changes"
          empty={<span className={viewStyles.empty}>{loaded ? tx("No shelved changes") : tx("Loading…")}</span>}
          renderNode={(n) =>
            n.file ? (
              <>
                <Icon name={fileIconName(baseName(n.file.path), n.file.path)} size={16} className={viewStyles.icon} />
                <span
                  className={viewStyles.label}
                  style={{ color: KIND_COLOR[n.file.kind === "untracked" ? "added" : n.file.kind] }}
                >
                  {baseName(n.file.path)}
                </span>
                <span className={viewStyles.detail}>{dirName(n.file.path)}</span>
              </>
            ) : (
              <>
                <Icon name="shelve" size={16} className={viewStyles.icon} />
                <span className={viewStyles.label}>{n.entry.name}</span>
                <span className={viewStyles.detail}>
                  {fileCount(n.entry.files.length)}
                  {n.entry.timeMs ? ` · ${formatTime(n.entry.timeMs)}` : ""}
                </span>
              </>
            )
          }
        />
      </div>
    </div>
  );
}
