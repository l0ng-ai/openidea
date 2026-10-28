/** Git log tool window state: filters, paged commits, graph, selection. */
import { create } from "zustand";
import type { Branch, BranchInfo, Commit } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { collapseLinear, computeGraph, emptyGraphState, type GraphRow, type GraphState } from "./graph";
import { logOptions, setLogOptions, type LogOptions } from "./logOptions";
import { clearConsole, errorMessage } from "./ops";
import { currentRepo, currentRepoRoot, repoOf, selectRepo, useVcs } from "./store";

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
  /** Author names or emails (any matches); `ME` = the current user. */
  authors: string[];
  text: string;
  /** `text` is a regular expression / matches case-sensitively. */
  regex: boolean;
  matchCase: boolean;
  /** Absolute path (file or directory). */
  path: string | null;
  date: LogDateFilter | null;
}

interface LogState {
  filters: LogFilters;
  commits: Commit[];
  rows: GraphRow[];
  graph: GraphState;
  loading: boolean;
  done: boolean;
  error: string | null;
  /** Lead selection. */
  selected: string | null;
  /** Every selected commit id (includes `selected`), in selection order. */
  selection: string[];
  /** Commits of HEAD not on its upstream (`@{u}..HEAD`); null without an upstream. */
  outgoing: Set<string> | null;
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
}

/** Fixed content tabs of the Git tool window. */
export type GitTab = "changes" | "shelf" | "stashes" | "log" | "console" | "worktrees";

/** A log tab of its own (IDEA's "History: file" / "Log: branch" tabs): its own filters and view. */
export interface LogTab {
  id: string;
  kind: "history" | "branch";
  /** What it shows (the file path or the branch); opening the same again selects the tab. */
  target: string;
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

/** Any filter other than the text field's toggles is set. */
export function hasFilters(f: LogFilters): boolean {
  return !!(f.branches.length || f.authors.length || f.text || f.path || f.date);
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

const initialLog = (): Omit<LogState, "generation"> => ({
  filters: emptyFilters(),
  commits: [],
  rows: [],
  graph: emptyGraphState(),
  loading: false,
  done: false,
  error: null,
  selected: null,
  selection: [],
  outgoing: null,
  tab: "log",
  logTabs: [],
  shownLog: "log",
  branchScope: null,
  revealTick: 0,
  user: null,
});

export const useGitLog = create<LogState>(() => ({ ...initialLog(), generation: 0 }));

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
  const s = useGitLog.getState();
  const repo = s.shownLog === "log" ? currentRepoRoot() : null;
  useGitLog.setState({
    filters: { ...s.filters, branches: [...branches] },
    ...(repo ? { branchScope: repo } : {}),
  });
  if (repo) rememberLogBranches(repo, branches);
  void reloadLog();
}

let loadPromise: Promise<void> | null = null;

/** What a log tab shows: the store fields swapped in and out when another log tab is selected. */
type LogView = Pick<
  LogState,
  "filters" | "commits" | "rows" | "graph" | "loading" | "done" | "error" | "selected" | "selection" | "revealTick"
>;

function freshView(filters: LogFilters): LogView {
  const { commits, rows, graph, loading, done, error, selected, selection, revealTick } = initialLog();
  return { filters, commits, rows, graph, loading, done, error, selected, selection, revealTick };
}

/** Views of the log tabs not shown now. */
const parked = new Map<string, LogView>();

function currentView(): LogView {
  const { filters, commits, rows, graph, done, error, selected, selection, revealTick } = useGitLog.getState();
  // A page still loading is dropped (the generation changes): loaded again when shown.
  return { filters, commits, rows, graph, loading: false, done, error, selected, selection, revealTick };
}

export const isLogTab = (id: string, tabs: readonly LogTab[] = useGitLog.getState().logTabs) =>
  id === "log" || tabs.some((t) => t.id === id);

/** Puts the view of log tab `id` into the store, parking the one shown. */
function showLogView(id: string) {
  const s = useGitLog.getState();
  if (s.shownLog === id) return;
  parked.set(s.shownLog, currentView());
  const view = parked.get(id) ?? freshView(emptyFilters());
  parked.delete(id);
  loadPromise = null;
  useGitLog.setState({ ...view, shownLog: id, generation: s.generation + 1 });
  if (!view.commits.length) void reloadLog();
}

/** Selects a content tab of the Git tool window; a log tab brings its own filters and commits. */
export function selectGitTab(id: string) {
  if (isLogTab(id)) showLogView(id);
  useGitLog.setState({ tab: id });
}

let tabSeq = 0;

/**
 * Opens (or selects) a log tab of its own, leaving the main Log and its filters as
 * they are: Show History for a file, Show Git Log for a branch.
 */
export function openLogTab(kind: LogTab["kind"], target: string): string {
  const existing = useGitLog.getState().logTabs.find((t) => t.kind === kind && t.target === target);
  if (existing) {
    selectGitTab(existing.id);
    return existing.id;
  }
  const id = `${kind}:${++tabSeq}`;
  const filters = { ...emptyFilters(), ...(kind === "history" ? { path: target } : { branches: [target] }) };
  parked.set(id, freshView(filters));
  useGitLog.setState((s) => ({ logTabs: [...s.logTabs, { id, kind, target }] }));
  selectGitTab(id);
  // History of a file in another repository: that repository's log.
  const repo = kind === "history" ? repoOf(target) : null;
  if (repo && repo !== currentRepo()) void selectRepo(repo);
  return id;
}

/** Closes a log tab; when it was shown, the main Log comes back. */
export function closeLogTab(id: string) {
  const s = useGitLog.getState();
  if (!s.logTabs.some((t) => t.id === id)) return;
  if (s.shownLog === id) showLogView("log");
  parked.delete(id);
  useGitLog.setState((l) => ({
    logTabs: l.logTabs.filter((t) => t.id !== id),
    tab: l.tab === id ? "log" : l.tab,
  }));
}

/**
 * Another project (the window switched projects): forget its commits, filters, selection
 * and console. Another repository of the project selected: show its log.
 */
export function installGitLog(): () => void {
  return useVcs.subscribe((s, prev) => {
    if (s.root !== prev.root) {
      loadPromise = null;
      parked.clear();
      useGitLog.setState((l) => ({
        ...initialLog(),
        tab: isLogTab(l.tab, l.logTabs) ? "log" : l.tab,
        generation: l.generation + 1,
      }));
      clearConsole();
    } else if (s.repo !== prev.repo && prev.repo !== null) {
      // The parked log tabs load again when shown.
      for (const [id, view] of parked) parked.set(id, freshView(view.filters));
      // Drops a page still loading for the old repository (its generation no longer matches).
      loadPromise = null;
      useGitLog.setState((l) => ({
        // The shown log belonged to the old repository: it loads again once the new
        // repository's branch filter is settled (see LogView).
        commits: [],
        rows: [],
        graph: emptyGraphState(),
        loading: false,
        done: false,
        error: null,
        selected: null,
        selection: [],
        branchScope: null,
        generation: l.generation + 1,
        filters: {
          ...l.filters,
          // The main Log's branch filter belonged to the old repository; show all
          // until the new repository's remembered/current branch is settled.
          ...(l.shownLog === "log" ? { branches: [] } : {}),
          // A path filter belongs to the repository it is in.
          ...(l.filters.path && repoOf(l.filters.path) !== s.repo ? { path: null } : {}),
        },
      }));
    }
  });
}

export function setLogFilters(patch: Partial<LogFilters>) {
  useGitLog.setState((s) => ({ filters: { ...s.filters, ...patch } }));
  // History of a file in another repository: that repository's log.
  const repo = patch.path ? repoOf(patch.path) : null;
  if (repo && repo !== currentRepo()) void selectRepo(repo);
  else void reloadLog();
}

/** Drops loaded commits and loads the first page. */
export function reloadLog(): Promise<void> {
  useGitLog.setState((s) => ({
    commits: [],
    rows: [],
    graph: emptyGraphState(),
    done: false,
    error: null,
    generation: s.generation + 1,
  }));
  loadPromise = null;
  void loadOutgoing();
  void currentUser().then((user) => useGitLog.setState({ user }));
  return loadMore();
}

async function loadOutgoing() {
  const upstream = useVcs.getState().branch?.upstream;
  if (!upstream) return useGitLog.setState({ outgoing: null });
  try {
    const commits = await call(
      commands.vcsLog(currentRepo(), {
        branch: "HEAD",
        path: null,
        author: null,
        text: null,
        range: "@{u}..HEAD",
        skip: 0,
        limit: 0,
      }),
    );
    useGitLog.setState({ outgoing: new Set(commits.map((c) => c.id)) });
  } catch {
    useGitLog.setState({ outgoing: null });
  }
}

/** The commit is on the upstream of the current branch (rewriting it needs a force push). */
export function isPushed(id: string): boolean {
  const { outgoing } = useGitLog.getState();
  return !!outgoing && !outgoing.has(id);
}

export function loadMore(): Promise<void> {
  const s = useGitLog.getState();
  if (s.done) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const gen = s.generation;
  const f = s.filters;
  // Settings › Version Control › Limit history to N rows (file / folder history).
  const vcs = workflowSettings().vcs;
  const cap = f.path && vcs.limitHistory ? vcs.historyLimit : Infinity;
  if (s.commits.length >= cap) {
    useGitLog.setState({ done: true });
    return Promise.resolve();
  }
  useGitLog.setState({ loading: true });
  const p = (async () => {
    try {
      const authors = resolveAuthors(f.authors, f.authors.includes(ME) ? await currentUser() : null);
      if (f.authors.length && !authors.length) {
        if (useGitLog.getState().generation === gen) useGitLog.setState({ done: true });
        return;
      }
      const o = logOptions();
      const page = await call(
        commands.vcsLog(currentRepo(), {
          branch: null,
          branches: f.branches,
          authors,
          path: f.path,
          author: null,
          text: f.text.trim() || null,
          textRegex: f.regex,
          textMatchCase: f.matchCase,
          range: null,
          skip: s.commits.length,
          limit: Math.min(PAGE, cap - s.commits.length),
          order: o.sort,
          firstParent: o.firstParent,
          noMerges: o.noMerges,
          // The date filter runs in the backend so the graph stays connected.
          sinceMs: f.date?.after ?? null,
          untilMs: f.date?.before ?? null,
        }),
      );
      const cur = useGitLog.getState();
      if (cur.generation !== gen) return;
      const { rows, state } = computeGraph(page, cur.graph);
      useGitLog.setState({
        commits: cur.commits.concat(page),
        rows: cur.rows.concat(rows),
        graph: state,
        done: page.length < PAGE || cur.commits.length + page.length >= cap,
        error: null,
      });
    } catch (e) {
      if (useGitLog.getState().generation === gen) useGitLog.setState({ error: errorMessage(e), done: true });
    } finally {
      if (useGitLog.getState().generation === gen) {
        useGitLog.setState({ loading: false });
        loadPromise = null;
      }
    }
  })();
  loadPromise = p;
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
    const on = s.selection.includes(id);
    const selection = on ? s.selection.filter((x) => x !== id) : [...s.selection, id];
    return { selection, selected: on ? (selection[selection.length - 1] ?? null) : id };
  });
}

/** Shift-click / Shift+arrows: selects the rows between the anchor (lead) and `id` within `visible`. */
export function extendCommitSelection(id: string, visible: readonly Commit[]) {
  useGitLog.setState((s) => {
    const anchor = s.selection[0] ?? s.selected;
    const a = anchor ? visible.findIndex((c) => c.id === anchor) : -1;
    const b = visible.findIndex((c) => c.id === id);
    if (a < 0 || b < 0) return { selected: id, selection: [id] };
    const [from, to] = a <= b ? [a, b] : [b, a];
    const range = visible.slice(from, to + 1).map((c) => c.id);
    // Keep the anchor first so further extensions pivot on it.
    return { selected: id, selection: [anchor!, ...range.filter((x) => x !== anchor)] };
  });
}

/** Selected commits, newest first (log order). */
export function selectedCommits(): Commit[] {
  const { commits, selection } = useGitLog.getState();
  const ids = new Set(selection);
  return commits.filter((c) => ids.has(c.id));
}

const MAX_SEARCH_PAGES = 30;

/** Selects `id` in the log, clearing filters and paging until it is loaded. */
export async function revealCommit(id: string) {
  selectGitTab("log");
  const f = useGitLog.getState().filters;
  const filtered = hasFilters(f);
  const find = () => useGitLog.getState().commits.find((c) => c.id === id || c.id.startsWith(id));
  if (filtered) {
    useGitLog.setState({ filters: emptyFilters() });
    await reloadLog();
  } else if (!useGitLog.getState().commits.length) {
    await reloadLog();
  }
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  const hit = find();
  if (hit) selectCommit(hit.id, true);
}

/** Go to Parent Commit: selects the first parent, paging the log until it is loaded. */
export async function goToParent(c: Commit) {
  const parent = c.parents[0];
  if (!parent) return;
  const find = () => useGitLog.getState().commits.find((x) => x.id === parent);
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  if (find()) selectCommit(parent, true);
}

/** Go to Child Commit: the nearest newer loaded commit having `c` as a parent. */
export function goToChild(c: Commit) {
  const { commits } = useGitLog.getState();
  const index = commits.findIndex((x) => x.id === c.id);
  for (let i = index - 1; i >= 0; i--) {
    if (commits[i]!.parents.includes(c.id)) return selectCommit(commits[i]!.id, true);
  }
}

/** Graph / View Options change; options that change the query reload the log. */
export function updateLogOptions(patch: Partial<LogOptions>) {
  if (setLogOptions(patch)) void reloadLog();
}

/** Highlight › My Commits: authored by the current user. */
export function isMine(c: Commit, user: string | null): boolean {
  if (!user) return false;
  const u = user.toLowerCase();
  return c.email.toLowerCase() === u || c.author.toLowerCase() === u;
}

/**
 * Go to Hash/Branch/Tag: selects the commit `rev` names, paging the log until it is
 * loaded (and clearing the filters when they hide it). False when there is no such commit.
 */
export async function goToRef(rev: string): Promise<boolean> {
  const target = rev.trim();
  if (!target) return false;
  let id: string | undefined;
  try {
    const [hit] = await call(
      commands.vcsLog(currentRepo(), {
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
  if (!id) return false;
  const tab = useGitLog.getState().tab;
  selectGitTab(isLogTab(tab) ? tab : "log");
  const find = () => useGitLog.getState().commits.some((c) => c.id === id);
  if (!useGitLog.getState().commits.length) await reloadLog();
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  if (!find()) await revealCommit(id);
  if (!find()) return false;
  // A commit inside a collapsed linear branch: expand them (IDEA does the same).
  if (logOptions().collapseLinear) {
    const head = useVcs.getState().branch?.headCommit;
    const shown = collapseLinear(useGitLog.getState().commits, new Set(head ? [head] : [])).commits;
    if (!shown.some((c) => c.id === id)) setLogOptions({ collapseLinear: false });
  }
  selectCommit(id, true);
  return true;
}
