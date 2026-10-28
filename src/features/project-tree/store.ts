/**
 * Project view state: lazily loaded listings, expansion / selection (keyed by
 * node key: the path, namespaced below External Libraries), view options, inline editing and the internal clipboard.
 * Kept outside React so actions (keyboard, Find Action, context menu) share it.
 */
import { create } from "zustand";
import type { FileEntry } from "@/bindings";
import { IpcError } from "@/platform/ipc";
import {
  DEFAULT_TREE_OPTIONS,
  GROUP_PREFIX,
  buildModel,
  buildPathsModel,
  extraFolders,
  isGroupKey,
  isLibKey,
  keyLike,
  pathOfKey,
  withExtraRoots,
  withReadOnlyFolders,
  dropListings,
  isDirEntry,
  mergeListing,
  planRefresh,
  visibleEntries,
  type Placeholder,
  type ProjectNode,
  type TreeModel,
  type TreeOptions,
} from "./model";
import { projectFs } from "./fs";
import { projectViewRoots, useProjectViewRoots, type ProjectViewRootContribution } from "@/workbench/contributions";
import { ancestorsWithin, isSameOrInside, type PackageKind } from "./paths";

export interface ViewOptions extends TreeOptions {
  /** Select the active editor's file in the tree. */
  autoscrollFromSource: boolean;
  /** Open the selected file while navigating the tree (preview, no focus change). */
  autoscrollToSource: boolean;
  /** Single click opens files (as regular tabs). */
  singleClickOpen: boolean;
  /** Single click on a folder row expands / collapses it. */
  singleClickExpand: boolean;
  /** Single click shows files in the preview tab (IDEA's "Enable Preview Tab"). */
  previewTab: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  ...DEFAULT_TREE_OPTIONS,
  autoscrollFromSource: false,
  autoscrollToSource: false,
  singleClickOpen: false,
  singleClickExpand: false,
  // IDEA's "Enable Preview Tab" is off by default.
  previewTab: false,
};

function storedOptions(): ViewOptions {
  const options = { ...DEFAULT_VIEW_OPTIONS, ...readJson<Partial<ViewOptions>>(OPTIONS_KEY) };
  if (!["name", "type", "modified"].includes(options.sortBy)) options.sortBy = "name";
  return options;
}

/** IDEA's Project view panes ("Project ▾" in the tool window header). */
export type ViewMode = "project" | "projectFiles" | "openFiles" | "changedFiles" | "scratches";

export const VIEW_MODES: ReadonlyArray<[ViewMode, string]> = [
  ["project", "Project"],
  ["projectFiles", "Project Files"],
  ["openFiles", "Open Files"],
  ["changedFiles", "All Changed Files"],
  ["scratches", "Scratches and Consoles"],
];

/** Modes listing just some files (expanded as they appear). */
export const isFilteredMode = (mode: ViewMode) => mode === "openFiles" || mode === "changedFiles";

export type Editing =
  | { kind: "new"; parent: string; nodeKind: "file" | "dir"; pkg?: PackageKind }
  | { kind: "rename"; key: string; path: string };

export interface Clipboard {
  paths: string[];
  cut: boolean;
}

interface ProjectTreeState {
  root: string | null;
  name: string;
  listings: ReadonlyMap<string, readonly FileEntry[]>;
  expanded: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  lead: string | null;
  options: ViewOptions;
  editing: Editing | null;
  clipboard: Clipboard | null;
  /** A path to select (and scroll to) once its row is visible. */
  revealRequest: { path: string; focus: boolean; seq: number } | null;
  /** Folder key highlighted as drop target. */
  dropTarget: string | null;
  mode: ViewMode;
  /** Files open in editor tabs (Open Files mode). */
  openFiles: readonly string[];
  /** Files with VCS changes (All Changed Files mode). */
  changedFiles: readonly string[];
}

const OPTIONS_KEY = "openidea.projectTree.options";
const MODE_KEY = "openidea.projectTree.mode";
const expandedKey = (root: string) => `openidea.projectTree.expanded:${root}`;
const MAX_PERSISTED = 3000;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: expansion just isn't remembered */
  }
}

export const useProjectTree = create<ProjectTreeState>(() => ({
  root: null,
  name: "",
  listings: new Map(),
  expanded: new Set(),
  selected: new Set(),
  lead: null,
  options: storedOptions(),
  editing: null,
  clipboard: null,
  revealRequest: null,
  dropTarget: null,
  mode: readMode(),
  openFiles: [],
  changedFiles: [],
}));

function readMode(): ViewMode {
  const m = readJson<string>(MODE_KEY);
  return VIEW_MODES.find(([id]) => id === m)?.[0] ?? "project";
}

const get = () => useProjectTree.getState();
const set = (patch: Partial<ProjectTreeState>) => useProjectTree.setState(patch);

// ---------------------------------------------------------------------------
// Derived model (memoised on its inputs so React and actions share one instance)

let memo: {
  root: string | null;
  name: string;
  listings: ProjectTreeState["listings"];
  options: ViewOptions;
  editing: Editing | null;
  mode: ViewMode;
  files: readonly string[] | null;
  extras: ReadonlyMap<string, ProjectViewRootContribution>;
  model: TreeModel;
} | null = null;

const EMPTY_MODEL: TreeModel = { roots: [], children: new Map(), byKey: new Map(), keyOfPath: new Map() };

const filesOf = (s: ProjectTreeState) =>
  s.mode === "openFiles" ? s.openFiles : s.mode === "changedFiles" ? s.changedFiles : null;

export function selectModel(s: ProjectTreeState): TreeModel {
  const files = filesOf(s);
  if (
    memo &&
    memo.root === s.root &&
    memo.name === s.name &&
    memo.listings === s.listings &&
    memo.options === s.options &&
    memo.editing === s.editing &&
    memo.mode === s.mode &&
    memo.files === files &&
    memo.extras === useProjectViewRoots.getState().roots
  )
    return memo.model;
  const placeholder: Placeholder | null =
    s.editing?.kind === "new" ? { parent: s.editing.parent, kind: s.editing.nodeKind } : null;
  const extras = useProjectViewRoots.getState().roots;
  const contributed = projectViewRoots(extras);
  const project = () => buildModel({ path: s.root!, name: s.name }, s.listings, s.options, placeholder);
  let model = EMPTY_MODEL;
  if (s.root) {
    if (s.mode === "projectFiles") model = project();
    else if (s.mode === "scratches")
      model = withExtraRoots(
        EMPTY_MODEL,
        contributed.filter((r) => r.scope === "scratches"),
        s.listings,
        s.options,
        placeholder,
      );
    else if (files)
      model = buildPathsModel(
        [{ path: s.root, label: s.name, icon: "" }, ...extraFolders(contributed)],
        files,
        s.options.foldersFirst,
      );
    else model = withExtraRoots(project(), contributed, s.listings, s.options, placeholder);
    const libraries = extraFolders(contributed).flatMap((r) =>
      r.readOnly && r.path !== undefined && isSameOrInside(r.path, s.root!) ? [r.path] : [],
    );
    model = withReadOnlyFolders(model, libraries);
  }
  memo = {
    root: s.root,
    name: s.name,
    listings: s.listings,
    options: s.options,
    editing: s.editing,
    mode: s.mode,
    files,
    extras,
    model,
  };
  return model;
}

export const currentModel = () => selectModel(get());

// ---------------------------------------------------------------------------
// Lifecycle

let generation = 0;
const inflight = new Map<string, Promise<void>>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Resets the view for a newly opened project, restoring its expansion state. */
export function initProjectTree(root: string | null, name = "") {
  generation++;
  inflight.clear();
  clearTimeout(persistTimer);
  modeExpanded.clear();
  autoExpanded.clear();
  set({
    root,
    name,
    listings: new Map(),
    expanded: initialExpanded(root, get().mode),
    selected: new Set(),
    lead: null,
    editing: null,
    clipboard: null,
    revealRequest: null,
    dropTarget: null,
  });
}

/** Expansion of the modes not shown (each pane keeps its own, like IDEA's). */
const modeExpanded = new Map<ViewMode, ReadonlySet<string>>();
/** Folders of a filtered mode already expanded once (collapsing them sticks). */
const autoExpanded = new Set<string>();

/** "Project" restores the persisted expansion; other panes start with their roots open. */
function initialExpanded(root: string | null, mode: ViewMode): Set<string> {
  if (!root || isFilteredMode(mode)) return new Set();
  if (mode === "scratches")
    return new Set(
      projectViewRoots(useProjectViewRoots.getState().roots).flatMap((r) =>
        r.scope === "scratches" && r.path ? [r.path] : [],
      ),
    );
  const persisted = mode === "project" ? (readJson<string[]>(expandedKey(root)) ?? []) : [];
  const expanded = new Set(persisted.filter((p) => isSameOrInside(p, root)));
  expanded.add(root);
  return expanded;
}

function persistExpanded() {
  if (get().mode !== "project") return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { root, expanded, mode } = get();
    if (root && mode === "project") writeJson(expandedKey(root), [...expanded].slice(0, MAX_PERSISTED));
  }, 300);
}

/** Switches the pane ("Project ▾"), remembered across sessions. */
export function setViewMode(mode: ViewMode) {
  const s = get();
  if (s.mode === mode) return;
  modeExpanded.set(s.mode, s.expanded);
  autoExpanded.clear();
  writeJson(MODE_KEY, mode);
  set({
    mode,
    expanded: modeExpanded.get(mode) ?? initialExpanded(s.root, mode),
    selected: new Set(),
    lead: null,
    editing: null,
    dropTarget: null,
  });
}

/** Open Files / All Changed Files: expands folders the first time they appear. */
export function autoExpand(model: TreeModel) {
  const s = get();
  if (!isFilteredMode(s.mode)) return;
  let next: Set<string> | null = null;
  for (const [key, node] of model.byKey) {
    if (!node.dir || autoExpanded.has(key)) continue;
    autoExpanded.add(key);
    if (!s.expanded.has(key)) (next ??= new Set(s.expanded)).add(key);
  }
  if (next) set({ expanded: next });
}

export function setOpenFiles(paths: readonly string[]) {
  const prev = get().openFiles;
  if (prev.length !== paths.length || prev.some((p, i) => p !== paths[i])) set({ openFiles: [...paths] });
}

export function setChangedFiles(paths: readonly string[]) {
  const prev = get().changedFiles;
  if (prev.length !== paths.length || prev.some((p, i) => p !== paths[i])) set({ changedFiles: [...paths] });
}

export function setExpanded(expanded: ReadonlySet<string>) {
  set({ expanded });
  persistExpanded();
}

/** Expands or collapses a folder node; expanding a compacted chain opens every folder in it. */
export function toggleExpanded(node: Pick<ProjectNode, "key" | "chain">) {
  const next = new Set(get().expanded);
  if (next.has(node.key)) next.delete(node.key);
  else {
    next.add(node.key);
    for (const p of node.chain) next.add(keyLike(node.key, p));
  }
  setExpanded(next);
}

export function setSelection(selected: ReadonlySet<string>, lead: string | null) {
  set({ selected, lead });
}

export function setViewOption<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]) {
  const options = { ...get().options, [key]: value };
  set({ options });
  writeJson(OPTIONS_KEY, options);
}

// ---------------------------------------------------------------------------
// Loading

function putListing(path: string, entries: readonly FileEntry[]) {
  const { listings } = get();
  const merged = mergeListing(listings.get(path), entries);
  if (merged === listings.get(path)) return;
  set({ listings: new Map(listings).set(path, merged) });
}

/** Loads (or reloads) one folder. Concurrent calls for the same folder share a request. */
export function loadDir(path: string, force = false): Promise<void> {
  const { root, listings } = get();
  if (!root || isGroupKey(path)) return Promise.resolve();
  if (!force && listings.has(path)) return Promise.resolve();
  const running = inflight.get(path);
  if (running) return running;
  const gen = generation;
  const p = (async () => {
    try {
      const entries = await projectFs(root).readDir(path);
      if (gen !== generation) return;
      putListing(path, entries);
      // Compact Middle Packages needs to look one level down a single-folder chain.
      const s = get();
      if (s.options.compact) {
        const visible = visibleEntries(entries, s.options);
        const only = visible.length === 1 ? visible[0]! : null;
        if (only && isDirEntry(only) && !only.ignored && !s.listings.has(only.path)) void loadDir(only.path);
      }
    } catch (e) {
      if (gen !== generation) return;
      const s = get();
      if (e instanceof IpcError && (e.kind === "notFound" || e.kind === "invalidInput")) {
        const listings = new Map(s.listings);
        dropListings(listings, [path]);
        const expanded = new Set([...s.expanded].filter((k) => !isSameOrInside(pathOfKey(k), path) || k === s.root));
        set({ listings, expanded });
        if (path === s.root) set({ listings: new Map(listings).set(path, []) });
      } else {
        console.warn(`project view: cannot read ${path}`, e);
        putListing(path, s.listings.get(path) ?? []);
      }
    } finally {
      if (gen === generation) inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

export function isLoading(path: string): boolean {
  return inflight.has(path);
}

/** Applies a backend `fsChanged` event: reloads affected loaded folders only. */
export async function applyFsChange(event: { created: string[]; modified: string[]; removed: string[] }) {
  const s = get();
  if (!s.root) return;
  const plan = planRefresh(event, new Set(s.listings.keys()));
  if (plan.drop.length) {
    const listings = new Map(s.listings);
    dropListings(listings, plan.drop);
    const gone = (k: string) => plan.drop.some((d) => isSameOrInside(pathOfKey(k), d));
    const selected = [...s.selected].filter((k) => !gone(k));
    set({
      listings,
      selected: selected.length === s.selected.size ? s.selected : new Set(selected),
      lead: s.lead && gone(s.lead) ? null : s.lead,
    });
  }
  // Removed files: drop them from the selection too.
  if (event.removed.length) {
    const cur = get();
    const removed = new Set(event.removed);
    const isRemoved = (k: string) => removed.has(pathOfKey(k));
    if ([...cur.selected].some(isRemoved)) {
      set({
        selected: new Set([...cur.selected].filter((k) => !isRemoved(k))),
        lead: cur.lead && isRemoved(cur.lead) ? null : cur.lead,
      });
    }
  }
  await Promise.all(plan.reload.map((p) => loadDir(p, true)));
}

/** Re-reads every loaded folder (View › Reload from Disk). */
export async function reloadAll() {
  const { listings } = get();
  await Promise.all([...listings.keys()].map((p) => loadDir(p, true)));
}

// ---------------------------------------------------------------------------
// Reveal / expand

let revealSeq = 0;

/** Expands the ancestors of `path` and selects it once visible. */
export function revealPath(path: string, focus = false) {
  const { expanded } = get();
  const project = get().root;
  const root = project && isSameOrInside(path, project) ? project : project ? extraRootOf(path) : null;
  if (!root) return false;
  // Library folders sit below group nodes (External Libraries › SDK), keyed in their own namespace.
  const model = currentModel();
  const rootKey = root === project ? root : (model.keyOfPath.get(root) ?? root);
  const folders = ancestorsWithin(root, path);
  const ancestors = [...groupAncestors(model, rootKey), ...folders.map((a) => keyLike(rootKey, a))];
  const next = new Set(expanded);
  let changed = false;
  for (const a of ancestors)
    if (!next.has(a)) {
      next.add(a);
      changed = true;
    }
  if (changed) setExpanded(next);
  set({ revealRequest: { path, focus, seq: ++revealSeq } });
  for (const a of folders) void loadDir(a);
  return true;
}

/** The contributed folder (scratches, a library root…) containing `path`, if any. */
export function extraRootOf(path: string): string | null {
  for (const r of extraFolders(projectViewRoots(useProjectViewRoots.getState().roots)))
    if (r.path !== undefined && isSameOrInside(path, r.path)) return r.path;
  return null;
}

/** Whether the current pane can show `path` (Select In switches to "Project" otherwise). */
export function modeShows(path: string): boolean {
  const { mode, root } = get();
  if (!root) return false;
  switch (mode) {
    case "project":
      return true;
    case "projectFiles":
      return isSameOrInside(path, root);
    case "scratches":
      return projectViewRoots(useProjectViewRoots.getState().roots).some(
        (r) => r.scope === "scratches" && r.path !== undefined && isSameOrInside(path, r.path),
      );
    default:
      return currentModel().keyOfPath.has(path);
  }
}

/** Whether `path` lies in read-only library sources. */
export function isReadOnlyPath(path: string): boolean {
  if (isGroupKey(path) || isLibKey(path)) return true;
  return extraFolders(projectViewRoots(useProjectViewRoots.getState().roots)).some(
    (r) => r.readOnly && r.path !== undefined && isSameOrInside(path, r.path),
  );
}

/** Group node keys above the node `key`, outermost first. */
function groupAncestors(model: TreeModel, key: string): string[] {
  const out: string[] = [];
  for (let child = key; ;) {
    let parent: string | null = null;
    for (const [k, kids] of model.children)
      if (k.startsWith(GROUP_PREFIX) && kids.some((n) => n.key === child)) {
        parent = k;
        break;
      }
    if (!parent) return out;
    out.unshift(parent);
    child = parent;
  }
}

export function clearRevealRequest(seq: number) {
  if (get().revealRequest?.seq === seq) set({ revealRequest: null });
}

/** Expands every folder below the node keyed `from` (skipping excluded ones), loading as needed; capped. */
export async function expandAll(from?: string, limit = 400) {
  const { root, mode } = get();
  if (!root) return;
  const model = currentModel();
  // Filtered panes hold every folder already.
  if (isFilteredMode(mode))
    return setExpanded(new Set([...model.byKey.values()].filter((n) => n.dir).map((n) => n.key)));
  const queue = [from ?? model.roots[0]?.key ?? root];
  const toExpand = new Set(get().expanded);
  let count = 0;
  const gen = generation;
  while (queue.length && count < limit) {
    const dir = queue.shift()!;
    toExpand.add(dir);
    count++;
    if (isGroupKey(dir)) {
      for (const n of model.children.get(dir) ?? []) queue.push(n.key);
      continue;
    }
    const path = pathOfKey(dir);
    await loadDir(path);
    if (gen !== generation) return;
    const s = get();
    for (const e of visibleEntries(s.listings.get(path) ?? [], s.options))
      if (isDirEntry(e) && !e.ignored && e.kind !== "symlink") queue.push(keyLike(dir, e.path));
  }
  setExpanded(toExpand);
}

export function collapseAll() {
  const { root, mode } = get();
  if (root) setExpanded(new Set(mode === "project" || mode === "projectFiles" ? [root] : []));
}

// ---------------------------------------------------------------------------
// Editing / clipboard / drag state

export function startEditing(editing: Editing | null) {
  set({ editing });
}

export function setClipboard(clipboard: Clipboard | null) {
  set({ clipboard });
}

export function setDropTarget(key: string | null) {
  if (get().dropTarget !== key) set({ dropTarget: key });
}
