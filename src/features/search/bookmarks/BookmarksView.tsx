import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { dirname } from "@/platform/project";
import { shortcutLabel } from "@/platform/keymap";
import { confirm } from "@/workbench/messages";
import { tx, useT, useTx } from "@/platform/i18n";
import { EmptyState, Icon, IconButton, Tree, fileIconName, showContextMenu, type MenuItem } from "@/ui";
import { basename, openLocation, relPath } from "../common/open";
import {
  bookmarkLabel,
  deleteList,
  moveBookmarks,
  setDefaultList,
  updateBookmarkData,
  useBookmarkPopups,
  useBookmarks,
  type Bookmark,
  type BookmarkData,
  type BookmarkList,
  type BookmarkRef,
  type PathBookmark,
} from "./store";
import styles from "./BookmarksView.module.css";

type Node =
  | { kind: "list"; key: string; list: BookmarkList; isDefault: boolean; count: number; children: Node[] }
  | {
      kind: "file";
      key: string;
      list: string;
      path: string;
      name: string;
      dir: string;
      /** The file itself is bookmarked (not only lines in it). */
      bookmarked: boolean;
      children: Node[];
    }
  | { kind: "folder"; key: string; list: string; path: string; name: string; dir: string }
  | { kind: "mark"; key: string; bookmark: Bookmark };

const markKey = (b: Bookmark) => `b:${b.path}:${b.line}`;

function location(path: string): { name: string; dir: string } {
  const rel = relPath(path);
  const name = basename(rel);
  return { name, dir: rel.slice(0, Math.max(0, rel.length - name.length - 1)) };
}

/** One list's nodes: folders, then files (bookmarked files and files with line bookmarks), by path. */
export function groupBookmarks(
  items: readonly Bookmark[],
  paths: readonly PathBookmark[] = [],
  listId?: string,
): Node[] {
  const list = listId ?? "";
  const files = new Map<string, Node & { kind: "file" }>();
  const folders: Array<Node & { kind: "folder" }> = [];
  const file = (path: string) => {
    let f = files.get(path);
    if (!f) {
      f = { kind: "file", key: `f:${list}:${path}`, list, path, ...location(path), bookmarked: false, children: [] };
      files.set(path, f);
    }
    return f;
  };
  for (const p of paths) {
    if (p.dir) folders.push({ kind: "folder", key: `d:${list}:${p.path}`, list, path: p.path, ...location(p.path) });
    else file(p.path).bookmarked = true;
  }
  for (const b of items) file(b.path).children.push({ kind: "mark", key: markKey(b), bookmark: b });
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  return [...folders.sort(byPath), ...[...files.values()].sort(byPath)];
}

export function buildBookmarkTree(data: BookmarkData): Node[] {
  return data.lists.map((list) => {
    const items = data.items.filter((b) => b.list === list.id);
    const paths = data.paths.filter((b) => b.list === list.id);
    return {
      kind: "list",
      key: `l:${list.id}`,
      list,
      isDefault: list.id === data.defaultList,
      count: items.length + paths.length,
      children: groupBookmarks(items, paths, list.id),
    };
  });
}

const refsOf = (n: Node): BookmarkRef[] => {
  switch (n.kind) {
    case "list":
      return [];
    case "mark":
      return [{ path: n.bookmark.path, line: n.bookmark.line }];
    case "folder":
      return [{ path: n.path }];
    case "file":
      return [
        ...(n.bookmarked ? [{ path: n.path }] : []),
        ...n.children.flatMap((c) => (c.kind === "mark" ? [{ path: c.bookmark.path, line: c.bookmark.line }] : [])),
      ];
  }
};

function removeRefs(data: BookmarkData, refs: readonly BookmarkRef[]): BookmarkData {
  const lines = new Set(refs.filter((r) => r.line !== undefined).map((r) => `${r.path}:${r.line}`));
  const paths = new Set(refs.filter((r) => r.line === undefined).map((r) => r.path));
  return {
    ...data,
    items: data.items.filter((b) => !lines.has(`${b.path}:${b.line}`)),
    paths: data.paths.filter((b) => !paths.has(b.path)),
  };
}

async function removeList(list: BookmarkList, count: number) {
  if (
    count &&
    !(await confirm({
      title: "Delete Bookmark List",
      message:
        count === 1
          ? tx`Delete the list '${list.name}' with its ${count} bookmark?`
          : tx`Delete the list '${list.name}' with its ${count} bookmarks?`,
      ok: "Delete",
    }))
  )
    return;
  const scope = useBookmarks.getState().scope;
  updateBookmarkData((d) => deleteList(d, list.id, scope ? basename(scope) : "Bookmarks"));
}

function removeNodes(nodes: Node[]) {
  const list = nodes.find((n) => n.kind === "list");
  if (list?.kind === "list") return void removeList(list.list, list.count);
  updateBookmarkData((d) => removeRefs(d, nodes.flatMap(refsOf)));
}

const newList = (then?: (id: string) => void) => useBookmarkPopups.setState({ naming: { then } });

function moveMenu(targets: Node[], lists: readonly BookmarkList[]): MenuItem[] {
  const refs = targets.flatMap(refsOf);
  const from = new Set(targets.map((n) => (n.kind === "mark" ? n.bookmark.list : n.kind === "list" ? "" : n.list)));
  const move = (to: string) => updateBookmarkData((d) => moveBookmarks(d, refs, to));
  return [
    ...lists.map((l) => ({
      label: l.name,
      verbatim: true,
      disabled: from.size === 1 && from.has(l.id),
      run: () => move(l.id),
    })),
    { kind: "separator" as const },
    { label: "New List…", run: () => newList(move) },
  ];
}

export function BookmarksView() {
  const t = useT();
  const tx = useTx();
  const items = useBookmarks((s) => s.items);
  const paths = useBookmarks((s) => s.paths);
  const lists = useBookmarks((s) => s.lists);
  const defaultList = useBookmarks((s) => s.defaultList);
  const roots = useMemo(
    () => buildBookmarkTree({ items, paths, lists, defaultList }),
    [items, paths, lists, defaultList],
  );
  const byKey = useMemo(() => {
    const m = new Map<string, Node>();
    const walk = (ns: readonly Node[]) =>
      ns.forEach((n) => {
        m.set(n.key, n);
        if (n.kind === "list" || n.kind === "file") walk(n.children);
      });
    walk(roots);
    return m;
  }, [roots]);
  const allKeys = useMemo(
    () => [...byKey.values()].filter((n) => n.kind === "list" || n.kind === "file").map((n) => n.key),
    [byKey],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const expanded = useMemo(() => new Set(allKeys.filter((k) => !collapsed.has(k))), [allKeys, collapsed]);
  const selection = useRef<Set<string>>(new Set());

  if (!items.length && !paths.length && lists.length === 1) {
    return (
      <EmptyState>
        {tx`No bookmarks yet. Toggle a line bookmark with ${shortcutLabel("navigate.toggleBookmark") ?? "F3"}`}
      </EmptyState>
    );
  }

  const open = (n: Node) => {
    if (n.kind === "mark") void openLocation(n.bookmark.path, { line: n.bookmark.line, col: 0 });
    else if (n.kind === "file") void openLocation(n.path);
    else if (n.kind === "folder") void executeAction("navigate.selectInProjectView", n.path);
  };

  const rename = (b: Bookmark) => useBookmarkPopups.setState({ editing: { path: b.path, line: b.line } });
  const renameList = (l: BookmarkList) => useBookmarkPopups.setState({ naming: { listId: l.id } });

  const onKeyDown = (e: KeyboardEvent) => {
    const nodes = [...selection.current].map((k) => byKey.get(k)).filter((n): n is Node => !!n);
    if (e.key === "F2" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const only = nodes.length === 1 ? nodes[0]! : null;
      if (only?.kind === "mark") rename(only.bookmark);
      else if (only?.kind === "list") renameList(only.list);
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!nodes.length) return;
    e.preventDefault();
    e.stopPropagation();
    removeNodes(nodes);
  };

  const listMenu = (n: Node & { kind: "list" }): MenuItem[] => [
    { label: "New List…", icon: "plus", run: () => newList() },
    { label: "Rename List…", shortcut: "F2", run: () => renameList(n.list) },
    {
      label: "Make Default",
      disabled: n.isDefault,
      run: () => updateBookmarkData((d) => setDefaultList(d, n.list.id)),
    },
    { kind: "separator" },
    { label: "Delete List", danger: true, run: () => void removeList(n.list, n.count) },
  ];

  return (
    <div className={styles.root} onKeyDownCapture={onKeyDown}>
      <Tree<Node>
        className={styles.tree}
        aria-label="Bookmarks"
        roots={roots}
        getKey={(n) => n.key}
        getDirectory={(n) =>
          n.kind === "list"
            ? null
            : n.kind === "folder"
              ? n.path
              : dirname(n.kind === "mark" ? n.bookmark.path : n.path)
        }
        getLabel={(n) => (n.kind === "mark" ? bookmarkLabel(n.bookmark) : n.kind === "list" ? n.list.name : n.name)}
        getChildren={(n) => (n.kind === "list" || n.kind === "file" ? n.children : undefined)}
        isExpandable={(n) => n.kind === "list" || (n.kind === "file" && n.children.length > 0)}
        expanded={expanded}
        onExpandedChange={(next) => setCollapsed(new Set(allKeys.filter((k) => !next.has(k))))}
        onSelectionChange={(next) => {
          selection.current = next;
        }}
        onActivate={open}
        onContextMenu={(node, sel, e) => {
          const targets = sel.size
            ? [...sel].map((k) => byKey.get(k)).filter((n): n is Node => !!n)
            : node
              ? [node]
              : [];
          if (!targets.length || !node) return;
          e.preventDefault();
          if (node.kind === "list" && targets.length === 1) return showContextMenu(e, listMenu(node));
          const bookmarks = targets.filter((t) => t.kind !== "list");
          showContextMenu(e, [
            ...(node.kind !== "list" && node.kind !== "folder"
              ? [{ label: "Jump to Source", run: () => open(node) }]
              : []),
            ...(node.kind === "mark" && targets.length === 1
              ? [{ label: "Rename…", shortcut: "F2", run: () => rename(node.bookmark) }]
              : []),
            ...(bookmarks.length ? [{ label: "Move to Another List", submenu: moveMenu(bookmarks, lists) }] : []),
            { kind: "separator" as const },
            {
              label: targets.length > 1 ? tx`Delete ${targets.length} Bookmarks` : "Delete Bookmark",
              danger: true,
              run: () => removeNodes(targets),
            },
          ]);
        }}
        renderNode={(n) => {
          switch (n.kind) {
            case "list":
              return (
                <span className={styles.node}>
                  <Icon name="toolwindow-bookmarks" size={16} className={styles.icon} />
                  <span className={clsx(styles.label, n.isDefault && styles.defaultList)}>{n.list.name}</span>
                  <span className={styles.meta}>
                    {t("search.bookmarks.count", { count: n.count })}
                    {n.isDefault ? tx(" · default") : ""}
                  </span>
                </span>
              );
            case "folder":
              return (
                <span className={styles.node}>
                  <Icon name="folder" size={16} className={styles.icon} />
                  <span className={styles.label}>{n.name}</span>
                  <span className={styles.meta}>{n.dir}</span>
                </span>
              );
            case "file":
              return (
                <span className={styles.node}>
                  <Icon name={fileIconName(n.name)} size={16} className={styles.icon} />
                  <span className={styles.label}>{n.name}</span>
                  {n.bookmarked && <Icon name="bookmark" size={12} className={styles.icon} label="Bookmarked file" />}
                  <span className={styles.meta}>{n.dir}</span>
                </span>
              );
            case "mark":
              return (
                <span className={styles.node}>
                  {n.bookmark.mnemonic ? (
                    <span className={styles.mnemonic} aria-label={`Mnemonic ${n.bookmark.mnemonic}`}>
                      {n.bookmark.mnemonic}
                    </span>
                  ) : (
                    <Icon name="bookmark" size={16} className={styles.icon} />
                  )}
                  {n.bookmark.description ? (
                    <>
                      <span className={styles.label}>{n.bookmark.description}</span>
                      <span className={styles.meta}>
                        {basename(n.bookmark.path)}:{n.bookmark.line + 1}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={styles.label}>
                        {basename(n.bookmark.path)}:{n.bookmark.line + 1}
                      </span>
                      <span className={styles.code}>{n.bookmark.text.trim() || tx("(empty line)")}</span>
                    </>
                  )}
                </span>
              );
          }
        }}
      />
    </div>
  );
}

export function BookmarksActions() {
  const count = useBookmarks((s) => s.items.length + s.paths.length);
  return (
    <>
      <IconButton icon="plus" title="New Bookmark List…" size="small" onClick={() => newList()} />
      {count > 0 && (
        <IconButton
          icon="trash"
          title="Remove All Bookmarks"
          size="small"
          onClick={() => updateBookmarkData((d) => ({ ...d, items: [], paths: [] }))}
        />
      )}
    </>
  );
}
