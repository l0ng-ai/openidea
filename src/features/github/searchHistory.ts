/**
 * IDEA's pull request search history: the whole filter (state, Mine, Review requested,
 * text) of recent searches and the last one used, persisted per project.
 */
import type { PrListQuery } from "@/platform/ipc";
import { t } from "@/platform/i18n";

const MAX_HISTORY = 10;
const historyKey = (root: string) => `openidea.github.searchHistory.v1:${root}`;
const lastKey = (root: string) => `openidea.github.lastSearch.v1:${root}`;

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

const STATES = new Set<PrListQuery["state"]>(["open", "closed", "merged", "all"]);

/** A stored query completed from `fallback`, or null when it is not one. */
function validQuery(v: unknown, fallback: PrListQuery): PrListQuery | null {
  const q = v as Partial<PrListQuery> | null;
  if (!q || typeof q !== "object" || !STATES.has(q.state as PrListQuery["state"])) return null;
  return {
    ...fallback,
    state: q.state!,
    authorMe: q.authorMe === true,
    reviewRequested: q.reviewRequested === true,
    assigneeMe: q.assigneeMe === true,
    search: typeof q.search === "string" ? q.search : "",
  };
}

export function sameQuery(a: PrListQuery, b: PrListQuery): boolean {
  return (
    a.state === b.state &&
    a.authorMe === b.authorMe &&
    a.reviewRequested === b.reviewRequested &&
    a.assigneeMe === b.assigneeMe &&
    a.search.trim() === b.search.trim()
  );
}

/** `history` with `q` first (moved up when already there); the default filter is not kept. */
export function withQuery(history: readonly PrListQuery[], q: PrListQuery, defaults: PrListQuery): PrListQuery[] {
  if (sameQuery(q, defaults)) return [...history];
  return [q, ...history.filter((h) => !sameQuery(h, q))].slice(0, MAX_HISTORY);
}

/** IDEA's short text of a search: `state:"Open" author:@me "login"`. */
export function queryText(q: PrListQuery): string {
  const parts = [`state:"${t(`github.prState.${q.state}`)}"`];
  if (q.authorMe) parts.push("author:@me");
  if (q.assigneeMe) parts.push("assignee:@me");
  if (q.reviewRequested) parts.push("review-requested:@me");
  const text = q.search.trim();
  if (text) parts.push(text.includes('"') ? text : `"${text}"`);
  return parts.join(" ");
}

/** Recent searches of the project at `root`, newest first. */
export function loadSearchHistory(root: string | null, defaults: PrListQuery): PrListQuery[] {
  if (!root) return [];
  const v = load(historyKey(root));
  return Array.isArray(v) ? v.flatMap((x) => validQuery(x, defaults) ?? []) : [];
}

export function rememberSearch(root: string | null, q: PrListQuery, defaults: PrListQuery) {
  if (root) save(historyKey(root), withQuery(loadSearchHistory(root, defaults), q, defaults));
}

export function clearSearchHistory(root: string | null) {
  if (root) save(historyKey(root), []);
}

/** The filter the project's list showed last, if any. */
export function loadLastSearch(root: string | null, defaults: PrListQuery): PrListQuery | null {
  return root ? validQuery(load(lastKey(root)), defaults) : null;
}

export function saveLastSearch(root: string | null, q: PrListQuery) {
  if (root) save(lastKey(root), q);
}
