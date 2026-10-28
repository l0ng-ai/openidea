/**
 * File operations behind the project view's actions: new / rename / delete,
 * internal copy-cut-paste, drag & drop moves and OS file imports.
 */
import { createElement, Fragment } from "react";
import { askUsagesDetected, fileUsages, viewUsages } from "@/editor/refactor";
import { executeAction, getAction } from "@/platform/actions";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { ask, confirmChecked } from "@/workbench/messages";
import { osClipboard } from "./clipboard";
import { runFileRefactoring } from "./fileRefactor";
import { openFileRefactorDialog, rememberedOptions } from "./FileRefactorDialogs";
import { projectFs } from "./fs";
import type { ProjectNode } from "./model";
import {
  isInside,
  isSameOrInside,
  joinPath,
  nameOf,
  packageSegments,
  parentOf,
  relativeTo,
  uniqueName,
  validateName,
  type PackageKind,
} from "./paths";
import {
  currentModel,
  type Editing,
  isFilteredMode,
  isReadOnlyPath,
  loadDir,
  revealPath,
  setClipboard,
  setExpanded,
  setViewMode,
  startEditing,
  useProjectTree,
} from "./store";
import { tx } from "@/platform/i18n";

/** Nodes that may be renamed, moved or deleted (not roots, groups or library sources). */
const mutable = (n: ProjectNode) => !n.root && !n.placeholder && !n.readOnly;

const get = () => useProjectTree.getState();

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isWindows = /Win/i.test(ua);
/** macOS and Windows file systems are case-insensitive by default. */
const caseInsensitive = /Mac|Win/i.test(ua);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(title: string, e: unknown) {
  notifications().notify({ level: "error", title, body: errorMessage(e) });
}

// ---------------------------------------------------------------------------
// Selection helpers

/** Selected nodes in tree order (placeholders excluded). */
export function selectedNodes(): ProjectNode[] {
  const { selected } = get();
  const model = currentModel();
  const out: ProjectNode[] = [];
  for (const key of selected) {
    const n = model.byKey.get(key);
    if (n && !n.placeholder) out.push(n);
  }
  return out;
}

export function leadNode(): ProjectNode | null {
  const { lead } = get();
  const model = currentModel();
  const n = lead ? model.byKey.get(lead) : undefined;
  if (n && !n.placeholder) return n;
  return selectedNodes()[0] ?? null;
}

/** Selected paths without entries nested in other selected folders. */
export function topLevelPaths(nodes: ProjectNode[] = selectedNodes()): string[] {
  const paths = nodes.map((n) => n.path);
  return paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)));
}

/** Folder that receives new / pasted items: the selected folder or the selected file's parent. */
export function targetFolder(node: ProjectNode | null = leadNode()): string | null {
  const { root } = get();
  if (!root) return null;
  if (!node) return root;
  return node.dir ? node.path : parentOf(node.path);
}

function siblingsOf(dir: string): string[] {
  return (get().listings.get(dir) ?? []).map((e) => e.name);
}

function expandFolder(path: string) {
  const model = currentModel();
  const key = model.keyOfPath.get(path) ?? path;
  const { expanded } = get();
  if (expanded.has(key) && expanded.has(path)) return;
  setExpanded(new Set(expanded).add(key).add(path));
}

// ---------------------------------------------------------------------------
// Open

export async function openFile(path: string, opts: { preview?: boolean; focus?: boolean } = {}) {
  const editor = maybeEditorService();
  if (!editor) {
    notifications().notify({ level: "warning", title: "No editor available", body: path, key: "project.noEditor" });
    return;
  }
  try {
    await editor.openFile(path, { preview: opts.preview, focus: opts.focus ?? true });
  } catch (e) {
    fail(`Cannot open ${nameOf(path)}`, e);
  }
}

export function openSelection() {
  for (const n of selectedNodes()) if (!n.dir) void openFile(n.path);
}

// ---------------------------------------------------------------------------
// New / rename

export async function beginNew(nodeKind: "file" | "dir", parent = targetFolder(), pkg?: PackageKind) {
  if (!parent || isReadOnlyPath(parent)) return;
  // The inline editor needs the folder's listing: the filtered panes show none.
  if (isFilteredMode(get().mode)) setViewMode("project");
  expandFolder(parent);
  await loadDir(parent);
  startEditing(pkg ? { kind: "new", parent, nodeKind: "dir", pkg } : { kind: "new", parent, nodeKind });
}

/** New › Package / Python Package: a dotted name creates nested folders. */
export function beginNewPackage(kind: PackageKind, parent = targetFolder()) {
  return beginNew("dir", parent, kind);
}

/** Folder path (below the parent) the inline editor's text creates. */
function newRelPath(editing: Extract<Editing, { kind: "new" }>, name: string): string | null {
  if (!editing.pkg) return name;
  return packageSegments(name, editing.pkg).segments?.join("/") ?? null;
}

export function beginRename(node: ProjectNode | null = leadNode()) {
  if (!node || !mutable(node)) return;
  startEditing({ kind: "rename", key: node.key, path: node.path });
}

/** Rename… (⇧F6): IDEA's Rename dialog, updating references. */
export async function openRenameDialog(node: ProjectNode | null = leadNode()) {
  if (!node || !mutable(node)) return;
  const parent = parentOf(node.path);
  await loadDir(parent);
  openFileRefactorDialog({
    kind: "rename",
    path: node.path,
    dir: node.dir,
    siblings: siblingsOf(parent),
    onDone: (moves) => void afterMove(moves),
  });
}

/** Move… (F6): IDEA's Move dialog for the selection, defaulting to `target` or the current folder. */
export function openMoveDialog(nodes: ProjectNode[] = selectedNodes(), target?: string) {
  const movable = nodes.filter(mutable);
  const paths = topLevelPaths(movable);
  openMoveDialogFor(paths, target, paths.length === 1 && movable.some((n) => n.path === paths[0] && n.dir));
}

/** Copy… (F5): IDEA's Copy dialog for the selection, into the folder it is in. */
export function openCopyDialog(nodes: ProjectNode[] = selectedNodes()) {
  const copyable = nodes.filter((n) => !n.root && !n.group);
  const paths = topLevelPaths(copyable);
  if (!paths.length) return;
  const single = paths.length === 1 && copyable.some((n) => n.path === paths[0] && n.dir);
  openCopyDialogFor(paths, parentOf(paths[0]!), single);
}

function openMoveDialogFor(paths: string[], target?: string, dir?: boolean, done?: () => void) {
  if (!paths.length) return;
  openFileRefactorDialog({
    kind: "move",
    paths,
    dir,
    target: target ?? parentOf(paths[0]!),
    onDone: (moves) => {
      done?.();
      void afterMove(moves);
      if (rememberedOptions("move").openInEditor)
        for (const m of moves) if (!get().listings.has(m.to)) void openFile(m.to, { focus: false });
    },
  });
}

/** Refreshes the folders a move touched and selects the moved items. */
async function afterMove(moves: { from: string; to: string }[]) {
  const dirs = new Set(moves.flatMap((m) => [parentOf(m.from), parentOf(m.to)]));
  await Promise.all([...dirs].map((d) => loadDir(d, true)));
  const first = moves[0];
  if (first) {
    expandFolder(parentOf(first.to));
    revealPath(first.to, true);
  }
}

export function cancelEditing() {
  startEditing(null);
}

/** Validates the inline editor's text against the target folder. */
export function checkEditingName(name: string) {
  const { editing } = get();
  if (!editing) return { error: null };
  if (editing.kind === "new" && editing.pkg) {
    const { segments, error } = packageSegments(name, editing.pkg);
    if (!segments) return { error };
    return validateName(segments.join("/"), {
      siblings: siblingsOf(editing.parent),
      allowNested: true,
      caseInsensitive,
      windows: isWindows,
    });
  }
  if (editing.kind === "new")
    return validateName(name, {
      siblings: siblingsOf(editing.parent),
      allowNested: true,
      caseInsensitive,
      windows: isWindows,
    });
  return validateName(name, {
    siblings: siblingsOf(parentOf(editing.path)),
    current: nameOf(editing.path),
    caseInsensitive,
    windows: isWindows,
  });
}

/** Commits the inline editor. Resolves false when the name was rejected (editor stays open). */
export async function commitEditing(name: string): Promise<boolean> {
  const { editing, root } = get();
  if (!editing || !root) return true;
  const check = checkEditingName(name);
  if (check.error) return false;
  const fs = projectFs(root);
  if (editing.kind === "new") {
    const path = joinPath(editing.parent, newRelPath(editing, name) ?? name);
    startEditing(null);
    try {
      if (editing.nodeKind === "file") await fs.createFile(path);
      else await fs.createDir(path);
      // Every folder of a Python package gets an `__init__.py`, as in PyCharm.
      if (editing.pkg === "python")
        for (let dir = path; isInside(dir, editing.parent) && dir !== editing.parent; dir = parentOf(dir))
          // An existing intermediate package keeps its own `__init__.py`.
          await fs.createFile(joinPath(dir, "__init__.py")).catch(() => {});
    } catch (e) {
      fail(editing.nodeKind === "file" ? "Cannot create file" : "Cannot create folder", e);
      return true;
    }
    await refreshAfterCreate(editing.parent, path);
    revealPath(path, true);
    if (editing.nodeKind === "file") void openFile(path, { focus: true });
    return true;
  }
  const to = joinPath(parentOf(editing.path), name);
  startEditing(null);
  if (to === editing.path) return true;
  const status = await runFileRefactoring([{ from: editing.path, to }], rememberedOptions("rename"), "Rename");
  if (status !== "done") return true;
  await loadDir(parentOf(to), true);
  revealPath(to, true);
  return true;
}

/** Reloads the folders a (possibly nested `a/b/c`) creation touched. */
async function refreshAfterCreate(parent: string, path: string) {
  const dirs = [parent];
  for (let p = parentOf(path); isInside(p, parent); p = parentOf(p)) dirs.push(p);
  for (const d of dirs) await loadDir(d, true);
}

// ---------------------------------------------------------------------------
// Delete

function describe(paths: string[]): string {
  return paths.length === 1 ? `'${nameOf(paths[0]!)}'` : `${paths.length} items`;
}

/** Visible rows in display order (roots, then children of expanded folders). */
function visibleNodes(): ProjectNode[] {
  const model = currentModel();
  const { expanded } = get();
  const out: ProjectNode[] = [];
  const walk = (list: readonly ProjectNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.dir && expanded.has(n.key)) walk(model.children.get(n.key) ?? []);
    }
  };
  walk(model.roots);
  return out;
}

/** IDEA keeps a selection after Delete: the next surviving row, else the previous one. */
export function selectionAfterDelete(rows: readonly ProjectNode[], deleted: readonly string[]): string | null {
  const gone = (n: ProjectNode) => n.placeholder || deleted.some((d) => isSameOrInside(n.path, d));
  let last = -1;
  rows.forEach((n, i) => {
    if (deleted.includes(n.path)) last = i;
  });
  if (last < 0) return null;
  for (let i = last + 1; i < rows.length; i++) if (!gone(rows[i]!)) return rows[i]!.path;
  for (let i = last - 1; i >= 0; i--) if (!gone(rows[i]!)) return rows[i]!.path;
  return null;
}

/** Safe delete searches at most this many files, for at most this long. */
const SAFE_DELETE_MAX_FILES = 20;
const SAFE_DELETE_TIMEOUT_MS = 15_000;
const SAFE_DELETE_PROGRESS_DELAY_MS = 400;
const SAFE_DELETE_KEY = "openidea.projectTree.safeDelete";

function safeDeleteEnabled(): boolean {
  try {
    return localStorage.getItem(SAFE_DELETE_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * IDEA's safe delete for files: usages of their top-level symbols from other
 * files (where the language server can tell) → "Usages Detected". True to go
 * on deleting; without usage support the plain confirmation stands.
 */
export async function safeToDelete(files: string[]): Promise<boolean> {
  if (files.length > SAFE_DELETE_MAX_FILES) return true;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAFE_DELETE_TIMEOUT_MS);
  // A search that takes a while shows progress the user can skip (delete anyway) or cancel.
  const progress = new AbortController();
  const user: { choice: "skip" | "cancel" | null } = { choice: null };
  const shown = setTimeout(() => {
    void ask({
      title: "Delete",
      body: "Looking for usages…",
      icon: "info",
      buttons: [{ id: "skip", label: "Delete Without Search" }],
      signal: progress.signal,
    }).then((r) => {
      if (r.button === "dismissed") return;
      user.choice = r.button === "skip" ? "skip" : "cancel";
      abort.abort();
    });
  }, SAFE_DELETE_PROGRESS_DELAY_MS);
  let result;
  try {
    result = await fileUsages(files, abort.signal);
  } catch {
    if (user.choice) return user.choice === "skip";
    notifications().notify({
      level: "warning",
      title: "Usage search did not finish; nothing was deleted",
      key: "project.safeDelete",
    });
    return false;
  } finally {
    clearTimeout(timer);
    clearTimeout(shown);
    progress.abort();
  }
  if (user.choice) return user.choice === "skip";
  if (result.status !== "ok" || !result.usages.length) return true;
  const name = files.length === 1 ? nameOf(files[0]!) : `${files.length} files`;
  const subject = files.length === 1 ? tx`File '${name}'` : tx`The ${files.length} files`;
  const answer = await askUsagesDetected(subject, result.usages, files.length > 1);
  if (answer === "view") viewUsages(name, result.usages);
  return answer === "delete";
}

/** Find Usages (⌥F7) on a file: usages of its top-level symbols from other files. */
export async function findFileUsages(path: string) {
  const name = nameOf(path);
  let result;
  try {
    result = await fileUsages([path]);
  } catch (e) {
    fail(`Cannot find usages of '${name}'`, e);
    return;
  }
  if (result.status !== "ok")
    notifications().notify({
      level: "info",
      title: `Cannot find usages of '${name}'`,
      body: result.reason,
      group: "search",
    });
  else if (!result.usages.length)
    notifications().notify({ level: "info", title: `No usages of '${name}' found`, group: "search" });
  else viewUsages(name, result.usages);
}

/** Reload from Disk: re-reads the selected folders (and the folders of selected files) and their open documents. */
export async function reloadFromDisk(nodes: ProjectNode[] = selectedNodes()) {
  const targets = nodes.filter((n) => !n.placeholder);
  if (!targets.length) return;
  const dirs = new Set(targets.map((n) => (n.dir ? n.path : parentOf(n.path))));
  const loaded = [...get().listings.keys()].filter((p) => [...dirs].some((d) => isSameOrInside(p, d)));
  await Promise.all(loaded.map((p) => loadDir(p, true)));
  const files = targets.filter((n) => !n.dir).map((n) => n.path);
  if (files.length) delegate("file.reloadFromDisk", files);
}

export async function deleteSelection(nodes: ProjectNode[] = selectedNodes()) {
  const { root } = get();
  const paths = topLevelPaths(nodes.filter(mutable));
  if (!root || !paths.length) return;
  // Invoked from the tree (or its context menu): give the tree its focus back afterwards.
  const refocus = typeof document !== "undefined" && !!document.activeElement?.closest('[role="tree"], [role="menu"]');
  const folders = nodes.filter((n) => n.dir && paths.includes(n.path)).length;
  const files = nodes.filter((n) => !n.dir && paths.includes(n.path)).map((n) => n.path);
  // IDEA's Delete dialog: "Safe delete (with usage search)", remembered.
  const searchable = files.length > 0 && files.length <= SAFE_DELETE_MAX_FILES;
  const answer = await confirmChecked({
    title: "Delete",
    ok: "Delete",
    checkbox: searchable ? "Safe delete (with usage search)" : undefined,
    checked: searchable && safeDeleteEnabled(),
    message: createElement(
      Fragment,
      null,
      `Delete ${describe(paths)}${folders ? (paths.length === 1 ? " and its contents" : " (including folder contents)") : ""}?`,
      createElement("br"),
      "Items are moved to the Trash.",
    ),
  });
  if (!answer) return;
  if (searchable) {
    try {
      localStorage.setItem(SAFE_DELETE_KEY, String(answer.checked));
    } catch {
      /* storage unavailable */
    }
  }
  if (searchable && answer.checked && !(await safeToDelete(files))) return;
  const next = selectionAfterDelete(visibleNodes(), paths);
  const fs = projectFs(root);
  const parents = new Set<string>();
  const errors: string[] = [];
  for (const p of paths) {
    try {
      await fs.delete(p);
      parents.add(parentOf(p));
    } catch (e) {
      errors.push(`${nameOf(p)}: ${errorMessage(e)}`);
    }
  }
  if (errors.length)
    notifications().notify({ level: "error", title: "Some items could not be deleted", body: errors.join("\n") });
  await Promise.all([...parents].map((d) => loadDir(d, true)));
  if (next) revealPath(next, refocus);
}

// ---------------------------------------------------------------------------
// Clipboard / move / copy

export function copySelection(cut: boolean) {
  const paths = topLevelPaths(selectedNodes().filter((n) => (cut ? mutable(n) : !n.root && !n.group)));
  if (!paths.length) return;
  setClipboard({ paths, cut });
  // Hand the files to the OS too, so Explorer can paste them (as IDEA does).
  void osClipboard().setFiles(paths);
}

/** Files on the OS clipboard, cached: `canPaste` runs while a menu renders. */
let osHasFiles = false;

/** Keeps Paste enabled for what Explorer copied; called when the window gains focus. */
export async function refreshOsClipboard() {
  osHasFiles = await osClipboard().hasFiles();
}

export function canPaste(): boolean {
  return !!get().clipboard?.paths.length || osHasFiles;
}

/**
 * Paste: cut items go through the Move dialog, copied ones through the Copy
 * dialog (IDEA). Files copied in Explorer paste as copies.
 */
export async function paste(target = targetFolder()) {
  const { clipboard } = get();
  if (!target || isReadOnlyPath(target)) return;
  const external = await osClipboard().files();
  // The last copy is the one the user expects to paste, so another app's files
  // win over ours — unless they are the copy we handed to the OS ourselves.
  if (external.length && !sameFiles(external, clipboard?.paths)) return pasteFromOsClipboard(external, target);
  if (!clipboard?.paths.length) return;
  const isDir = (p: string) =>
    get().listings.has(p) || currentModel().byKey.get(currentModel().keyOfPath.get(p) ?? p)?.dir === true;
  const single = clipboard.paths.length === 1 && isDir(clipboard.paths[0]!);
  if (!clipboard.cut) return openCopyDialogFor(clipboard.paths, target, single);
  const paths = clipboard.paths.filter((p) => parentOf(p) !== target);
  if (!paths.length) return;
  openMoveDialogFor(paths, target, single, () => {
    if (get().clipboard === clipboard) setClipboard(null);
  });
}

/** Pasting from Explorer copies, whatever the source: never a move or a refactoring. */
async function pasteFromOsClipboard(paths: string[], target: string) {
  osHasFiles = true;
  await transfer(paths, target, "copy");
}

/** The same files, as the clipboard keeps them (`/`-separated, any order). */
function sameFiles(files: string[], paths: string[] | undefined): boolean {
  if (!paths || files.length !== paths.length) return false;
  const key = (list: string[]) =>
    list
      .map((p) => (caseInsensitive ? p.toLowerCase() : p))
      .sort()
      .join("\n");
  return key(files) === key(paths);
}

function openCopyDialogFor(paths: string[], target: string, dir?: boolean) {
  if (!paths.length) return;
  void loadDir(target);
  openFileRefactorDialog({
    kind: "copy",
    paths,
    target,
    dir,
    copy: async (to, name, openInEditor) => {
      const first = await transfer(paths, to, "copy", name ?? undefined);
      if (typeof first === "string" && openInEditor) void openFile(first, { focus: true });
      return !!first;
    },
  });
}

/**
 * Moves or copies `paths` into `target`. Copies take `name` (a single item) or
 * get a non-conflicting name (`Foo copy.kt`); moves refuse to overwrite.
 * Returns whether anything changed (for copies: the first copy's path).
 */
export async function transfer(
  paths: string[],
  target: string,
  mode: "move" | "copy",
  name?: string,
): Promise<string | boolean> {
  if (mode === "move") return moveInto(paths, target);
  const { root } = get();
  if (!root) return false;
  const fs = projectFs(root);
  await loadDir(target);
  const taken = new Set(siblingsOf(target).map((n) => (caseInsensitive ? n.toLowerCase() : n)));
  const isTaken = (n: string) => taken.has(caseInsensitive ? n.toLowerCase() : n);
  const touched = new Set<string>([target]);
  const errors: string[] = [];
  let first: string | null = null;
  const newName = name;
  for (const src of paths) {
    const name = nameOf(src);
    if (isSameOrInside(target, src) && target !== parentOf(src) && src !== target) {
      errors.push(`${name}: cannot copy a folder into itself`);
      continue;
    }
    const srcIsDir =
      get().listings.has(src) || currentModel().byKey.get(currentModel().keyOfPath.get(src) ?? src)?.dir === true;
    const finalName = paths.length === 1 && newName ? newName : uniqueName(name, isTaken, srcIsDir);
    const to = joinPath(target, finalName);
    try {
      await fs.copy(src, to);
      taken.add(caseInsensitive ? finalName.toLowerCase() : finalName);
      first ??= to;
    } catch (e) {
      errors.push(`${name}: ${errorMessage(e)}`);
    }
  }
  if (errors.length)
    notifications().notify({ level: "error", title: "Some items could not be copied", body: errors.join("\n") });
  await Promise.all([...touched].map((d) => loadDir(d, true)));
  if (first) {
    expandFolder(target);
    revealPath(first, false);
  }
  return first ?? false;
}

/**
 * Moves `paths` into `target` as one Move refactoring (references updated with
 * the options last used in the Move dialog). Refuses to overwrite.
 */
async function moveInto(paths: string[], target: string): Promise<boolean> {
  await loadDir(target);
  const taken = new Set(siblingsOf(target).map((n) => (caseInsensitive ? n.toLowerCase() : n)));
  const errors: string[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const src of paths) {
    const name = nameOf(src);
    if (parentOf(src) === target) continue;
    if (isSameOrInside(target, src)) errors.push(`${name}: cannot move a folder into itself`);
    else if (taken.has(caseInsensitive ? name.toLowerCase() : name))
      errors.push(`${name}: already exists in ${nameOf(target) || target}`);
    else moves.push({ from: src, to: joinPath(target, name) });
  }
  if (errors.length)
    notifications().notify({ level: "error", title: "Some items could not be moved", body: errors.join("\n") });
  if (!moves.length) return false;
  const status = await runFileRefactoring(moves, rememberedOptions("move"), "Move");
  if (status !== "done") return false;
  await afterMove(moves);
  revealPath(moves[0]!.to, false);
  return true;
}

/** Drag & drop inside the tree: the Move dialog (or a confirmed copy with ⌥). */
export async function dropPaths(paths: string[], target: string, copy: boolean) {
  if (isReadOnlyPath(target)) return;
  const movable = topLevelPaths(
    paths
      .map((p) => currentModel().byKey.get(currentModel().keyOfPath.get(p) ?? p))
      .filter((n): n is ProjectNode => !!n && (copy || !n.readOnly)),
  ).filter((p) => copy || parentOf(p) !== target);
  if (!movable.length) return;
  // IDEA opens the Move refactoring dialog for drops inside the project.
  if (!copy) {
    const node =
      movable.length === 1 ? currentModel().byKey.get(currentModel().keyOfPath.get(movable[0]!) ?? "") : undefined;
    return openMoveDialogFor(movable, target, node?.dir);
  }
  const node =
    movable.length === 1 ? currentModel().byKey.get(currentModel().keyOfPath.get(movable[0]!) ?? "") : undefined;
  openCopyDialogFor(movable, target, node?.dir);
}

/** Files dropped from the OS: copied into `target` (never moved). */
export async function importExternal(paths: string[], target: string) {
  const { root } = get();
  if (!root || !paths.length || isReadOnlyPath(target)) return;
  const inside = paths.filter((p) => isSameOrInside(p, root));
  const outside = paths.filter((p) => !isSameOrInside(p, root));
  if (inside.length) await dropPaths(inside, target, false);
  if (outside.length) await transfer(outside, target, "copy");
}

// ---------------------------------------------------------------------------
// Paths / external

export type PathKind = "absolute" | "relative" | "name";

export function pathsFor(kind: PathKind, nodes: ProjectNode[] = selectedNodes()): string[] {
  const { root } = get();
  return nodes.map((n) =>
    kind === "absolute" ? n.path : kind === "name" ? nameOf(n.path) : relativeTo(root ?? "", n.path) || ".",
  );
}

export async function copyPaths(kind: PathKind, nodes: ProjectNode[] = selectedNodes()) {
  const text = pathsFor(kind, nodes).join("\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    fail("Cannot access the clipboard", e);
  }
}

export async function revealInFinder(nodes: ProjectNode[] = selectedNodes()) {
  const paths = nodes.map((n) => n.path);
  if (!paths.length) return;
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(paths.length === 1 ? paths[0]! : paths);
  } catch (e) {
    fail("Cannot reveal in Finder", e);
  }
}

export function folderOf(node: ProjectNode | null = leadNode()): string | null {
  return targetFolder(node);
}

/** Runs another feature's action if it is registered; returns whether it exists. */
export function delegate(id: string, arg: unknown): boolean {
  if (!getAction(id)) return false;
  void executeAction(id, arg);
  return true;
}

/** Argument for VCS actions: one path or several. */
export function vcsArg(nodes: ProjectNode[] = selectedNodes()): string | string[] {
  const paths = nodes.map((n) => n.path);
  return paths.length === 1 ? paths[0]! : paths;
}
