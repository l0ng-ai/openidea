/**
 * Bookmarks, persisted per project in localStorage: line bookmarks (F3) and
 * file / folder bookmarks, kept in named bookmark lists (one is the default
 * that new bookmarks go to). A line bookmark may carry a mnemonic (0-9 / A-Z,
 * unique: ⌥F3, ⌃⇧digit) and a description.
 */
import { create } from "zustand";
import { loadJson, saveJson } from "../common/open";

export interface Bookmark {
  path: string;
  /** 0-based. */
  line: number;
  /** Line text when the bookmark was set / last moved. */
  text: string;
  created: number;
  /** `0`-`9` or `A`-`Z`; at most one bookmark has each. */
  mnemonic?: string;
  /** User text shown instead of the line (F3 on a selection, Rename). */
  description?: string;
  /** Id of its bookmark list; unset until stored (then the default list). */
  list?: string;
}

/** A bookmarked file or folder (project view / editor tab). */
export interface PathBookmark {
  path: string;
  dir: boolean;
  list: string;
  created: number;
}

export interface BookmarkList {
  id: string;
  name: string;
}

export const MNEMONICS = [..."1234567890", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

export function isMnemonic(c: unknown): c is string {
  return typeof c === "string" && /^[0-9A-Z]$/.test(c);
}

const KEY_PREFIX = "openidea.bookmarks.v1:";
/** Lists and file / folder bookmarks; line bookmarks stay under `KEY_PREFIX` (readable by older versions). */
const LISTS_PREFIX = "openidea.bookmarkLists.v1:";
export const DEFAULT_LIST_ID = "default";

// --- pure helpers -----------------------------------------------------------

export function sortBookmarks(list: readonly Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function hasBookmark(list: readonly Bookmark[], path: string, line: number): boolean {
  return list.some((b) => b.path === path && b.line === line);
}

export function bookmarkAt(list: readonly Bookmark[], path: string, line: number): Bookmark | undefined {
  return list.find((b) => b.path === path && b.line === line);
}

const clip = (text: string) => text.trim().slice(0, 200);

/** F3: removes the line's bookmark or adds one (`description`: the selected text, as IDEA). */
export function toggleBookmark(
  list: readonly Bookmark[],
  path: string,
  line: number,
  text: string,
  now = Date.now(),
  description?: string | null,
): Bookmark[] {
  if (hasBookmark(list, path, line)) return list.filter((b) => !(b.path === path && b.line === line));
  const b: Bookmark = { path, line, text: clip(text), created: now };
  if (description?.trim()) b.description = clip(description);
  return sortBookmarks([...list, b]);
}

/**
 * Gives the line's bookmark (created if needed) `mnemonic`, taking it from any
 * other bookmark; `null` turns it into a plain bookmark. `description` replaces
 * the description when given (empty clears it).
 */
export function assignMnemonic(
  list: readonly Bookmark[],
  path: string,
  line: number,
  text: string,
  mnemonic: string | null,
  description?: string,
  now = Date.now(),
): Bookmark[] {
  const here = (b: Bookmark) => b.path === path && b.line === line;
  const out = list.filter((b) => !here(b)).map((b) => (mnemonic && b.mnemonic === mnemonic ? withoutMnemonic(b) : b));
  const b: Bookmark = { ...(list.find(here) ?? { path, line, text: clip(text), created: now }) };
  if (mnemonic) b.mnemonic = mnemonic;
  else delete b.mnemonic;
  if (description !== undefined) {
    if (description.trim()) b.description = clip(description);
    else delete b.description;
  }
  return sortBookmarks([...out, b]);
}

function withoutMnemonic(b: Bookmark): Bookmark {
  const { mnemonic: _, ...rest } = b;
  return rest;
}

/** ⌃⇧digit: the line already has `mnemonic` → remove the bookmark; otherwise assign it. */
export function toggleMnemonic(
  list: readonly Bookmark[],
  path: string,
  line: number,
  text: string,
  mnemonic: string,
): Bookmark[] {
  if (bookmarkAt(list, path, line)?.mnemonic === mnemonic)
    return list.filter((b) => !(b.path === path && b.line === line));
  return assignMnemonic(list, path, line, text, mnemonic);
}

export function bookmarkByMnemonic(list: readonly Bookmark[], mnemonic: string): Bookmark | undefined {
  return list.find((b) => b.mnemonic === mnemonic);
}

/** Rename (F2 in the Bookmarks view): an empty description shows the line again. */
export function describeBookmark(
  list: readonly Bookmark[],
  path: string,
  line: number,
  description: string,
): Bookmark[] {
  return list.map((b) => {
    if (b.path !== path || b.line !== line) return b;
    const { description: _, ...rest } = b;
    return description.trim() ? { ...rest, description: clip(description) } : rest;
  });
}

/** What the Bookmarks view and popup show for a bookmark. */
export function bookmarkLabel(b: Bookmark): string {
  return b.description?.trim() || b.text.trim();
}

export function removeBookmarks(list: readonly Bookmark[], pred: (b: Bookmark) => boolean): Bookmark[] {
  return list.filter((b) => !pred(b));
}

export function renameBookmarks(list: readonly Bookmark[], from: string, to: string | null): Bookmark[] {
  const out: Bookmark[] = [];
  for (const b of list) {
    if (b.path === from || b.path.startsWith(from + "/")) {
      if (to !== null) out.push({ ...b, path: to + b.path.slice(from.length) });
    } else out.push(b);
  }
  return sortBookmarks(out);
}

export function linesOf(list: readonly Bookmark[], path: string): number[] {
  return list
    .filter((b) => b.path === path)
    .map((b) => b.line)
    .sort((a, b) => a - b);
}

/** Lines of `path`'s bookmarks with their mnemonics (gutter), sorted by line. */
export function marksOf(list: readonly Bookmark[], path: string): Array<{ line: number; mnemonic: string | null }> {
  return list
    .filter((b) => b.path === path)
    .map((b) => ({ line: b.line, mnemonic: b.mnemonic ?? null }))
    .sort((a, b) => a.line - b.line);
}

function sanitize(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  return sortBookmarks(
    raw
      .filter(
        (b): b is Bookmark =>
          !!b &&
          typeof b === "object" &&
          typeof (b as Bookmark).path === "string" &&
          Number.isInteger((b as Bookmark).line),
      )
      .map((b) => {
        const out: Bookmark = {
          path: b.path,
          line: Math.max(0, b.line),
          text: String(b.text ?? ""),
          created: Number(b.created) || 0,
        };
        if (isMnemonic(b.mnemonic)) out.mnemonic = b.mnemonic;
        if (typeof b.description === "string" && b.description.trim()) out.description = b.description;
        if (typeof b.list === "string" && b.list) out.list = b.list;
        return out;
      }),
  );
}

// --- lists -------------------------------------------------------------------

/** Everything persisted for a project. */
export interface BookmarkData {
  items: Bookmark[];
  paths: PathBookmark[];
  lists: BookmarkList[];
  defaultList: string;
}

export function pathBookmarkAt(paths: readonly PathBookmark[], path: string): PathBookmark | undefined {
  return paths.find((b) => b.path === path);
}

/** Adds `targets` to the default list, or removes them all when every one is bookmarked already. */
export function togglePathBookmarks(
  data: BookmarkData,
  targets: ReadonlyArray<{ path: string; dir: boolean }>,
  now = Date.now(),
): BookmarkData {
  if (!targets.length) return data;
  const all = targets.every((t) => pathBookmarkAt(data.paths, t.path));
  const set = new Set(targets.map((t) => t.path));
  if (all) return { ...data, paths: data.paths.filter((b) => !set.has(b.path)) };
  const added = targets
    .filter((t) => !pathBookmarkAt(data.paths, t.path))
    .map((t) => ({ path: t.path, dir: t.dir, list: data.defaultList, created: now }));
  return { ...data, paths: sortPaths([...data.paths, ...added]) };
}

function sortPaths(list: readonly PathBookmark[]): PathBookmark[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path));
}

function newListId(lists: readonly BookmarkList[]): string {
  for (let i = lists.length + 1; ; i++) if (!lists.some((l) => l.id === `list${i}`)) return `list${i}`;
}

/** Error text for a proposed list name, or null when valid. */
export function validateListName(lists: readonly BookmarkList[], name: string, ownId?: string): string | null {
  const n = name.trim();
  if (!n) return "Name cannot be empty";
  return lists.some((l) => l.id !== ownId && l.name === n) ? `A list named '${n}' already exists` : null;
}

export function createList(data: BookmarkData, name: string): { data: BookmarkData; id: string } {
  const id = newListId(data.lists);
  return { id, data: { ...data, lists: [...data.lists, { id, name: name.trim() }] } };
}

export function renameList(data: BookmarkData, id: string, name: string): BookmarkData {
  return { ...data, lists: data.lists.map((l) => (l.id === id ? { ...l, name: name.trim() } : l)) };
}

export function setDefaultList(data: BookmarkData, id: string): BookmarkData {
  return data.lists.some((l) => l.id === id) ? { ...data, defaultList: id } : data;
}

/** Deletes a list with its bookmarks; the default moves to the first remaining list (a fresh one when none). */
export function deleteList(data: BookmarkData, id: string, fallbackName: string): BookmarkData {
  const lists = data.lists.filter((l) => l.id !== id);
  const next: BookmarkData = {
    items: data.items.filter((b) => b.list !== id),
    paths: data.paths.filter((b) => b.list !== id),
    lists: lists.length ? lists : [{ id: DEFAULT_LIST_ID, name: fallbackName }],
    defaultList: data.defaultList,
  };
  if (!next.lists.some((l) => l.id === next.defaultList)) next.defaultList = next.lists[0]!.id;
  return next;
}

/** Identifies a bookmark for moving: a line (`path` + `line`) or a file / folder (`path`). */
export type BookmarkRef = { path: string; line?: number };

export function moveBookmarks(data: BookmarkData, refs: readonly BookmarkRef[], to: string): BookmarkData {
  if (!data.lists.some((l) => l.id === to)) return data;
  const lines = new Set(refs.filter((r) => r.line !== undefined).map((r) => `${r.path}\u0000${r.line}`));
  const paths = new Set(refs.filter((r) => r.line === undefined).map((r) => r.path));
  return {
    ...data,
    items: data.items.map((b) => (lines.has(`${b.path}\u0000${b.line}`) ? { ...b, list: to } : b)),
    paths: data.paths.map((b) => (paths.has(b.path) ? { ...b, list: to } : b)),
  };
}

export function renamePathBookmarks(list: readonly PathBookmark[], from: string, to: string | null): PathBookmark[] {
  const out: PathBookmark[] = [];
  for (const b of list) {
    if (b.path === from || b.path.startsWith(from + "/")) {
      if (to !== null) out.push({ ...b, path: to + b.path.slice(from.length) });
    } else out.push(b);
  }
  return sortPaths(out);
}

function sanitizeData(raw: unknown, items: Bookmark[], projectName: string): BookmarkData {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const lists: BookmarkList[] = [];
  for (const l of Array.isArray(o.lists) ? o.lists : []) {
    const id = (l as BookmarkList | null)?.id;
    const name = (l as BookmarkList | null)?.name;
    if (typeof id === "string" && id && typeof name === "string" && !lists.some((x) => x.id === id))
      lists.push({ id, name: name.trim() || id });
  }
  if (!lists.length) lists.push({ id: DEFAULT_LIST_ID, name: projectName });
  const ids = new Set(lists.map((l) => l.id));
  const defaultList = typeof o.defaultList === "string" && ids.has(o.defaultList) ? o.defaultList : lists[0]!.id;
  const paths = (Array.isArray(o.paths) ? o.paths : [])
    .filter((b): b is PathBookmark => !!b && typeof b === "object" && typeof (b as PathBookmark).path === "string")
    .map((b) => ({
      path: b.path,
      dir: b.dir === true,
      list: typeof b.list === "string" && ids.has(b.list) ? b.list : defaultList,
      created: Number(b.created) || 0,
    }));
  return {
    // Bookmarks saved before lists existed belong to the default list.
    items: items.map((b) => (b.list && ids.has(b.list) ? b : { ...b, list: defaultList })),
    paths: sortPaths(paths),
    lists,
    defaultList,
  };
}

// --- store ------------------------------------------------------------------

interface BookmarksState extends BookmarkData {
  scope: string | null;
}

const projectName = (scope: string) => scope.slice(scope.lastIndexOf("/") + 1) || scope;

const EMPTY: BookmarkData = {
  items: [],
  paths: [],
  lists: [{ id: DEFAULT_LIST_ID, name: "Bookmarks" }],
  defaultList: DEFAULT_LIST_ID,
};

export const useBookmarks = create<BookmarksState>(() => ({ scope: null, ...EMPTY }));

export function loadBookmarks(scope: string | null) {
  if (!scope) return useBookmarks.setState({ scope, ...EMPTY });
  const items = sanitize(loadJson<unknown>(KEY_PREFIX + scope, []));
  useBookmarks.setState({
    scope,
    ...sanitizeData(loadJson<unknown>(LISTS_PREFIX + scope, null), items, projectName(scope)),
  });
}

/** Changes lists / file bookmarks (and line bookmarks); new line bookmarks go to the default list. */
export function updateBookmarkData(fn: (data: BookmarkData) => BookmarkData) {
  const { scope, items, paths, lists, defaultList } = useBookmarks.getState();
  const prev: BookmarkData = { items, paths, lists, defaultList };
  const next = fn(prev);
  if (next === prev) return;
  const filled = next.items.some((b) => !b.list)
    ? next.items.map((b) => (b.list ? b : { ...b, list: next.defaultList }))
    : next.items;
  useBookmarks.setState({ ...next, items: filled });
  if (!scope) return;
  if (filled !== items) saveJson(KEY_PREFIX + scope, filled);
  if (next.paths !== paths || next.lists !== lists || next.defaultList !== defaultList)
    saveJson(LISTS_PREFIX + scope, { lists: next.lists, defaultList: next.defaultList, paths: next.paths });
}

export function updateBookmarks(fn: (list: readonly Bookmark[]) => Bookmark[]) {
  updateBookmarkData((data) => {
    const items = fn(data.items);
    return items === data.items ? data : { ...data, items };
  });
}

// --- popups -----------------------------------------------------------------

export interface MnemonicTarget {
  path: string;
  line: number;
  /** Line text, for a bookmark created by the chooser. */
  text: string;
  /** Where to show the chooser (the caret); centred without. */
  at?: { x: number; y: number };
}

interface BookmarkPopupsState {
  /** ⌥F3: the mnemonic chooser for this line. */
  chooser: MnemonicTarget | null;
  /** ⌘F3: the Bookmarks popup. */
  list: boolean;
  /** Edit Description dialog (F2 in the Bookmarks view / popup). */
  editing: { path: string; line: number } | null;
  /** New / rename bookmark list dialog; `then` receives the new list's id. */
  naming: { listId?: string; then?: (id: string) => void } | null;
}

export const useBookmarkPopups = create<BookmarkPopupsState>(() => ({
  chooser: null,
  list: false,
  editing: null,
  naming: null,
}));
