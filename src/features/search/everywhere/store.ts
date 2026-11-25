import { create } from "zustand";
import { getContext, type ContextKeys } from "@/platform/context";
import { projectKey } from "@/platform/search";
import { loadJson, saveJson } from "../common/open";
import type { ProjectFileSet } from "@/platform/ipc";
import type { SeTab } from "./model";
import { DEFAULT_FILTERS, sanitizeFilters, type FilterTab, type SeFilters } from "./filters";

interface SeState {
  open: boolean;
  tab: SeTab;
  query: string;
  includeNonProject: boolean;
  /** Scope of the Classes / Files / Symbols / Text tabs when not "All Places". */
  fileSet: ProjectFileSet;
  /** Context keys captured when the dialog opened (action enablement is judged against the editor, not the popup). */
  ctx: ContextKeys;
  /** Bumped on every (re)open so the field re-selects its text. */
  session: number;
  /** Code preview of the selected result under the list (remembered). */
  preview: boolean;
  /**
   * IDEA's auto "everywhere": while the user hasn't picked a scope, a query
   * with no project results widens to non-project items; `notFound` is that query.
   */
  autoEverywhere: boolean;
  notFound: string | null;
  /** The funnel's per-tab filters (remembered). */
  filters: SeFilters;
}

const PREVIEW_KEY = "openidea.search.everywherePreview.v1";
const FILTERS_KEY = "openidea.search.everywhereFilters.v1";

export const useSearchEverywhere = create<SeState>(() => ({
  open: false,
  tab: "all",
  query: "",
  includeNonProject: false,
  fileSet: "all",
  ctx: {},
  session: 0,
  preview: loadJson<unknown>(PREVIEW_KEY, false) === true,
  autoEverywhere: true,
  notFound: null,
  filters: sanitizeFilters(loadJson<unknown>(FILTERS_KEY, DEFAULT_FILTERS)),
}));

export function setSearchEverywherePreview(preview: boolean) {
  useSearchEverywhere.setState({ preview });
  saveJson(PREVIEW_KEY, preview);
}

export function setSearchEverywhereFilter<T extends FilterTab>(tab: T, value: SeFilters[T]) {
  const filters = { ...useSearchEverywhere.getState().filters, [tab]: value };
  useSearchEverywhere.setState({ filters });
  saveJson(FILTERS_KEY, filters);
}

/**
 * Opens the dialog, or while it is open switches to `tab` (the query is kept);
 * re-invoking the shown tab toggles "include non-project items", like IDEA.
 * Without `query` (an editor selection) the field starts with the tab's last
 * search, so each tab remembers its own text.
 */
export function showSearchEverywhere(tab: SeTab, opts: { query?: string } = {}) {
  const s = useSearchEverywhere.getState();
  if (s.open) {
    if (s.tab === tab) setIncludeNonProject(!s.includeNonProject);
    else selectSearchEverywhereTab(tab);
    return;
  }
  useSearchEverywhere.setState({
    open: true,
    tab,
    query: opts.query ?? searchHistory(tab)[0] ?? "",
    includeNonProject: false,
    autoEverywhere: true,
    notFound: null,
    ctx: { ...getContext(), popupOpen: false },
    session: s.session + 1,
  });
}

/** The user's choice of scope: stops widening automatically. */
export function setIncludeNonProject(includeNonProject: boolean, patch: Partial<SeState> = {}) {
  useSearchEverywhere.setState({ ...patch, includeNonProject, autoEverywhere: false, notFound: null });
}

/** Switching tabs drops an automatically widened scope. */
export function selectSearchEverywhereTab(tab: SeTab, patch: Partial<SeState> = {}) {
  const s = useSearchEverywhere.getState();
  const reset = s.autoEverywhere && s.notFound !== null ? { includeNonProject: false, notFound: null } : {};
  useSearchEverywhere.setState({ ...patch, ...reset, tab });
}

/** Nothing in the project for `query`: search everywhere instead (as IDEA). */
export function widenSearchEverywhere(query: string) {
  const s = useSearchEverywhere.getState();
  if (!s.autoEverywhere || s.includeNonProject || !query.trim()) return;
  useSearchEverywhere.setState({ includeNonProject: true, notFound: query });
}

/** A new query that no longer contains the not-found one narrows back to the project. */
export function onSearchEverywhereQuery(query: string) {
  const s = useSearchEverywhere.getState();
  if (s.notFound === null || !s.autoEverywhere || !s.includeNonProject) return;
  if (s.notFound.length > 1 && query.includes(s.notFound)) return;
  useSearchEverywhere.setState({ includeNonProject: false, notFound: null });
}

/** Closing remembers the text for the shown tab (also when nothing was opened). */
export function hideSearchEverywhere() {
  const s = useSearchEverywhere.getState();
  if (s.open) pushSearchHistory(s.tab, s.query);
  useSearchEverywhere.setState({ open: false });
}

const RECENT_ACTIONS_KEY = "openidea.search.recentActions.v1";
const MAX_RECENT_ACTIONS = 12;

export function recentActions(): string[] {
  const v = loadJson<unknown>(RECENT_ACTIONS_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function pushRecentAction(id: string) {
  saveJson(RECENT_ACTIONS_KEY, [id, ...recentActions().filter((x) => x !== id)].slice(0, MAX_RECENT_ACTIONS));
}

const HISTORY_KEY = "openidea.search.everywhereHistory.v1";
const MAX_HISTORY = 50;

interface HistoryEntry {
  tab: SeTab;
  query: string;
}

/** The open project's history: it names the project's own symbols and files. */
function loadHistory(): HistoryEntry[] {
  const v = loadJson<unknown>(projectKey(HISTORY_KEY), []);
  return Array.isArray(v)
    ? v.filter((x): x is HistoryEntry => typeof x?.tab === "string" && typeof x?.query === "string")
    : [];
}

/** Queries typed in `tab` (opened or left there), newest first. */
export function searchHistory(tab: SeTab): string[] {
  return loadHistory()
    .filter((e) => e.tab === tab)
    .map((e) => e.query);
}

export function pushSearchHistory(tab: SeTab, query: string) {
  const q = query.trim();
  if (!q) return;
  const rest = loadHistory().filter((e) => e.tab !== tab || e.query !== q);
  saveJson(projectKey(HISTORY_KEY), [{ tab, query: q }, ...rest].slice(0, MAX_HISTORY));
}
