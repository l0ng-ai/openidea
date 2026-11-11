/** Git log tool window state: filters, paged commits, graph, selection. */
import { branchesByRepo, commitKey, commitRepo, mergeRepoLogs, type RepoCommit } from "./multiRoot";
import { create } from "zustand";
import { useContext } from "react";
import { LogIdContext } from "./logContext";
import { setContext } from "@/platform/context";
import { maybeEditorService } from "@/workbench/contributions";
import type { Branch, BranchInfo, Commit, LogQuery } from "@/bindings";
import { call, commands, nextRequestId, type RequestId } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { logOptions, parseLogOptions, setLogOptions, useLogOptions, type LogOptions } from "./logOptions";
import { clearConsole, errorMessage } from "./ops";
import { currentRepo, currentRepoRoot, repoName, repoOf, useVcs } from "./store";
import { chooseLogCommit } from "./CommitChooser";
import { presentLogGraph } from "./logPresentation";
import { toggleBookmark, updateBookmarks, useBookmarks } from "@/features/search/bookmarks/store";
import { commitBookmarkPath, parseCommitBookmark } from "./logBookmarks";
import { stripSlash } from "./model";

/** Date filter: commits made (committer time) after / before the given times (epoch ms). */
export interface LogDateFilter {
  after: number | null;
  before: number | null;
  label: string;
}

/** User filter entry standing for the current Git user (`user.name` / `user.email`). */
export const ME = "me";

export interface LogFilters {
  /** Branches / revisions to show; empty = all. */
  branches: string[];
  repositories?: string[];
  /** Author names or emails (any matches); `ME` = the current user. */
  authors: string[];
  text: string;
  /** `text` is a regular expression / matches case-sensitively. */
  regex: boolean;
  matchCase: boolean;
  /** Absolute path (file or directory). */
  path: string | null;
  paths?: string[];
  range?: string | null;
  date: LogDateFilter | null;
}

interface LogState {
  filters: LogFilters;
  commits: RepoCommit[];
  loading: boolean;
  done: boolean;
  error: string | null;
  /** Lead selection. */
  selected: string | null;
  /** Every selected commit id (includes `selected`), in selection order. */
  selection: string[];
  /** Commits of HEAD not on its upstream (`@{u}..HEAD`); null without an upstream. */
  outgoing: Set<string> | null;
  tracked: Set<string>;
  /** Content tab of the Git tool window (a `GitTab`, or the id of a log tab). */
  tab: string;
  /** Closable log tabs (History: file, Log: branch) next to the main Log. */
  logTabs: LogTab[];
  /** The log tab whose commits / filters / selection the store holds ("log" or a `logTabs` id). */
  shownLog: string;
  /** Repository whose branch filter is settled (default or chosen); null until then. */
  branchScope: string | null;
  /** Bumped to ask the list to scroll the selection into view. */
  revealTick: number;
  /** The current user (`user.email`, else `user.name`), for View Options › Highlight › My Commits. */
  user: string | null;
  generation: number;
  viewsVersion: number;
  seek: { repo: string | null; id: string } | null;
  bookmarks: Record<string, string>;
  fragments: LogFragments;
}

interface LogFragments {
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  merges: ReadonlySet<string>;
}

const emptyFragments = (): LogFragments => ({ expanded: new Set(), collapsed: new Set(), merges: new Set() });

function parseFragments(value: unknown): LogFragments {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const ids = (value: unknown) =>
    new Set((Array.isArray(value) ? (value as unknown[]) : []).filter((id): id is string => typeof id === "string"));
  return { expanded: ids(raw.expanded), collapsed: ids(raw.collapsed), merges: ids(raw.merges) };
}

/** A log tab of its own (IDEA's "History: file" / "Log: branch" tabs): its own filters and view. */
export interface LogTab {
  id: string;
  kind: "history" | "branch" | "log" | "external";
  /** What it shows (the file path or the branch); opening the same again selects the tab. */
  target: string;
  repo?: string | null;
  repositories?: string[];
  location?: "toolWindow" | "editor";
  readOnly?: boolean;
}

export const PAGE = 300;

export const emptyFilters = (): LogFilters => ({
  branches: [],
  authors: [],
  text: "",
  regex: false,
  matchCase: false,
  path: null,
  date: null,
});

/** The Repository filter after clicking `repo`: added when unchecked, removed when checked (none = all). */
export function toggleRepository(selected: readonly string[] | undefined, repo: string): string[] {
  const cur = selected ?? [];
  return cur.includes(repo) ? cur.filter((r) => r !== repo) : [...cur, repo];
}

/** Any filter other than the text field's toggles is set. */
export function hasFilters(f: LogFilters): boolean {
  return !!(
    f.repositories?.length ||
    f.branches.length ||
    f.authors.length ||
    f.text ||
    f.path ||
    f.paths?.length ||
    f.range ||
    f.date
  );
}

/** `ME` replaced by the current user's email (or name); duplicates and blanks dropped. */
export function resolveAuthors(authors: readonly string[], me: string | null): string[] {
  const out = authors.map((a) => (a === ME ? (me ?? "") : a).trim()).filter(Boolean);
  return [...new Set(out)];
}

/** The commit's time falls inside the date filter. */
export function inDateRange(timeMs: number, d: LogDateFilter | null): boolean {
  if (!d) return true;
  return (d.after == null || timeMs >= d.after) && (d.before == null || timeMs < d.before);
}

/** Label of a custom date range: `after 2024-01-01`, `until …`, or `a – b` (`before` is exclusive). */
export function dateRangeLabel(after: number | null, before: number | null): string {
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const lastDay = (ms: number) => day(new Date(ms).setDate(new Date(ms).getDate() - 1));
  if (after != null && before != null) return `${day(after)} – ${lastDay(before)}`;
  if (after != null) return `after ${day(after)}`;
  if (before != null) return `until ${lastDay(before)}`;
  return "";
}

let me: { repo: string | null; value: Promise<string | null> } | null = null;

/** The current Git user for the "me" filter: `user.email`, else `user.name`. */
function currentUser(): Promise<string | null> {
  const repo = currentRepo();
  if (me?.repo !== repo) {
    const get = (key: string) => call(commands.vcsConfigGet(repo, key)).catch(() => null);
    me = { repo, value: get("user.email").then(async (email) => email || (await get("user.name"))) };
  }
  return me.value;
}

const initialLog = (): Omit<LogState, "generation" | "viewsVersion"> => ({
  filters: emptyFilters(),
  seek: null,
  commits: [],
  loading: false,
  done: false,
  error: null,
  selected: null,
  selection: [],
  outgoing: null,
  tracked: new Set(),
  tab: "log",
  logTabs: [],
  shownLog: "log",
  branchScope: null,
  revealTick: 0,
  user: null,
  bookmarks: {},
  fragments: emptyFragments(),
});

export const useRootGitLog = create<LogState>(() => ({ ...initialLog(), generation: 0, viewsVersion: 0 }));
export const useGitLog = Object.assign(function useScopedGitLog<T>(selector: (state: LogState) => T): T {
  const id = useContext(LogIdContext);
  return useRootGitLog((state) => selector(id && state.shownLog !== id ? { ...state, ...parked.get(id) } : state));
}, useRootGitLog);

/**
 * The refs the log shows: the remembered ones that still exist, else `HEAD` (the
 * current branch, followed across checkouts). An empty list is a real choice: all branches.
 */
export function resolveLogBranches(remembered: readonly string[] | undefined, branches: readonly string[]): string[] {
  if (remembered === undefined) return ["HEAD"];
  if (!remembered.length) return [];
  const valid = remembered.filter((ref) => ref === "HEAD" || branches.includes(ref));
  return valid.length ? valid : ["HEAD"];
}

const branchMemoryKey = (repo: string) => `openidea.vcs.logBranches:${repo}`;

/** The main Log's branch filter last chosen for `repo`; undefined when none was. */
export function rememberedLogBranches(repo: string): string[] | undefined {
  try {
    const raw = localStorage.getItem(branchMemoryKey(repo));
    const v: unknown = raw ? JSON.parse(raw) : undefined;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

function rememberLogBranches(repo: string, branches: readonly string[]) {
  try {
    localStorage.setItem(branchMemoryKey(repo), JSON.stringify(branches));
  } catch {
    // Storage unavailable: the choice lasts for the session only.
  }
}

/**
 * Settles the main Log's branch filter for the selected repository: its last
 * choice, else the current branch. False when it was already settled.
 */
export function initLogBranchFilter(): boolean {
  const s = useGitLog.getState();
  if (useVcs.getState().roots.length > 1) return false;
  const repo = currentRepoRoot();
  if (s.shownLog !== "log" || !repo || s.branchScope === repo) return false;
  const names = useVcs
    .getState()
    .branches.filter((b) => !b.name.endsWith("/HEAD"))
    .map((b) => b.name);
  const next = resolveLogBranches(rememberedLogBranches(repo), names);
  useGitLog.setState({ filters: { ...s.filters, branches: next }, branchScope: repo });
  return true;
}

/** The Branch filter's setter: a choice in the main Log is remembered for the repository. */
export function setLogBranches(branches: readonly string[]) {
  useGitLog.setState({ seek: null });
  const ranges = branches.filter((b) => b.includes(".."));
  const s = useGitLog.getState();
  rememberRecentFilters(s.filters);
  const repo = s.shownLog === "log" ? currentRepoRoot() : null;
  useGitLog.setState({
    filters: {
      ...s.filters,
      branches: branches.filter((b) => !b.includes("..")),
      range: ranges.length ? ranges.join("\n") : null,
    },
    ...(repo ? { branchScope: repo } : {}),
  });
  if (repo) rememberLogBranches(repo, branches);
  void reloadLog();
}

const loadPromises = new Map<string, Promise<void>>();
const pageRequests = new Map<string, Set<RequestId>>();
let generationSequence = 0;
const nextGeneration = () => (generationSequence = Math.max(generationSequence, useGitLog.getState().generation) + 1);

function cancelLogRequests(id?: string) {
  for (const [view, requests] of pageRequests) {
    if (id && view !== id) continue;
    for (const request of requests) void commands.cancelRequest(request).catch(() => undefined);
    requests.clear();
    loadPromises.delete(view);
  }
}

/** What a log tab shows: the store fields swapped in and out when another log tab is selected. */
type LogView = Pick<
  LogState,
  | "filters"
  | "seek"
  | "commits"
  | "loading"
  | "done"
  | "error"
  | "selected"
  | "selection"
  | "revealTick"
  | "fragments"
  | "generation"
> & { options: LogOptions };

function freshView(filters: LogFilters): LogView {
  const { commits, loading, done, error, selected, selection, revealTick, fragments } = initialLog();
  return {
    filters,
    seek: null,
    commits,
    loading,
    done,
    error,
    selected,
    selection,
    revealTick,
    fragments,
    options: logOptions(),
    generation: nextGeneration(),
  };
}

/** Views of the log tabs not shown now. */
const parked = new Map<string, LogView>();

function currentView(): LogView {
  const { filters, commits, done, error, selected, selection, revealTick, fragments, loading, generation, seek } =
    useGitLog.getState();
  return {
    filters,
    commits,
    loading,
    seek,
    generation,
    done,
    error,
    selected,
    selection,
    revealTick,
    fragments,
    options: logOptions(),
  };
}

export const isLogTab = (id: string, tabs: readonly LogTab[] = useGitLog.getState().logTabs) =>
  id === "log" || tabs.some((t) => t.id === id);

export function logState(id = useGitLog.getState().shownLog): LogState {
  const state = useGitLog.getState();
  return id === state.shownLog ? state : { ...state, ...parked.get(id), shownLog: id };
}

function setViewState(id: string, patch: Partial<LogState> | ((state: LogState) => Partial<LogState>)) {
  const update = typeof patch === "function" ? patch(logState(id)) : patch;
  if (id === useGitLog.getState().shownLog) useGitLog.setState(update);
  else if (parked.has(id)) {
    parked.set(id, { ...parked.get(id)!, ...update });
    useGitLog.setState((s) => ({ viewsVersion: s.viewsVersion + 1 }));
  }
}

/** Puts the view of log tab `id` into the store, parking the one shown. */
function showLogView(id: string) {
  const s = useGitLog.getState();
  if (s.shownLog === id) return;
  parked.set(s.shownLog, currentView());
  const view = parked.get(id) ?? freshView(emptyFilters());
  parked.delete(id);
  const { options, ...state } = view;
  setLogOptions(options);
  useGitLog.setState({ ...state, shownLog: id });
  if (!view.commits.length) void reloadLog();
}

export const focusLogView = (id: string) => showLogView(id);
export const parkedLogOptions = (id: string): LogOptions | undefined => parked.get(id)?.options;

export function ensureEditorLog(id: string, label: string) {
  if (useGitLog.getState().logTabs.some((t) => t.id === id)) return;
  parked.set(id, freshView(emptyFilters()));
  useGitLog.setState((s) => ({ logTabs: [...s.logTabs, { id, kind: "log", target: label, location: "editor" }] }));
}

/** Selects a content tab of the Git tool window; a log tab brings its own filters and commits. */
export function selectGitTab(id: string) {
  if (isLogTab(id)) showLogView(id);
  useGitLog.setState({ tab: id });
}

let tabSeq = 0;

/**
 * The repository whose history Show History lists: a repository's own root (a submodule
 * folder included) is its own history, as in IDEA, not the folder's history in the
 * enclosing repository; any other path belongs to the innermost repository containing it.
 */
function historyRepo(target: string): string | null {
  const roots = useVcs.getState().roots;
  const path = stripSlash(target);
  return roots.includes(path) ? path : repoOf(target);
}

/**
 * Opens (or selects) a log tab of its own, leaving the main Log and its filters as
 * they are: Show History for a file, Show Git Log for a branch.
 */
export function openLogTab(
  kind: LogTab["kind"],
  target: string,
  location: LogTab["location"] = "toolWindow",
  repositories?: string[],
): string {
  const active = useGitLog.getState().logTabs.find((t) => t.id === useGitLog.getState().shownLog);
  repositories ??=
    (kind === "log" || kind === "branch") && active?.readOnly
      ? (active.repositories ?? (active.repo ? [active.repo] : undefined))
      : undefined;
  const repo =
    kind === "external"
      ? target
      : kind === "history"
        ? (historyRepo(target) ??
          active?.repositories?.find((repo) => target === repo || target.startsWith(`${repo}/`)) ??
          (active?.repo && target.startsWith(`${active.repo}/`) ? active.repo : null))
        : (active?.repo ?? (kind === "log" ? null : currentRepoRoot()));
  const existing =
    kind !== "log" &&
    useGitLog
      .getState()
      .logTabs.find(
        (t) =>
          t.kind === kind &&
          (kind === "external" && repositories?.length
            ? JSON.stringify([...(t.repositories ?? (t.repo ? [t.repo] : []))].sort()) ===
              JSON.stringify([...repositories].sort())
            : t.target === target && t.repo === repo),
      );
  if (existing) {
    selectGitTab(existing.id);
    return existing.id;
  }
  const id = `${kind}:${++tabSeq}`;
  const filters =
    kind === "log"
      ? { ...useGitLog.getState().filters }
      : {
          ...emptyFilters(),
          ...(kind === "history" ? { path: target } : kind === "branch" ? { branches: [target] } : {}),
        };
  parked.set(id, freshView(filters));
  useGitLog.setState((s) => ({
    logTabs: [
      ...s.logTabs,
      {
        id,
        kind,
        target,
        repo: repositories?.length ? null : repo,
        repositories,
        location,
        readOnly: kind === "external" || active?.readOnly === true,
      },
    ],
  }));
  if (location === "editor" && maybeEditorService()) {
    showLogView(id);
    void maybeEditorService()!.openInput({ kind: "git-log", key: `git-log:${id}`, data: { id, label: target } });
  } else selectGitTab(id);
  return id;
}

/** Closes a log tab; when it was shown, the main Log comes back. */
export function closeLogTab(id: string) {
  const s = useGitLog.getState();
  if (!s.logTabs.some((t) => t.id === id)) return;
  if (s.shownLog === id) showLogView("log");
  cancelLogRequests(id);
  parked.delete(id);
  useGitLog.setState((l) => ({
    logTabs: l.logTabs.filter((t) => t.id !== id),
    tab: l.tab === id ? "log" : l.tab,
  }));
}

/**
 * Another project (the window switched projects): forget its commits, filters, selection
 * and console. Repository selection does not change the log or its history tabs.
 */
export function installGitLog(): () => void {
  const trackFocus = (event: FocusEvent) =>
    setContext("vcsLogFocus", event.target instanceof Element && !!event.target.closest("[data-git-log]"));
  document.addEventListener("focusin", trackFocus);
  restoreLogSession(useVcs.getState().root);
  const unsubscribeLog = useGitLog.subscribe(() => saveLogSession(useVcs.getState().root));
  const unsubscribeOptions = useLogOptions.subscribe(() => saveLogSession(useVcs.getState().root));
  const migratedBookmarks = new Set<string>();
  const syncBookmarks = () => {
    const root = useVcs.getState().root;
    if (useBookmarks.getState().scope !== root) return;
    if (root && !migratedBookmarks.has(root)) {
      migratedBookmarks.add(root);
      for (const [key, text] of Object.entries(useGitLog.getState().bookmarks)) {
        const split = key.lastIndexOf("\0");
        const repo = split < 0 ? root : key.slice(0, split),
          id = key.slice(split + 1);
        const path = `git-log:${encodeURIComponent(repo)}#${id}`;
        if (!useBookmarks.getState().items.some((b) => b.path === path))
          updateBookmarks((items) => toggleBookmark(items, path, 0, text));
      }
    }
    useGitLog.setState({
      bookmarks: Object.fromEntries(
        useBookmarks.getState().items.flatMap((b) => {
          const c = parseCommitBookmark(b.path);
          return c ? [[commitKey({ repo: c.repo, id: c.id }), b.description || b.text]] : [];
        }),
      ),
    });
  };
  syncBookmarks();
  const unsubscribeBookmarks = useBookmarks.subscribe(syncBookmarks);
  const unsubscribeVcs = useVcs.subscribe((s, prev) => {
    if (s.root !== prev.root) {
      saveLogSession(prev.root);
      restoring = true;
      cancelLogRequests();
      loadPromises.clear();
      parked.clear();
      useGitLog.setState((l) => ({
        ...initialLog(),
        bookmarks: {},
        tab: isLogTab(l.tab, l.logTabs) ? "log" : l.tab,
        generation: l.generation + 1,
      }));
      clearConsole();
      restoreLogSession(s.root);
      syncBookmarks();
      restoring = false;
    } else if (s.roots !== prev.roots) {
      for (const [id, view] of parked) parked.set(id, { ...freshView(view.filters), options: view.options });
      void reloadLog();
    }
  });
  return () => {
    saveLogSession(useVcs.getState().root);
    cancelLogRequests();
    unsubscribeLog();
    unsubscribeOptions();
    unsubscribeBookmarks();
    unsubscribeVcs();
    document.removeEventListener("focusin", trackFocus);
    setContext("vcsLogFocus", false);
  };
}

let restoring = false;
const sessionKey = (root: string) => `openidea.vcs.logSession.v1:${root}`;

function parseFilters(value: unknown): LogFilters {
  if (!value || typeof value !== "object") return emptyFilters();
  const raw = value as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  const filters = {
    ...emptyFilters(),
    branches: strings(raw.branches),
    authors: strings(raw.authors),
    repositories: strings(raw.repositories),
    paths: strings(raw.paths),
    text: typeof raw.text === "string" ? raw.text : "",
    path: typeof raw.path === "string" ? raw.path : null,
    range: typeof raw.range === "string" ? raw.range : null,
    regex: raw.regex === true,
    matchCase: raw.matchCase === true,
  };
  if (raw.date && typeof raw.date === "object") {
    const date = raw.date as Record<string, unknown>;
    if (
      (date.after == null || (typeof date.after === "number" && Number.isFinite(date.after))) &&
      (date.before == null || (typeof date.before === "number" && Number.isFinite(date.before)))
    )
      filters.date = {
        after: (date.after as number | null) ?? null,
        before: (date.before as number | null) ?? null,
        label: typeof date.label === "string" ? date.label : "",
      };
  }
  return filters;
}

function saveLogSession(root: string | null) {
  if (!root || restoring) return;
  const state = useGitLog.getState();
  const views = new Map(parked).set(state.shownLog, currentView());
  try {
    localStorage.setItem(
      sessionKey(root),
      JSON.stringify({
        version: 1,
        active: state.shownLog,
        tabs: state.logTabs,
        bookmarks: state.bookmarks,
        views: [...views].map(([id, view]) => ({
          id,
          filters: view.filters,
          options: view.options,
          fragments: Object.fromEntries(Object.entries(view.fragments).map(([key, ids]) => [key, [...ids]])),
          selected: view.selected,
          selection: view.selection,
        })),
      }),
    );
  } catch {
    /* A full or unavailable store leaves this session usable. */
  }
}

function restoreLogSession(root: string | null) {
  if (!root) return;
  restoring = true;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(sessionKey(root)) ?? "null");
    if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1) return;
    const value = raw as { tabs?: unknown; views?: unknown; active?: unknown; bookmarks?: unknown };
    const tabs = Array.isArray(value.tabs)
      ? value.tabs.filter(
          (tab): tab is LogTab =>
            !!tab &&
            typeof tab === "object" &&
            typeof tab.id === "string" &&
            typeof tab.target === "string" &&
            ["history", "branch", "log", "external"].includes(tab.kind) &&
            (tab.repo == null || typeof tab.repo === "string"),
        )
      : [];
    for (const tab of tabs) tabSeq = Math.max(tabSeq, Number(tab.id.split(":").at(-1)) || 0);
    const ids = new Set(["log", ...tabs.map((t) => t.id)]);
    if (Array.isArray(value.views))
      for (const view of value.views) {
        if (view && typeof view === "object" && typeof view.id === "string" && ids.has(view.id))
          parked.set(view.id, {
            ...freshView(parseFilters(view.filters)),
            options: parseLogOptions(view.options),
            fragments: parseFragments(view.fragments),
            selected: typeof view.selected === "string" ? view.selected : null,
            selection: Array.isArray(view.selection)
              ? (view.selection as unknown[]).filter((id): id is string => typeof id === "string")
              : [],
          });
      }
    const id = typeof value.active === "string" && ids.has(value.active) ? value.active : "log";
    const view = parked.get(id) ?? freshView(emptyFilters());
    parked.delete(id);
    const { options, ...state } = view;
    setLogOptions(options);
    const bookmarks =
      value.bookmarks && typeof value.bookmarks === "object"
        ? Object.fromEntries(
            Object.entries(value.bookmarks).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {};
    useGitLog.setState({ ...state, tab: id, shownLog: id, logTabs: tabs, branchScope: root, bookmarks });
  } catch {
    /* Invalid or newer state starts with a fresh log. */
  } finally {
    restoring = false;
  }
}

export function toggleCommitBookmark(commit: Commit) {
  updateBookmarks((items) => toggleBookmark(items, commitBookmarkPath(commit), 0, commit.summary));
  useGitLog.setState((state) => {
    const bookmarks = { ...state.bookmarks };
    const key = commitKey(commit);
    if (useBookmarks.getState().items.some((b) => b.path === commitBookmarkPath(commit)))
      bookmarks[key] = commit.summary;
    else delete bookmarks[key];
    return { bookmarks };
  });
}

/**
 * Identity of a remembered filter value (#2443). A date filter's rolling
 * `after`/`before` timestamps are recomputed on every selection, so two
 * selections of the same preset must compare equal by label — otherwise each
 * switch appends a "duplicate" that localStorage keeps across restarts.
 */
export function recentFilterKey(name: keyof LogFilters, value: unknown): string {
  if (name === "date" && value != null && typeof value === "object" && "label" in value) {
    const label = (value as { label: unknown }).label;
    if (typeof label === "string") return `date:${label}`;
  }
  return JSON.stringify(value);
}

/** Identity of a remembered whole-filter snapshot: same, with the date normalized to its label. */
function recentFiltersKey(value: LogFilters): string {
  return JSON.stringify(value.date ? { ...value, date: value.date.label } : value);
}

function dedupeBy<K>(items: K[], key: (item: K) => string): K[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function recentFilterValues<K extends keyof LogFilters>(name: K): LogFilters[K][] {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(`openidea.vcs.logRecent.v1:${useVcs.getState().root}:${name}`) ?? "[]",
    );
    // Dedupe on read as well: state already corrupted before the fix heals itself.
    return Array.isArray(raw) ? dedupeBy(raw as LogFilters[K][], (v) => recentFilterKey(name, v)).slice(0, 10) : [];
  } catch {
    return [];
  }
}

export function recentLogFilters(): LogFilters[] {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(`openidea.vcs.logFilters.v1:${useVcs.getState().root}`) ?? "[]",
    );
    return Array.isArray(raw) ? dedupeBy(raw.slice(0, 10).map(parseFilters), recentFiltersKey).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function rememberRecentFilters(before: LogFilters) {
  for (const name of Object.keys(before) as Array<keyof LogFilters>) {
    const value = before[name];
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    try {
      localStorage.setItem(
        `openidea.vcs.logRecent.v1:${useVcs.getState().root}:${name}`,
        JSON.stringify(
          [
            value,
            ...recentFilterValues(name).filter((v) => recentFilterKey(name, v) !== recentFilterKey(name, value)),
          ].slice(0, 10),
        ),
      );
    } catch {
      /* Storage can be unavailable. */
    }
  }
  if (hasFilters(before)) {
    try {
      const recent = [
        before,
        ...recentLogFilters().filter((f) => recentFiltersKey(f) !== recentFiltersKey(before)),
      ].slice(0, 10);
      localStorage.setItem(`openidea.vcs.logFilters.v1:${useVcs.getState().root}`, JSON.stringify(recent));
    } catch {
      /* Recent filters are optional session state. */
    }
  }
}

export function setLogFilters(patch: Partial<LogFilters>) {
  useGitLog.setState({ seek: null });
  rememberRecentFilters(useGitLog.getState().filters);
  useGitLog.setState((s) => ({ filters: { ...s.filters, ...("branches" in patch ? { range: null } : {}), ...patch } }));
  // History of a file in another repository: that repository's log.
  void reloadLog();
}

/** Reloads history, optionally keeping the current view until its replacement arrives. */
export function reloadLog(
  { preserve = false }: { preserve?: boolean } = {},
  id = useGitLog.getState().shownLog,
): Promise<void> {
  cancelLogRequests(id);
  const next = nextGeneration();
  setViewState(id, () => ({
    ...(preserve ? {} : { commits: [], done: false }),
    loading: true,
    error: null,
    generation: next,
  }));
  loadPromises.delete(id);
  void loadOutgoing(id);
  const generation = logState(id).generation;
  void currentUser().then((user) => {
    if (logState(id).generation === generation) setViewState(id, { user });
  });
  return loadPage(true, id);
}

async function loadOutgoing(id: string) {
  const generation = logState(id).generation;
  const roots = useVcs.getState().roots.length ? useVcs.getState().roots : [currentRepo()];
  const outgoing = new Set<string>();
  const tracked = new Set<string>();
  await Promise.all(
    roots.map(async (repo) => {
      try {
        const info = await call(commands.vcsBranchInfo(repo));
        if (!info.upstream) return;
        const commits = await call(
          commands.vcsLog(repo, {
            branch: "HEAD",
            path: null,
            author: null,
            text: null,
            range: "@{u}..HEAD",
            skip: 0,
            limit: 0,
          }),
        );
        tracked.add(repo ?? "");
        for (const c of commits) outgoing.add(commitKey({ ...c, repo }));
      } catch {
        /* A missing upstream does not prevent browsing history. */
      }
    }),
  );
  if (logState(id).generation === generation) setViewState(id, { outgoing, tracked });
}

export function loadMore(id = useGitLog.getState().shownLog): Promise<void> {
  return loadPage(false, id);
}

export function loadNewer(id = useGitLog.getState().shownLog): Promise<void> {
  return loadPage(false, id, true);
}

function loadPage(replace: boolean, id: string, before = false): Promise<void> {
  const s = logState(id);
  if (!replace && !before && s.done) return Promise.resolve();
  const existing = loadPromises.get(id);
  if (existing) return existing;
  const gen = s.generation;
  const f = s.filters;
  // Settings › Version Control › Limit history to N rows (file / folder history).
  const vcs = workflowSettings().vcs;
  const cap = (f.path || f.paths?.length) && vcs.limitHistory ? vcs.historyLimit : Infinity;
  const loaded = replace ? 0 : s.commits.length;
  if (loaded >= cap) {
    setViewState(id, { done: true, loading: false });
    return Promise.resolve();
  }
  setViewState(id, { loading: true });
  const p = (async () => {
    try {
      const o = id === useGitLog.getState().shownLog ? logOptions() : parked.get(id)!.options;
      const tab = s.logTabs.find((t) => t.id === s.shownLog);
      if (tab?.readOnly)
        for (const repo of tab.repositories ?? (tab.repo ? [tab.repo] : []))
          await call(commands.vcsOpenExternalLog(repo));
      const tabRoots = tab?.repositories ?? (tab?.repo ? [tab.repo] : []);
      const ownerOf = (path: string) =>
        tabRoots
          .filter((repo) => path === repo || path.startsWith(`${repo}/`))
          .sort((a, b) => b.length - a.length)[0] ?? repoOf(path);
      const pathRoots = f.path ? [ownerOf(f.path)] : f.paths?.length ? [...new Set(f.paths.map(ownerOf))] : null;
      const roots = (
        tab?.repositories?.length
          ? tab.repositories
          : tab?.repo
            ? [tab.repo]
            : pathRoots
              ? pathRoots
              : f.repositories?.length
                ? f.repositories
                : useVcs.getState().roots.length
                  ? useVcs.getState().roots
                  : [currentRepo()]
      ).filter(
        (repo) =>
          (!pathRoots || pathRoots.includes(repo)) &&
          (!f.repositories?.length || (!!repo && f.repositories.includes(repo))),
      );
      const limit = Math.min(replace ? Math.max(PAGE, s.commits.length) : PAGE, cap - loaded);
      const refs = await branchesByRepo(roots.filter((r): r is string => !!r));
      const knownRefs = new Set(
        Object.values(refs)
          .flat()
          .map((b) => b.name),
      );
      let joined = false;
      const results = await Promise.allSettled(
        roots.map(async (repo) => {
          const branches = f.branches.filter(
            (ref) => !knownRefs.has(ref) || (repo && refs[repo]?.some((b) => b.name === ref)),
          );
          if (f.branches.length && !branches.length) return [];
          const config = (key: string) => call(commands.vcsConfigGet(repo, key)).catch(() => null);
          const [userEmail, userName] = await Promise.all([config("user.email"), config("user.name")]);
          const user = userEmail || userName;
          const ownAuthors = [
            ...new Set([...resolveAuthors(f.authors, user), ...(f.authors.includes(ME) && userName ? [userName] : [])]),
          ];
          if (f.authors.length && !ownAuthors.length) return [];
          if (logState(id).generation !== gen) return [];
          const previous = s.commits.filter((c) => commitRepo(c) === repo);
          const boundary =
            replace &&
            roots.length === 1 &&
            previous.length &&
            branches.length === 1 &&
            branches[0] === "HEAD" &&
            !f.text &&
            !f.authors.length &&
            !f.path &&
            !f.paths?.length &&
            !f.range &&
            !f.date &&
            !o.noMerges &&
            !o.firstParent
              ? previous[0]!.id
              : null;
          const firstPosition = previous[0]?.logPosition ?? 0;
          if (before && !firstPosition) return [];
          const fetchPage = (stopAt: string | null) => {
            const request = nextRequestId();
            const requests = pageRequests.get(id) ?? new Set<RequestId>();
            pageRequests.set(id, requests);
            requests.add(request);
            const query: LogQuery = {
              branch: null,
              branches,
              authors: ownAuthors,
              authorsExact: true,
              path: f.path,
              paths: f.paths?.filter((path) => ownerOf(path) === repo),
              follow: tab?.kind === "history",
              author: null,
              text: f.text.trim() || null,
              textRegex: f.regex,
              textMatchCase: f.matchCase,
              range: null,
              ranges: f.range?.split(/\s+/).filter(Boolean) ?? [],
              request,
              summaryOnly: true,
              stopAt,
              retainUntil: replace ? (previous.at(-1)?.id ?? null) : null,
              skip: before
                ? Math.max(0, firstPosition - PAGE)
                : replace
                  ? 0
                  : previous.at(-1)?.logPosition != null
                    ? previous.at(-1)!.logPosition! + 1
                    : previous.length,
              seek: replace ? (s.seek?.repo === repo ? s.seek.id : null) : null,
              limit: before ? Math.min(PAGE, firstPosition) : limit,
              order: o.sort,
              firstParent: o.firstParent,
              noMerges: o.noMerges,
              sinceMs: f.date?.after ?? null,
              untilMs: f.date?.before ?? null,
            };
            return call(commands.vcsLog(repo, query)).finally(() => requests.delete(request));
          };
          let page: RepoCommit[] = await fetchPage(boundary);
          if (boundary && page.at(-1)?.id === boundary) {
            const linear = page
              .slice(0, -1)
              .every((c, i) => c.parents.length === 1 && c.parents[0] === page[i + 1]!.id);
            if (linear) {
              const decorations = await call(commands.vcsLogRefs(repo)).catch(() => null);
              if (decorations) {
                const labels = new Map<string, string[]>();
                for (const [name, id] of Object.entries(decorations))
                  if (id) labels.set(id, [...(labels.get(id) ?? []), name]);
                const old = previous.map((c) => {
                  const refs = labels.get(c.id) ?? [];
                  return refs.length === c.refs.length && refs.every((ref) => c.refs.includes(ref))
                    ? c
                    : { ...c, refs };
                });
                page = [...page.slice(0, -1), ...old];
                joined = true;
              } else page = await fetchPage(null);
            } else page = await fetchPage(null);
          }
          const repoBranches = repo ? (refs[repo] ?? []) : [];
          const remoteNames = repo ? repoBranches.filter((b) => b.remote).map((b) => b.name) : undefined;
          const branchesByTip = new Map<string, Branch[]>();
          for (const branch of repoBranches) {
            if (!branch.commit) continue;
            const atTip = branchesByTip.get(branch.commit);
            if (atTip) atTip.push(branch);
            else branchesByTip.set(branch.commit, [branch]);
          }
          return page.map((c) => ({
            ...c,
            repo,
            user,
            userName,
            readOnly: tab?.readOnly === true,
            remoteNames,
            refBranches: branchesByTip.get(c.id)?.filter((branch) => c.refs.includes(branch.name)),
          }));
        }),
      );
      const streams = results.map((r, i) =>
        r.status === "fulfilled" ? r.value : replace ? s.commits.filter((c) => commitRepo(c) === roots[i]) : [],
      );
      const failures = results.flatMap((r, i) =>
        r.status === "rejected" ? [`${roots[i] ? repoName(roots[i]!) : "Git"}: ${errorMessage(r.reason)}`] : [],
      );
      const currentStreams = before ? roots.map((repo) => s.commits.filter((c) => commitRepo(c) === repo)) : [];
      const page = mergeRepoLogs(
        before ? streams.map((stream, i) => [...stream, ...(currentStreams[i] ?? [])]) : streams,
        before || joined || s.seek || (replace && s.commits.length) ? Number.MAX_SAFE_INTEGER : limit,
      );
      if (replace && roots.length > 1 && s.commits.length && !s.seek) {
        // Keep the loaded window through its last surviving commit. Older candidates
        // from each repository are fetched again when paging.
        const loadedKeys = new Set(s.commits.map(commitKey));
        const last = page.findLastIndex((c) => loadedKeys.has(commitKey(c)));
        page.length = Math.min(page.length, Math.max(limit, last + 1));
      }
      const cur = logState(id);
      if (cur.generation !== gen) return;
      if (replace && results.length > 0 && failures.length === results.length && cur.commits.length) {
        setViewState(id, { error: failures.join("\n") });
        return;
      }
      const commits =
        replace || before
          ? page
          : mergeRepoLogs(
              roots.map((repo) => [
                ...cur.commits.filter((c) => commitRepo(c) === repo),
                ...page.filter((c) => commitRepo(c) === repo),
              ]),
              Number.MAX_SAFE_INTEGER,
            );
      setViewState(id, {
        commits,
        done: before
          ? cur.done
          : commits.length >= cap
            ? true
            : page.length && page.every((c) => c.logTotal != null)
              ? roots.every((repo, i) => {
                  const last = commits.findLast((c) => commitRepo(c) === repo);
                  return (
                    !streams[i]?.length || (last != null && last.logPosition! + 1 >= streams[i]!.at(-1)!.logTotal!)
                  );
                })
              : joined
                ? s.done
                : page.length < limit || loaded + page.length >= cap,
        error: failures.join("\n") || null,
      });
    } catch (e) {
      if (logState(id).generation === gen)
        setViewState(id, { error: errorMessage(e), done: replace && s.commits.length ? s.done : true });
    } finally {
      if (logState(id).generation === gen) {
        setViewState(id, { loading: false });
        loadPromises.delete(id);
      }
    }
  })();
  loadPromises.set(id, p);
  return p;
}

/**
 * What the log shows depends on: HEAD and every branch tip. When this changes
 * (commit, undo, reset, rebase, fetch, branch created / deleted) the log is stale.
 */
export function refsSignature(head: BranchInfo | null, branches: readonly Branch[]): string {
  const tips = branches.map((b) => `${b.remote ? "r" : "l"}:${b.name}@${b.commit}`).sort();
  return [`HEAD:${head?.head ?? ""}@${head?.headCommit ?? ""}`, ...tips].join("\n");
}

export function selectCommit(id: string | null, reveal = false) {
  useGitLog.setState((s) => ({
    selected: id,
    selection: id ? [id] : [],
    revealTick: reveal ? s.revealTick + 1 : s.revealTick,
  }));
}

/** Cmd/Ctrl-click: toggles `id` in the selection. */
export function toggleCommitSelection(id: string) {
  useGitLog.setState((s) => {
    const existing = s.selection;
    const on = existing.includes(id);
    const selection = on ? existing.filter((x) => x !== id) : [...existing, id];
    return { selection, selected: on ? (selection[selection.length - 1] ?? null) : id };
  });
}

/** Shift-click / Shift+arrows: selects the rows between the anchor (lead) and `id` within `visible`. */
export function extendCommitSelection(id: string, visible: readonly Commit[]) {
  useGitLog.setState((s) => {
    const anchor = s.selection[0] ?? s.selected;
    const a = anchor ? visible.findIndex((c) => commitKey(c) === anchor) : -1;
    const b = visible.findIndex((c) => commitKey(c) === id);
    if (a < 0 || b < 0) return { selected: id, selection: [id] };
    const [from, to] = a <= b ? [a, b] : [b, a];
    const range = visible.slice(from, to + 1).map(commitKey);
    // Keep the anchor first so further extensions pivot on it.
    return {
      selected: id,
      selection: range.includes(anchor!) ? [anchor!, ...range.filter((x) => x !== anchor)] : range,
    };
  });
}

/** Selected commits, newest first (log order). */
export function selectedCommits(): Commit[] {
  const { commits, selection } = useGitLog.getState();
  const ids = new Set(selection);
  return commits.filter((c) => ids.has(commitKey(c)));
}

/** Stop on completion, failure, or a superseding view; depth is never a limit. */
async function pageUntil(find: () => boolean) {
  const generation = useGitLog.getState().generation;
  while (!find() && !useGitLog.getState().done && useGitLog.getState().generation === generation) {
    const before = useGitLog.getState().commits.length;
    await loadMore();
    if (useGitLog.getState().commits.length <= before) break;
  }
}

/** Selects `id` in the log, seeking directly to it (and clearing filters only if needed). */
export async function revealCommit(id: string, repo = currentRepo(), tab = "log") {
  if (useGitLog.getState().logTabs.find((t) => t.id === tab)?.location === "editor") showLogView(tab);
  else selectGitTab(tab);
  if (tab === "log") initLogBranchFilter();
  let { filters } = useGitLog.getState();
  const { selected } = useGitLog.getState();
  const root = useVcs.getState().root;
  const valid = () => {
    const state = useGitLog.getState();
    return (
      useVcs.getState().root === root &&
      state.shownLog === tab &&
      state.filters === filters &&
      state.selected === selected
    );
  };
  const find = () =>
    useGitLog
      .getState()
      .commits.find((c) => (!repo || !commitRepo(c) || commitRepo(c) === repo) && (c.id === id || c.id.startsWith(id)));
  const waitReload = async () => {
    await reloadLog();
    // The log's first mount may replace this request with its own initial load.
    while (valid()) {
      const pending = loadPromises.get(tab);
      if (!pending) break;
      await pending;
    }
  };
  if (find() && !loadPromises.has(tab)) {
    const hit = find();
    if (hit) selectCommit(commitKey(hit), true);
    return;
  }
  useGitLog.setState({ seek: { repo, id } });
  await waitReload();
  if (!valid()) return;
  if (!find() && hasFilters(useGitLog.getState().filters)) {
    filters = emptyFilters();
    useGitLog.setState({ filters, seek: { repo, id } });
    await waitReload();
    if (!valid()) return;
  }
  if (!find()) {
    const generation = useGitLog.getState().generation;
    await pageUntil(() => !!find());
    if (!valid() || useGitLog.getState().generation !== generation) return;
  }
  const hit = find();
  if (hit) selectCommit(commitKey(hit), true);
}

/** Navigate visible graph parents, offering a choice at a merge. */
export function displayedLogGraph() {
  const s = useGitLog.getState();
  const heads = useVcs.getState().heads;
  return presentLogGraph(
    s.commits,
    logOptions(),
    s.fragments,
    new Set([
      ...s.selection,
      ...Object.keys(s.bookmarks),
      ...s.commits
        .filter((c) => c.refs.includes("HEAD") || c.id === heads[commitRepo(c) ?? ""]?.headCommit)
        .map(commitKey),
    ]),
  );
}

export async function goToParent(c: Commit) {
  const generation = useGitLog.getState().generation;
  const parents = () => displayedLogGraph().graph.find((x) => x.id === commitKey(c))?.parents ?? [];
  if (!parents().length) return;
  const find = () => displayedLogGraph().commits.filter((x) => parents().includes(commitKey(x)));
  await pageUntil(() => find().length === parents().length);
  if (useGitLog.getState().generation !== generation) return;
  const candidates = find();
  const chosen = candidates.length > 1 ? await chooseLogCommit(candidates, "Select Parent Commit") : candidates[0];
  if (chosen && useGitLog.getState().generation === generation) selectCommit(commitKey(chosen), true);
}

/** Go to Child Commit: the nearest newer loaded commit having `c` as a parent. */
export async function goToChild(c: Commit) {
  const { commits, generation } = useGitLog.getState();
  const children = new Set(
    displayedLogGraph()
      .graph.filter((x) => x.parents.includes(commitKey(c)))
      .map((x) => x.id),
  );
  const candidates = commits.filter((x) => children.has(commitKey(x)));
  const chosen = candidates.length > 1 ? await chooseLogCommit(candidates, "Select Child Commit") : candidates[0];
  if (chosen && useGitLog.getState().generation === generation) selectCommit(commitKey(chosen), true);
}

/** Graph / View Options change; options that change the query reload the log. */
export function updateLogOptions(patch: Partial<LogOptions>) {
  if ("collapseLinear" in patch && logOptions().linearizeMerges) {
    useGitLog.setState({ fragments: { ...emptyFragments(), merges: new Set(patch.collapseLinear ? [] : ["*"]) } });
    setLogOptions({ ...patch, collapseLinear: false });
    return;
  }
  if ("collapseLinear" in patch)
    useGitLog.setState({
      fragments: {
        ...emptyFragments(),
        merges: new Set(patch.collapseLinear ? [] : ["*"]),
      },
    });
  else if ("linearizeMerges" in patch) useGitLog.setState({ fragments: emptyFragments() });
  if (setLogOptions(patch)) void reloadLog();
}

/** Highlight › My Commits: authored by the current user. */
export function isMine(c: Commit, user: string | null): boolean {
  if ("user" in c) user = (c as RepoCommit).user ?? null;
  if (!user) return false;
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const name = (c as RepoCommit).userName;
  return (
    c.email.toLowerCase() === user.toLowerCase() ||
    normalize(c.author) === normalize(name ?? user) ||
    normalize(c.email.split("@")[0]!) === normalize(user.split("@")[0]!)
  );
}

/**
 * Go to Hash/Branch/Tag: selects the commit `rev` names, paging the log until it is
 * loaded (and clearing the filters when they hide it). False when there is no such commit.
 */
export async function goToRef(rev: string, repository?: string | null): Promise<boolean> {
  const state = useGitLog.getState();
  let generation = state.generation;
  const valid = () =>
    useGitLog.getState().generation === generation && useGitLog.getState().shownLog === state.shownLog;
  const reload = async () => {
    const load = reloadLog();
    generation = useGitLog.getState().generation;
    await load;
  };
  const logTab = state.logTabs.find((t) => t.id === state.shownLog);
  const repos =
    repository !== undefined
      ? [repository]
      : logTab?.repositories?.length
        ? logTab.repositories
        : logTab?.repo
          ? [logTab.repo]
          : state.filters.repositories?.length
            ? state.filters.repositories
            : useVcs.getState().roots.length
              ? useVcs.getState().roots
              : [currentRepo()];
  if (repos.length > 1) {
    const candidates = (
      await Promise.all(
        repos.map(async (repo) => {
          try {
            const [commit] = await call(
              commands.vcsLog(repo, { branch: rev.trim(), path: null, author: null, text: null, skip: 0, limit: 1 }),
            );
            return commit ? [{ ...commit, repo }] : [];
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    if (!valid()) return false;
    const chosen =
      candidates.length > 1
        ? await chooseLogCommit(
            candidates.map((c) => ({ ...c, summary: `${repoName(c.repo ?? "")} · ${c.summary}` })),
            "Select Repository Commit",
          )
        : candidates[0];
    return chosen && valid() ? goToRef(rev, commitRepo(chosen)) : false;
  }
  const repo = repos[0] ?? null;
  const target = rev.trim();
  if (!target) return false;
  let id: string | undefined;
  try {
    const [hit] = await call(
      commands.vcsLog(repo, {
        branch: target,
        path: null,
        author: null,
        text: null,
        range: null,
        skip: 0,
        limit: 1,
      }),
    );
    id = hit?.id;
  } catch {
    id = undefined;
  }
  if (!id || !valid()) return false;
  const tab = useGitLog.getState().shownLog;
  showLogView(isLogTab(tab) ? tab : "log");
  const find = () =>
    useGitLog.getState().commits.some((c) => c.id === id && (!commitRepo(c) || commitRepo(c) === repo));
  if (!useGitLog.getState().commits.length) await reload();
  if (!valid()) return false;
  if (!find()) {
    useGitLog.setState({ seek: { repo, id } });
    await reload();
  }
  if (!valid()) return false;
  if (!find() && hasFilters(useGitLog.getState().filters)) {
    useGitLog.setState({ filters: emptyFilters(), seek: { repo, id } });
    await reload();
    if (!valid()) return false;
  }
  if (!valid()) return false;
  if (!find() && !useGitLog.getState().error) {
    useGitLog.setState({ filters: { ...emptyFilters(), branches: [id], ...(repo ? { repositories: [repo] } : {}) } });
    await reload();
  }
  if (!valid() || !find()) return false;
  const hit = useGitLog.getState().commits.find((c) => c.id === id && (!commitRepo(c) || commitRepo(c) === repo));
  if (!hit) return false;
  selectCommit(commitKey(hit), true);
  return true;
}
