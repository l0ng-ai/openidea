/**
 * Pure project tree model: turns lazily loaded directory listings into tree
 * nodes (filtering, sorting, IDEA's "Compact Middle Packages") and plans the
 * incremental refresh for `fsChanged` events. No React, no IPC.
 */
import type { FileEntry } from "@/bindings";
import { isIgnoredName } from "@/platform/ignoredNames";
import { ancestorsWithin, isInside, isSameOrInside, nameOf, parentOf, relativeTo } from "./paths";

export interface TreeOptions {
  /** Show ignored names (`files.ignoredNames`: `.git`, `.DS_Store`, …). Dotfiles are always shown. */
  showHidden: boolean;
  /** Show entries matched by .gitignore / exclude settings (dimmed). */
  showExcluded: boolean;
  /** Merge single-child folder chains (`com/acme/orders` → `com.acme.orders`). */
  compact: boolean;
  foldersFirst: boolean;
  /** Order within a folder: name, file type (extension), or newest modification first. */
  sortBy: SortKey;
}

export type SortKey = "name" | "type" | "modified";

export const DEFAULT_TREE_OPTIONS: TreeOptions = {
  showHidden: false,
  showExcluded: true,
  compact: true,
  foldersFirst: true,
  sortBy: "name",
};

export interface ProjectNode {
  /** Tree key: the path of the first folder of a compacted chain, else `path`. */
  key: string;
  /** Effective path: the last folder of a chain (operations target it), or the file. */
  path: string;
  /** Folder paths merged into this node (just `[path]` when not compacted). */
  chain: string[];
  label: string;
  dir: boolean;
  root: boolean;
  entry: FileEntry | null;
  ignored: boolean;
  /** Excluded by the exclude settings / Project Structure (not just git-ignored). */
  excluded: boolean;
  symlink: boolean;
  /** Placeholder row for the inline "new file / folder" editor. */
  placeholder?: "file" | "dir";
  /** Root of a contributed folder outside the project ("Scratches"): its icon. */
  icon?: string;
  /** Grey text after the label ("library root"). */
  detail?: string;
  /** A node grouping other nodes, without a folder of its own ("External Libraries"). */
  group?: boolean;
  /** Library sources: no new / rename / move / delete. */
  readOnly?: boolean;
}

export interface TreeModel {
  roots: ProjectNode[];
  /** Loaded children per node key. */
  children: Map<string, ProjectNode[]>;
  byKey: Map<string, ProjectNode>;
  /** Any folder / file path present in the model → key of the node showing it. */
  keyOfPath: Map<string, string>;
}

export type Listings = ReadonlyMap<string, readonly FileEntry[]>;

export function isVisible(entry: FileEntry, opts: TreeOptions): boolean {
  // Ignored names are also excluded on the backend; only "Show Hidden" brings them back.
  if (isIgnoredName(entry.name)) return opts.showHidden;
  if (!opts.showExcluded && entry.ignored) return false;
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Symlinks report the target's metadata; folders have size 0 (the entry has no target kind). */
export const isDirEntry = (e: FileEntry) => e.kind === "dir" || (e.kind === "symlink" && e.size === 0);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
};

export function sortEntries(
  entries: readonly FileEntry[],
  foldersFirst: boolean,
  sortBy: SortKey = "name",
): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (foldersFirst) {
      const d = Number(isDirEntry(b)) - Number(isDirEntry(a));
      if (d) return d;
    }
    if (sortBy === "type") {
      const t = collator.compare(extensionOf(a.name), extensionOf(b.name));
      if (t) return t;
    } else if (sortBy === "modified") {
      const m = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
      if (m) return m;
    }
    return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

/** Visible, sorted entries of a loaded folder. */
export function visibleEntries(listing: readonly FileEntry[], opts: TreeOptions): FileEntry[] {
  const filtered = listing.filter((e) => isVisible(e, opts));
  // The backend already sorts folders first (natural order); only re-sort when needed.
  return opts.foldersFirst && opts.sortBy === "name" ? filtered : sortEntries(filtered, opts.foldersFirst, opts.sortBy);
}

/** JVM-style source folders join compacted package chains with `.` instead of `/`. */
const PACKAGE_ROOT = /(^|\/)(java|kotlin|scala|groovy)(\/|$)/;

/** `src/main/kotlin`-style source roots end a chain: packages below them compact separately. */
const SOURCE_ROOT = /(^|\/)(main|test)\/(java|kotlin|scala|groovy)$/;

function chainSeparator(root: string, head: string): string {
  return PACKAGE_ROOT.test(relativeTo(root, parentOf(head))) ? "." : "/";
}

export interface Placeholder {
  /** Folder (effective path) receiving the new item. */
  parent: string;
  kind: "file" | "dir";
}

export const PLACEHOLDER_SUFFIX = "\u0000new";

export function buildModel(
  root: { path: string; name: string },
  listings: Listings,
  opts: TreeOptions,
  placeholder?: Placeholder | null,
): TreeModel {
  const children = new Map<string, ProjectNode[]>();
  const byKey = new Map<string, ProjectNode>();
  const keyOfPath = new Map<string, string>();

  const rootNode: ProjectNode = {
    key: root.path,
    path: root.path,
    chain: [root.path],
    label: root.name,
    dir: true,
    root: true,
    entry: null,
    ignored: false,
    excluded: false,
    symlink: false,
  };
  byKey.set(rootNode.key, rootNode);
  keyOfPath.set(root.path, rootNode.key);

  const makeNode = (entry: FileEntry): ProjectNode => {
    const dir = isDirEntry(entry);
    if (!dir) {
      return {
        key: entry.path,
        path: entry.path,
        chain: [entry.path],
        label: entry.name,
        dir: false,
        root: false,
        entry,
        ignored: entry.ignored,
        excluded: entry.excluded,
        symlink: entry.kind === "symlink",
      };
    }
    const chain = [entry.path];
    const names = [entry.name];
    let end = entry;
    if (opts.compact && !(placeholder && placeholder.parent === entry.path)) {
      for (;;) {
        if (SOURCE_ROOT.test(relativeTo(root.path, end.path))) break;
        const listing = listings.get(end.path);
        if (!listing) break;
        const visible = visibleEntries(listing, opts);
        if (visible.length !== 1) break;
        const only = visible[0]!;
        if (!isDirEntry(only) || only.ignored !== entry.ignored || only.excluded !== entry.excluded) break;
        if (placeholder && placeholder.parent === only.path) break;
        end = only;
        chain.push(only.path);
        names.push(only.name);
      }
    }
    const label = names.length > 1 ? names.join(chainSeparator(root.path, entry.path)) : entry.name;
    return {
      key: entry.path,
      path: end.path,
      chain,
      label,
      dir: true,
      root: false,
      entry: end,
      ignored: entry.ignored,
      excluded: entry.excluded,
      symlink: entry.kind === "symlink",
    };
  };

  const fill = (node: ProjectNode) => {
    const listing = listings.get(node.path);
    if (!listing) return;
    const kids = visibleEntries(listing, opts).map(makeNode);
    if (placeholder && placeholder.parent === node.path) {
      const ph: ProjectNode = {
        key: node.path + PLACEHOLDER_SUFFIX,
        path: node.path,
        chain: [],
        label: "",
        dir: placeholder.kind === "dir",
        root: false,
        entry: null,
        ignored: false,
        excluded: false,
        symlink: false,
        placeholder: placeholder.kind,
      };
      kids.unshift(ph);
    }
    children.set(node.key, kids);
    for (const kid of kids) {
      byKey.set(kid.key, kid);
      if (kid.placeholder) continue;
      for (const p of kid.chain) keyOfPath.set(p, kid.key);
      if (kid.dir) fill(kid);
    }
  };
  fill(rootNode);

  return { roots: [rootNode], children, byKey, keyOfPath };
}

/** A contributed root (scratches, External Libraries) or one of its child entries. */
export interface ExtraRoot {
  id?: string;
  label: string;
  icon: string;
  /** Folder listed by the node; omitted for a group node of `children`. */
  path?: string;
  children?: readonly ExtraRoot[];
  detail?: string;
  readOnly?: boolean;
}

/** Key prefix of group nodes that show no folder ("External Libraries", an SDK). */
export const GROUP_PREFIX = "\u0000group:";

export const isGroupKey = (key: string) => key.startsWith(GROUP_PREFIX);

/**
 * Key prefix of nodes in a library folder below a group (`\0lib:<group>\0<path>`):
 * their own namespace, so a folder inside the project (a `.venv`'s
 * site-packages, `node_modules/<dep>`) shows both there and under External Libraries.
 */
export const LIB_PREFIX = "\u0000lib:";
const LIB_SEP = "\u0000";

export const isLibKey = (key: string) => key.startsWith(LIB_PREFIX);

export const libKey = (group: string, path: string) => `${LIB_PREFIX}${group}${LIB_SEP}${path}`;

/** The folder / file a node key stands for (keys outside library subtrees are paths). */
export function pathOfKey(key: string): string {
  return isLibKey(key) ? key.slice(key.indexOf(LIB_SEP, LIB_PREFIX.length) + 1) : key;
}

/** The key of `path` in the same subtree as the node keyed `like`. */
export function keyLike(like: string, path: string): string {
  return isLibKey(like) ? like.slice(0, like.indexOf(LIB_SEP, LIB_PREFIX.length) + 1) + path : path;
}

/**
 * Adds contributed roots (folders outside the project, e.g. scratches, and
 * groups of them like External Libraries) after the project root. Each folder
 * lists its contents like the project root does.
 */
export function withExtraRoots(
  model: TreeModel,
  extras: readonly ExtraRoot[],
  listings: Listings,
  opts: TreeOptions,
  placeholder?: Placeholder | null,
): TreeModel {
  if (!extras.length) return model;
  const out: TreeModel = {
    roots: [...model.roots],
    children: new Map(model.children),
    byKey: new Map(model.byKey),
    keyOfPath: new Map(model.keyOfPath),
  };
  const add = (extra: ExtraRoot, parentKey: string | null, readOnly: boolean): ProjectNode | null => {
    const ro = readOnly || !!extra.readOnly;
    if (extra.path !== undefined && !extra.children) {
      const path = extra.path;
      // Library folders of a group are keyed in their own namespace; other
      // folders (scratches) by path, so ones inside the project stay under it.
      const ns = ro && parentKey ? parentKey.slice(GROUP_PREFIX.length) : null;
      const rekey = (k: string) => (ns === null ? k : libKey(ns, k));
      if (out.byKey.has(rekey(path))) return null;
      if (ns === null && model.roots.some((r) => !r.group && isSameOrInside(path, r.path))) return null;
      const sub = buildModel({ path, name: extra.label }, listings, opts, ro ? null : placeholder);
      const subRoot = sub.roots[0]!;
      const rootNode: ProjectNode = {
        ...subRoot,
        key: rekey(subRoot.key),
        root: !parentKey,
        icon: extra.icon,
        detail: extra.detail,
      };
      if (ro) rootNode.readOnly = true;
      const nodes = new Map<string, ProjectNode>();
      for (const [k, v] of sub.byKey)
        nodes.set(
          k,
          k === subRoot.key ? rootNode : ns !== null || ro ? { ...v, key: rekey(k), readOnly: ro || v.readOnly } : v,
        );
      for (const n of nodes.values()) out.byKey.set(n.key, n);
      for (const [k, v] of sub.children)
        out.children.set(
          rekey(k),
          v.map((n) => nodes.get(n.key) ?? n),
        );
      for (const [p, k] of sub.keyOfPath) if (!out.keyOfPath.has(p)) out.keyOfPath.set(p, rekey(k));
      return rootNode;
    }
    const key = `${parentKey ? `${parentKey}/` : GROUP_PREFIX}${extra.id ?? extra.label}`;
    if (out.byKey.has(key)) return null;
    const node: ProjectNode = {
      key,
      path: key,
      chain: [],
      label: extra.label,
      dir: true,
      root: !parentKey,
      entry: null,
      ignored: false,
      excluded: false,
      symlink: false,
      icon: extra.icon,
      detail: extra.detail,
      group: true,
      readOnly: true,
    };
    out.byKey.set(key, node);
    const kids = (extra.children ?? []).map((c) => add(c, key, ro)).filter((n): n is ProjectNode => !!n);
    out.children.set(key, kids);
    return node;
  };
  for (const extra of extras) {
    const node = add(extra, null, false);
    if (node) out.roots.push(node);
  }
  return out;
}

/**
 * Marks project nodes inside read-only library `folders` (a `.venv`'s
 * site-packages listed under External Libraries) read-only too.
 */
export function withReadOnlyFolders(model: TreeModel, folders: readonly string[]): TreeModel {
  if (!folders.length) return model;
  const byKey = new Map(model.byKey);
  let changed = false;
  for (const [k, n] of model.byKey)
    if (!n.readOnly && !n.group && !isLibKey(k) && !n.root && folders.some((f) => isSameOrInside(n.path, f))) {
      byKey.set(k, { ...n, readOnly: true });
      changed = true;
    }
  if (!changed) return model;
  const children = new Map<string, ProjectNode[]>();
  for (const [k, kids] of model.children)
    children.set(
      k,
      kids.map((n) => byKey.get(n.key) ?? n),
    );
  return { roots: model.roots.map((n) => byKey.get(n.key) ?? n), children, byKey, keyOfPath: model.keyOfPath };
}

/** Folder roots of contributed entries (groups flattened), in display order. */
export function extraFolders(extras: readonly ExtraRoot[], readOnly = false): ExtraRoot[] {
  return extras.flatMap((e) =>
    e.path !== undefined && !e.children
      ? [{ ...e, readOnly: readOnly || !!e.readOnly }]
      : extraFolders(e.children ?? [], readOnly || !!e.readOnly),
  );
}

/**
 * A tree of just `paths` (IDEA's "Open Files" / "All Changed Files" views):
 * each file below the innermost of `roots` containing it, through its folders.
 * Files outside every root are grouped under their folder. Roots without
 * files are left out.
 */
export function buildPathsModel(roots: readonly ExtraRoot[], paths: readonly string[], foldersFirst = true): TreeModel {
  const children = new Map<string, ProjectNode[]>();
  const byKey = new Map<string, ProjectNode>();
  const keyOfPath = new Map<string, string>();
  const rootNodes: Array<[number, ProjectNode]> = [];
  const node = (path: string, label: string, dir: boolean, extra: Partial<ProjectNode> = {}): ProjectNode => {
    const n: ProjectNode = {
      key: path,
      path,
      chain: [path],
      label,
      dir,
      root: false,
      entry: null,
      ignored: false,
      excluded: false,
      symlink: false,
      ...extra,
    };
    byKey.set(path, n);
    keyOfPath.set(path, path);
    if (dir) children.set(path, []);
    return n;
  };
  const ensureRoot = (r: ExtraRoot & { path: string }, rank: number) => {
    const existing = byKey.get(r.path);
    if (existing) return existing;
    const n = node(r.path, r.label, true, {
      root: true,
      icon: r.icon || undefined,
      detail: r.detail,
      readOnly: r.readOnly,
    });
    rootNodes.push([rank, n]);
    return n;
  };
  const folders = roots.filter((r): r is ExtraRoot & { path: string } => r.path !== undefined);
  for (const path of new Set(paths)) {
    if (byKey.has(path)) continue;
    let rank = -1;
    for (let i = 0; i < folders.length; i++)
      if (isInside(path, folders[i]!.path) && (rank < 0 || folders[i]!.path.length > folders[rank]!.path.length))
        rank = i;
    const root =
      rank >= 0
        ? ensureRoot(folders[rank]!, rank)
        : ensureRoot({ path: parentOf(path), label: parentOf(path), icon: "folder" }, folders.length);
    let parent = root;
    for (const dir of ancestorsWithin(root.path, path).slice(1)) {
      let d = byKey.get(dir);
      if (!d) {
        d = node(dir, nameOf(dir), true, { readOnly: root.readOnly });
        children.get(parent.key)!.push(d);
      }
      parent = d;
    }
    children.get(parent.key)!.push(node(path, nameOf(path), false, { readOnly: root.readOnly }));
  }
  const order = (a: ProjectNode, b: ProjectNode) =>
    (foldersFirst ? Number(b.dir) - Number(a.dir) : 0) || collator.compare(a.label, b.label);
  for (const kids of children.values()) kids.sort(order);
  rootNodes.sort((a, b) => a[0] - b[0] || collator.compare(a[1].label, b[1].label));
  return { roots: rootNodes.map(([, n]) => n), children, byKey, keyOfPath };
}

export interface VisibleInfo {
  /** Node keys currently rendered (ancestors expanded). */
  visible: Set<string>;
  /** Effective folder paths that are expanded but not loaded yet. */
  pending: string[];
}

/** Walks expanded nodes: which rows are visible and which folders still need loading. */
export function visibleInfo(model: TreeModel, expanded: ReadonlySet<string>): VisibleInfo {
  const visible = new Set<string>();
  const pending: string[] = [];
  const walk = (nodes: readonly ProjectNode[]) => {
    for (const n of nodes) {
      visible.add(n.key);
      if (!n.dir || !expanded.has(n.key)) continue;
      const kids = model.children.get(n.key);
      if (kids) walk(kids);
      else pending.push(n.path);
    }
  };
  walk(model.roots);
  return { visible, pending };
}

/** Resolves the key of the node showing `path`, falling back to its closest shown ancestor. */
export function nodeKeyFor(model: TreeModel, path: string): string | null {
  for (let p = path; ; p = parentOf(p)) {
    const k = model.keyOfPath.get(p);
    if (k) return k;
    if (p === "/" || !p) return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh on fsChanged

export interface RefreshPlan {
  /** Loaded folders whose listing must be re-read. */
  reload: string[];
  /** Loaded folders that no longer exist (drop with their loaded descendants). */
  drop: string[];
}

export function planRefresh(
  event: { created: readonly string[]; modified: readonly string[]; removed: readonly string[] },
  loaded: ReadonlySet<string>,
): RefreshPlan {
  const reload = new Set<string>();
  const drop = new Set<string>();
  const loadedList = [...loaded];

  for (const p of event.removed) {
    for (const dir of loadedList) if (isSameOrInside(dir, p)) drop.add(dir);
    const parent = parentOf(p);
    if (loaded.has(parent)) reload.add(parent);
  }
  for (const p of [...event.created, ...event.modified]) {
    const parent = parentOf(p);
    if (loaded.has(parent)) reload.add(parent);
    // A folder recreated / renamed into place, or a watcher reporting the folder itself.
    if (loaded.has(p)) {
      reload.add(p);
      drop.delete(p);
    }
  }
  for (const d of drop) reload.delete(d);
  // A reloaded parent may report the folder as present again; keep its descendants then.
  return { reload: [...reload], drop: [...drop] };
}

const sameEntry = (a: FileEntry, b: FileEntry) =>
  a.name === b.name &&
  a.path === b.path &&
  a.kind === b.kind &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ignored === b.ignored &&
  a.excluded === b.excluded &&
  a.hidden === b.hidden;

/**
 * Merges a re-read listing into the previous one, keeping unchanged entry
 * objects (stable identity → no re-render). Returns `prev` itself if nothing changed.
 */
export function mergeListing(prev: readonly FileEntry[] | undefined, next: readonly FileEntry[]): readonly FileEntry[] {
  if (!prev) return next;
  const old = new Map(prev.map((e) => [e.path, e]));
  let changed = prev.length !== next.length;
  const merged = next.map((e, i) => {
    const o = old.get(e.path);
    if (o && sameEntry(o, e)) {
      if (prev[i] !== o) changed = true;
      return o;
    }
    changed = true;
    return e;
  });
  return changed ? merged : prev;
}

/** Removes `dirs` and every loaded folder inside them. */
export function dropListings(listings: Map<string, readonly FileEntry[]>, dirs: readonly string[]) {
  if (!dirs.length) return;
  for (const key of [...listings.keys()]) if (dirs.some((d) => isSameOrInside(key, d))) listings.delete(key);
}
