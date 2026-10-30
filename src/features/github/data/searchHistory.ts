/**
 * IntelliJ's pull request search history (`GHPRListPersistentSearchHistory`), per project:
 * the last 10 searches (newest first) and the last search used, which the list restores.
 * On first run the list shows the Quick Filter "Assigned to you" (`initialSearch`).
 */
import { useProject } from "@/platform/project";
import { DEFAULT_SEARCH, filterCount, normalizeSearch, sameSearch, type PrSearchValue } from "./model";

const MAX_HISTORY = 10;
const historyKey = (root: string) => `openidea.github.prSearchHistory.v2:${root}`;
const lastKey = (root: string) => `openidea.github.prLastSearch.v2:${root}`;
const projectRoot = () => useProject.getState().project?.root ?? null;

function load(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** `history` with `v` first (moved up when already there). Searches without filters and the default are not kept. */
export function withSearch(history: readonly PrSearchValue[], v: PrSearchValue): PrSearchValue[] {
  if (filterCount(v) === 0 || sameSearch(v, DEFAULT_SEARCH)) return [...history];
  return [v, ...history.filter((h) => !sameSearch(h, v))].slice(0, MAX_HISTORY);
}

/** Recent searches of the project, newest first. */
export function loadSearchHistory(root = projectRoot()): PrSearchValue[] {
  if (!root) return [];
  const v = load(historyKey(root));
  return Array.isArray(v) ? v.flatMap((x) => normalizeSearch(x) ?? []) : [];
}

/**
 * Adds `v` to the history (see `withSearch`).
 * @public
 */
export function rememberSearch(v: PrSearchValue, root = projectRoot()) {
  if (root) save(historyKey(root), withSearch(loadSearchHistory(root), v));
}

/** The search the project's list showed last, if any. */
export function loadLastSearch(root = projectRoot()): PrSearchValue | null {
  return root ? normalizeSearch(load(lastKey(root))) : null;
}

/**
 * Remembers `v` as the search to restore.
 * @public
 */
export function saveLastSearch(v: PrSearchValue, root = projectRoot()) {
  if (root) save(lastKey(root), v);
}

/** The list's search when the tool window opens: the last one, else "Assigned to you". */
export function initialSearch(currentUserLogin: string, root = projectRoot()): PrSearchValue {
  return loadLastSearch(root) ?? { state: "OPEN", assignee: currentUserLogin };
}
