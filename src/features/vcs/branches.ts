/** Branches popup model: grouping, ordering and filtering (pure). */
import type { Branch } from "@/bindings";
import { tx } from "@/platform/i18n";
import { fuzzyMatch } from "@/ui/match";

export interface PopupAction {
  id: string;
  label: string;
  icon?: string;
  /** Action argument passed to `executeAction`. */
  arg?: unknown;
  /** A separator goes between actions of different groups (Update / Commit / Push | New Branch / Checkout…). */
  group?: string;
}

export type BranchGroup = "recent" | "local" | "remote";

export type BranchRow =
  /** Section header; an empty label draws a separator. */
  | { type: "section"; key: string; label: string }
  | { type: "action"; key: string; action: PopupAction; matches: number[] | null }
  /** Collapsible node: Recent / Local / Remote / Tags (depth 0) or a prefix folder (`feat`). */
  | { type: "group"; key: string; label: string; expanded: boolean; depth: number }
  | {
      type: "branch";
      key: string;
      branch: Branch;
      group: BranchGroup;
      /** Shown name: the last segment inside a prefix folder. */
      label: string;
      depth: number;
      matches: number[] | null;
      favorite: boolean;
    }
  | { type: "tag"; key: string; tag: string; depth: number; matches: number[] | null };

/** Branches popup options (the popup's gear menu). */
export interface BranchTreeOptions {
  /** Groups and folders the user expanded (true) or collapsed (false); the others use their defaults. */
  expanded?: ReadonlyMap<string, boolean>;
  /** `feat/x` under a `feat` folder; remote branches under their remote. */
  groupByPrefix?: boolean;
  showRecent?: boolean;
  showTags?: boolean;
}

/** Copy of `expanded` with `key` set to `open`. */
export function withExpanded(expanded: ReadonlyMap<string, boolean>, key: string, open: boolean): Map<string, boolean> {
  return new Map(expanded).set(key, open);
}

export interface PrefixItem<T> {
  item: T;
  /** Full name, split into folders at `/`. */
  name: string;
  /** Highlighted characters of `name`. */
  matches: number[] | null;
  /** Listed before the folders of its level (current branch, favorites). */
  pinned: boolean;
}

/** A row of a prefix tree: a folder, or an item shown by the rest of its name. */
export type PrefixRow<T> =
  | { type: "folder"; key: string; label: string; depth: number; expanded: boolean }
  | { type: "leaf"; item: T; label: string; depth: number; matches: number[] | null };

/**
 * Rows of `items` grouped by name prefix (`feat/x` → feat › x), as in IDEA's Branches popup:
 * at each level pinned items, then folders by name, then the other items in their order.
 * `isOpen(key, path, items)` decides whether the folder `key` (prefix `path`) shows its items.
 * Ungrouped: the items as they are, by full name.
 */
export function prefixTreeRows<T>(
  items: readonly PrefixItem<T>[],
  opts: {
    keyPrefix: string;
    depth: number;
    grouped: boolean;
    isOpen: (key: string, path: string, items: readonly PrefixItem<T>[]) => boolean;
  },
): PrefixRow<T>[] {
  if (!opts.grouped)
    return items.map((i) => ({ type: "leaf", item: i.item, label: i.name, depth: opts.depth, matches: i.matches }));
  interface Entry {
    it: PrefixItem<T>;
    rest: string;
    offset: number;
  }
  const level = (list: readonly Entry[], path: string, depth: number): PrefixRow<T>[] => {
    const folders = new Map<string, Entry[]>();
    const leaves: Entry[] = [];
    for (const e of list) {
      const i = e.rest.indexOf("/");
      if (i > 0 && i < e.rest.length - 1) {
        const seg = e.rest.slice(0, i);
        const inner = folders.get(seg) ?? [];
        folders.set(seg, inner);
        inner.push({ it: e.it, rest: e.rest.slice(i + 1), offset: e.offset + i + 1 });
      } else leaves.push(e);
    }
    const leaf = (e: Entry): PrefixRow<T> => ({
      type: "leaf",
      item: e.it.item,
      label: e.rest,
      depth,
      // Highlights are of the full name: shift them onto the shown part.
      matches: e.it.matches && e.it.matches.map((m) => m - e.offset).filter((m) => m >= 0),
    });
    const out = leaves.filter((e) => e.it.pinned).map(leaf);
    for (const [seg, inner] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
      const folderPath = `${path}${seg}`;
      const key = `${opts.keyPrefix}${folderPath}`;
      const expanded = opts.isOpen(
        key,
        folderPath,
        inner.map((e) => e.it),
      );
      out.push({ type: "folder", key, label: seg, depth, expanded });
      if (expanded) out.push(...level(inner, `${folderPath}/`, depth + 1));
    }
    out.push(...leaves.filter((e) => !e.it.pinned).map(leaf));
    return out;
  };
  return level(
    items.map((it) => ({ it, rest: it.name, offset: 0 })),
    "",
    opts.depth,
  );
}

/** Default expansion of a prefix folder: in Recent, a remote (`origin`), or holding the current branch. */
export function defaultFolderOpen(group: BranchGroup, path: string, hasCurrent: boolean): boolean {
  return group === "recent" || (group === "remote" && !path.includes("/")) || hasCurrent;
}

type ActionRow = Extract<BranchRow, { type: "section" | "action" }>;

/** Action rows; with `separators`, a separator between actions of different groups. */
export function actionRows(
  actions: readonly PopupAction[],
  match: (text: string) => number[] | null | false,
  separators: boolean,
): ActionRow[] {
  const rows: ActionRow[] = [];
  let last: string | undefined;
  for (const a of actions) {
    const m = match(tx(a.label));
    if (m === false) continue;
    if (separators && rows.length && a.group !== last)
      rows.push({ type: "section", key: `separator:action:${a.id}`, label: "" });
    last = a.group;
    rows.push({ type: "action", key: `action:${a.id}`, action: a, matches: m });
  }
  return rows;
}

/** Current branch first, then favorites, then the rest; by name within each. */
function byRank(favorites: readonly string[] | null) {
  const rank = (b: Branch) => (b.current ? 0 : isFavoriteBranch(b, favorites) ? 1 : 2);
  return (a: Branch, b: Branch) => rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export function sortLocal(branches: readonly Branch[], favorites: readonly string[] | null = null): Branch[] {
  return branches.filter((b) => !b.remote).sort(byRank(favorites));
}

export function sortRemote(branches: readonly Branch[], favorites: readonly string[] | null = null): Branch[] {
  return branches.filter((b) => b.remote && !b.name.endsWith("/HEAD")).sort(byRank(favorites));
}

/** `origin/feature/x` → `feature/x`. */
export function shortRemoteName(name: string): string {
  const i = name.indexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}

export const MAX_RECENT = 5;

/** Recently checked-out local branches other than the current one, newest first. */
export function recentLocal(local: readonly Branch[], recent: readonly string[]): Branch[] {
  const byName = new Map(local.map((b) => [b.name, b]));
  return recent
    .map((n) => byName.get(n))
    .filter((b): b is Branch => !!b && !b.current)
    .slice(0, MAX_RECENT);
}

/** Tags, newest version first. */
export const sortTags = (tags: readonly string[]) =>
  [...tags].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

/**
 * Rows for the Branches popup: actions (separated by group), then the collapsible
 * Recent (recently checked-out local branches other than the current one), Local,
 * Remote and Tags groups. Recent is open by default, Local only without Recent,
 * Remote and Tags closed; `options.expanded` holds the user's choices. Names are
 * grouped by prefix into folders unless `groupByPrefix` is off. With a query:
 * matching actions, branches and tags with every group open; the Recent group is
 * dropped so each branch appears once. Favorites (★) come right after the current branch.
 */
export function buildBranchRows(
  branches: readonly Branch[],
  recent: readonly string[],
  query: string,
  actions: readonly PopupAction[],
  favorites: readonly string[] | null = null,
  tags: readonly string[] = [],
  options: BranchTreeOptions = {},
): BranchRow[] {
  const { expanded = new Map<string, boolean>(), groupByPrefix = true, showRecent = true, showTags = true } = options;
  const q = query.trim();
  const match = (text: string): number[] | null | false => {
    if (!q) return null;
    return fuzzyMatch(text, q) ?? false;
  };
  const open = (key: string, byDefault: boolean) => !!q || (expanded.get(key) ?? byDefault);
  const rows: BranchRow[] = actionRows(actions, match, !q);

  const tree: BranchRow[] = [];
  const pushGroup = (group: BranchGroup, label: string, list: readonly Branch[], byDefault: boolean) => {
    const items = list.flatMap((b): PrefixItem<Branch>[] => {
      const m = match(b.name);
      return m === false
        ? []
        : [{ item: b, name: b.name, matches: m, pinned: b.current || isFavoriteBranch(b, favorites) }];
    });
    if (!items.length) return;
    const key = `group:${group}`;
    const expandedNow = open(key, byDefault);
    tree.push({ type: "group", key, label, expanded: expandedNow, depth: 0 });
    if (!expandedNow) return;
    const children = prefixTreeRows(items, {
      keyPrefix: `folder:${group}:`,
      depth: 1,
      grouped: groupByPrefix,
      isOpen: (k, path, inner) =>
        open(
          k,
          defaultFolderOpen(
            group,
            path,
            inner.some((i) => i.item.current),
          ),
        ),
    });
    for (const r of children)
      tree.push(
        r.type === "folder"
          ? { type: "group", key: r.key, label: r.label, expanded: r.expanded, depth: r.depth }
          : {
              type: "branch",
              key: `${group}:${r.item.name}`,
              branch: r.item,
              group,
              label: r.label,
              depth: r.depth,
              matches: r.matches,
              favorite: isFavoriteBranch(r.item, favorites),
            },
      );
  };

  const local = sortLocal(branches, favorites);
  const rec = q || !showRecent ? [] : recentLocal(local, recent);
  pushGroup("recent", "Recent", rec, true);
  pushGroup("local", "Local", local, !rec.length);
  pushGroup("remote", "Remote", sortRemote(branches, favorites), false);
  if (showTags) {
    const tagRows = sortTags(tags).flatMap((t): BranchRow[] => {
      const m = match(t);
      return m === false ? [] : [{ type: "tag", key: `tag:${t}`, tag: t, depth: 1, matches: m }];
    });
    if (tagRows.length) {
      const expandedNow = open("group:tags", false);
      tree.push({ type: "group", key: "group:tags", label: "Tags", expanded: expandedNow, depth: 0 });
      if (expandedNow) tree.push(...tagRows);
    }
  }
  if (tree.length && rows.length) rows.push({ type: "section", key: "separator:tree", label: "" });
  rows.push(...tree);
  return rows;
}

/** Moves `name` to the front of a recent-branches list. */
export function pushRecent(list: readonly string[], name: string, max = 20): string[] {
  return [name, ...list.filter((n) => n !== name)].slice(0, max);
}

const DEFAULT_FAVORITES = ["main", "master"];

/** Favorite branches (★): the user's list, or `main` / `master` (local and remote) until they edit it. */
export function isFavoriteBranch(b: Pick<Branch, "name" | "remote">, stored: readonly string[] | null): boolean {
  if (stored) return stored.includes(b.name);
  return DEFAULT_FAVORITES.includes(b.remote ? shortRemoteName(b.name) : b.name);
}

export interface BranchTreeNode {
  key: string;
  label: string;
  repo?: string;
  kind: "repository" | "head" | "group" | "remote" | "folder" | "branch" | "tag";
  /** Branch name for `branch` / `head` (`HEAD`), tag name for `tag`. */
  ref: string | null;
  branch?: Branch;
  favorite?: boolean;
  children?: BranchTreeNode[];
}

/**
 * Git Log Branches pane: HEAD, Local, Remote › <remote> and Tags. Names with `/` are
 * grouped into folders (`feat/x` → feat › x); at each level the current branch and
 * favorites come first, then folders, then the other branches. Tags: newest version first.
 */
export function buildBranchTree(
  branches: readonly Branch[],
  favorites: readonly string[] | null,
  tags: readonly string[] = [],
): BranchTreeNode[] {
  const level = (list: { b: Branch; rest: string }[], keyPrefix: string): BranchTreeNode[] => {
    const folders = new Map<string, { b: Branch; rest: string }[]>();
    const leaves: BranchTreeNode[] = [];
    for (const item of list) {
      const i = item.rest.indexOf("/");
      if (i > 0 && i < item.rest.length - 1) {
        const seg = item.rest.slice(0, i);
        folders.set(seg, [...(folders.get(seg) ?? []), { b: item.b, rest: item.rest.slice(i + 1) }]);
      } else {
        leaves.push({
          key: `b:${item.b.name}`,
          label: item.rest,
          kind: "branch",
          ref: item.b.name,
          branch: item.b,
          favorite: isFavoriteBranch(item.b, favorites),
        });
      }
    }
    const byName = (a: BranchTreeNode, b: BranchTreeNode) => a.label.localeCompare(b.label);
    const folderNodes = [...folders]
      .map(([seg, items]): BranchTreeNode => {
        const key = `${keyPrefix}/${seg}`;
        return { key, label: seg, kind: "folder", ref: null, children: level(items, key) };
      })
      .sort(byName);
    // IDEA: current branch, favorites, folders, the rest.
    const rank = (n: BranchTreeNode) => (n.branch?.current ? 0 : n.favorite ? 1 : 2);
    const top = leaves.filter((n) => rank(n) < 2).sort((a, b) => rank(a) - rank(b) || byName(a, b));
    return [...top, ...folderNodes, ...leaves.filter((n) => rank(n) === 2).sort(byName)];
  };
  const local = branches.filter((b) => !b.remote);
  const byRemote = new Map<string, Branch[]>();
  for (const b of branches) {
    if (!b.remote || b.name.endsWith("/HEAD")) continue;
    const i = b.name.indexOf("/");
    const r = i > 0 ? b.name.slice(0, i) : b.name;
    byRemote.set(r, [...(byRemote.get(r) ?? []), b]);
  }
  const out: BranchTreeNode[] = [{ key: "head", label: "HEAD (Current Branch)", kind: "head", ref: "HEAD" }];
  if (local.length)
    out.push({
      key: "g:local",
      label: "Local",
      kind: "group",
      ref: null,
      children: level(
        local.map((b) => ({ b, rest: b.name })),
        "f:local",
      ),
    });
  if (byRemote.size)
    out.push({
      key: "g:remote",
      label: "Remote",
      kind: "group",
      ref: null,
      children: [...byRemote].map(([r, list]) => ({
        key: `r:${r}`,
        label: r,
        kind: "remote",
        ref: null,
        children: level(
          list.map((b) => ({ b, rest: b.name.slice(r.length + 1) })),
          `f:r:${r}`,
        ),
      })),
    });
  if (tags.length)
    out.push({
      key: "g:tags",
      label: "Tags",
      kind: "group",
      ref: null,
      children: [...tags]
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((t): BranchTreeNode => ({ key: `t:${t}`, label: t, kind: "tag", ref: t })),
    });
  return out;
}

/** Local / remote / tag groups contain a subtree for each registered repository. */
export function buildRepositoryBranchTree(
  repositories: readonly { root: string; name: string; branches: Branch[]; tags: string[] }[],
  favorites: readonly string[] | null,
): BranchTreeNode[] {
  const scope = (nodes: BranchTreeNode[], repo: string): BranchTreeNode[] =>
    nodes.map((n) => ({
      ...n,
      repo,
      key: `${repo}:${n.key}`,
      children: n.children && scope(n.children, repo),
    }));
  const trees = repositories.map((r) => ({ ...r, nodes: buildBranchTree(r.branches, favorites, r.tags) }));
  const groups = [
    { key: "g:local", label: "Local" },
    { key: "g:remote", label: "Remote" },
    { key: "g:tags", label: "Tags" },
  ];
  return [
    { key: "head", label: "HEAD (Current Branch)", kind: "head", ref: "HEAD" },
    ...groups.map(({ key, label }): BranchTreeNode => ({
      key,
      label,
      kind: "group",
      ref: null,
      children: trees.map((r) => ({
        key: `${key}:${r.root}`,
        label: r.name,
        kind: "repository",
        ref: null,
        repo: r.root,
        children: scope(r.nodes.find((n) => n.key === key)?.children ?? [], r.root),
      })),
    })),
  ];
}

/** Keys of the nodes on the way to branch `name` (to reveal it). */
export function branchFolderKeys(nodes: readonly BranchTreeNode[], name: string): string[] {
  const walk = (list: readonly BranchTreeNode[]): string[] | null => {
    for (const n of list) {
      if (n.kind === "branch" && n.ref === name) return [];
      const inner = n.children ? walk(n.children) : null;
      if (inner) return [n.key, ...inner];
    }
    return null;
  };
  return walk(nodes) ?? [];
}

/** Branches pane search: keeps branches and tags whose full name contains `query` (case-insensitive) and their folders. */
export function filterBranchTree(nodes: readonly BranchTreeNode[], query: string): BranchTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];
  return nodes.flatMap((n): BranchTreeNode[] => {
    if (n.kind === "head") return [];
    if (n.kind === "branch" || n.kind === "tag") return n.ref?.toLowerCase().includes(q) ? [n] : [];
    const children = filterBranchTree(n.children ?? [], q);
    return children.length ? [{ ...n, children }] : [];
  });
}

/** Keys of every expandable node. */
export function branchGroupKeys(nodes: readonly BranchTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? [n.key, ...branchGroupKeys(n.children)] : []));
}
