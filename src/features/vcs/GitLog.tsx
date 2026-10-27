/** Git tool window: Log (graph, filters, commit details) and Console tabs. */
import { IssueText } from "./issueLinks";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChangedFile, Commit, RevisionChange } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  T,
} from "@/ui";
import { commitFileDiffData, openDiff, revisionChangeDiffData, withChain } from "./diffInput";
import { collapseLinear, computeGraph, hideLongEdges, laneColor, reachableFrom, type GraphRow } from "./graph";
import {
  extendCommitSelection,
  goToChild,
  goToParent,
  isMine,
  loadMore,
  ME,
  dateRangeLabel,
  refsSignature,
  reloadLog,
  selectCommit,
  selectedCommits,
  setLogFilters,
  toggleCommitSelection,
  updateLogOptions,
  useGitLog,
} from "./logStore";
import { refLabels, useLogOptions, type LogOptions } from "./logOptions";
import { KIND_COLOR, baseName, formatTime, relTo, type EffectiveKind } from "./model";
import { clearConsole, useVcsConsole } from "./ops";
import { currentRepo, loadBranches, useVcs } from "./store";
import { checkoutBranch, loadFavoriteBranches, newBranch, useFavoriteBranches } from "./branchOps";
import { branchMenu } from "./branchMenu";
import { branchFolderKeys, branchGroupKeys, buildBranchTree, filterBranchTree, type BranchTreeNode } from "./branches";
import { chooseDateRange, chooseMany, promptText } from "./dialogs";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import styles from "./GitLog.module.css";

const ROW = 22;
const LANE = 12;

type GitTab = "log" | "console";

/** Tool window header: Log / Console content tabs. */
export function GitTabs() {
  const tab = useGitLog((s) => s.tab);
  const available = useVcs((s) => s.available);
  if (!available) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.headerTabs}
      activeId={tab}
      onSelect={(id) => useGitLog.setState({ tab: id as GitTab })}
      aria-label="Git"
      panelIdPrefix="openidea-git"
      items={[
        { id: "log", label: "Log" },
        { id: "console", label: "Console" },
      ]}
    />
  );
}

export function GitToolWindow() {
  const tab = useGitLog((s) => s.tab);
  const available = useVcs((s) => s.available);
  if (!available)
    return (
      <EmptyState title="Version control is not configured">
        <T>The project is not a Git repository.</T>
      </EmptyState>
    );
  return (
    <div
      className={styles.root}
      role="tabpanel"
      id={`openidea-git-panel-${tab}`}
      aria-labelledby={`openidea-git-tab-${tab}`}
    >
      {tab === "log" ? <LogView /> : <ConsoleView />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log

function LogView() {
  const version = useVcs((s) => s.version);
  const commits = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const root = useVcs((s) => s.root);
  const repo = useVcs((s) => s.repo);
  const lastRefs = useRef<string | null>(null);

  // On mount, when the window switches to another project and when another of its
  // repositories is selected (its branches are needed to notice its refs moving).
  useEffect(() => {
    lastRefs.current = null;
    if (!useGitLog.getState().commits.length) void reloadLog();
    void loadBranches().catch(() => undefined);
  }, [root, repo]);

  // HEAD or a branch tip moved (commit, undo, reset, rebase, fetch…): reload (keeps the selection).
  useEffect(() => {
    const { branch, branches, branchesLoaded } = useVcs.getState();
    if (!branchesLoaded) return;
    const refs = refsSignature(branch, branches);
    const previous = lastRefs.current;
    lastRefs.current = refs;
    if (previous !== null && previous !== refs && useGitLog.getState().commits.length) void reloadLog();
  }, [version]);

  return (
    <SplitGroup orientation="horizontal" id="git-log" className={styles.split}>
      <SplitPanel id="branches" defaultSize="18%" minSize="120px">
        <BranchesPanel />
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="commits" defaultSize="54%" minSize="25%">
        <div className={styles.log}>
          <FilterBar />
          <CommitList />
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="details" defaultSize="28%" minSize="15%">
        <CommitDetails key={selection.join(" ") || "none"} commits={commits} />
      </SplitPanel>
    </SplitGroup>
  );
}

// --- branches ---------------------------------------------------------------

function branchDetail(n: BranchTreeNode): string | undefined {
  const b = n.branch;
  if (!b) return undefined;
  const sync = [b.behind > 0 ? `↓${b.behind}` : "", b.ahead > 0 ? `↑${b.ahead}` : ""].filter(Boolean).join(" ");
  return [b.current ? "current" : "", sync].filter(Boolean).join("  ") || undefined;
}

function BranchesPanel() {
  const branches = useVcs((s) => s.branches);
  const root = useVcs((s) => s.root);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const current = useVcs((s) => s.branch?.head ?? null);
  const favorites = useFavoriteBranches((s) => s.names);
  const filterBranches = useGitLog((s) => s.filters.branches);
  const [query, setQuery] = useState("");
  useEffect(() => loadFavoriteBranches(), [root]);
  const allRoots = useMemo(() => buildBranchTree(branches, favorites), [branches, favorites]);
  const roots = useMemo(() => filterBranchTree(allRoots, query), [allRoots, query]);
  // While searching every match is shown expanded.
  const searchExpanded = useMemo(() => (query.trim() ? new Set(branchGroupKeys(roots)) : undefined), [roots, query]);
  const selected = useMemo(
    () => new Set(filterBranches.map((b) => (b === "HEAD" ? "head" : `b:${b}`))),
    [filterBranches],
  );
  return (
    <div className={styles.branches}>
      <div className={styles.branchesBar} role="toolbar" aria-label="Branches">
        <SearchField
          className={styles.branchSearch}
          value={query}
          onChange={setQuery}
          placeholder="Branch"
          aria-label="Filter branches"
        />
        <IconButton icon="plus" title="New Branch…" size="small" onClick={() => void newBranch()} />
        <IconButton icon="git-fetch" title="Fetch" size="small" action="vcs.fetch" />
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void loadBranches()} />
      </div>
      <Tree<BranchTreeNode>
        key={`${root ?? ""}:${branchesLoaded}`}
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => n.label}
        getChildren={(n) => n.children}
        isExpandable={(n) => !!n.children}
        defaultExpanded={[
          "g:local",
          "g:remote",
          ...roots.flatMap((r) => r.children?.filter((c) => c.kind === "remote").map((c) => c.key) ?? []),
          ...(current ? branchFolderKeys(roots, current) : []),
        ]}
        expanded={searchExpanded}
        getIcon={(n) =>
          n.kind === "head"
            ? "commit"
            : n.branch?.current
              ? "current-branch"
              : n.kind === "branch"
                ? n.favorite
                  ? "star"
                  : "branch"
                : "folder"
        }
        getDetail={branchDetail}
        selected={selected}
        onSelectionChange={(sel) => {
          // Several selected branches filter the log by all of them.
          const refs = [...sel].flatMap((k) => (k === "head" ? ["HEAD"] : k.startsWith("b:") ? [k.slice(2)] : []));
          if (refs.length) setLogFilters({ branches: refs });
        }}
        onActivate={(n) => n.branch && !n.branch.current && void checkoutBranch(n.branch.name)}
        onContextMenu={(n, _s, e) => {
          const items = n?.branch ? branchMenu(n.branch, current) : [];
          if (!items.length) return;
          e.preventDefault();
          showContextMenu(e, items);
        }}
        empty={
          query.trim() ? (
            <span className={styles.muted}>
              <T>No matching branches</T>
            </span>
          ) : undefined
        }
        aria-label="Branches"
        className={styles.branchTree}
      />
    </div>
  );
}

// --- filters ----------------------------------------------------------------

const DAY = 86_400_000;
const DATE_OPTIONS: { label: string; days: number }[] = [
  { label: "Last 24 Hours", days: 1 },
  { label: "Last 7 Days", days: 7 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last Year", days: 365 },
];

function menuBelow(e: ReactMouseEvent<HTMLElement>, items: MenuItem[]) {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
}

function FilterButton({
  label,
  value,
  onOpen,
  onClear,
}: {
  label: string;
  value: string | null;
  onOpen: (e: ReactMouseEvent<HTMLElement>) => void;
  onClear: () => void;
}) {
  return (
    <span className={clsx(styles.filterButton, value && styles.filterActive)}>
      <button type="button" className={styles.filterMain} onClick={onOpen} aria-haspopup="menu">
        {value ? (
          <>
            {label}: <span className={styles.filterValue}>{value}</span>
          </>
        ) : (
          label
        )}
        {!value && <Icon name="chevron-down" size={12} className={styles.filterChevron} />}
      </button>
      {value && (
        <button type="button" className={styles.filterClear} aria-label={`Clear ${label} filter`} onClick={onClear}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

function FilterBar() {
  const filters = useGitLog((s) => s.filters);
  const commits = useGitLog((s) => s.commits);
  const branches = useVcs((s) => s.branches);
  const root = useVcs((s) => s.root);
  const [text, setText] = useState(filters.text);

  // Keep the field in sync when filters change elsewhere (Show History, reveal).
  const [seen, setSeen] = useState(filters);
  if (seen !== filters) {
    setSeen(filters);
    setText(filters.text);
  }

  useEffect(() => {
    if (text === filters.text) return;
    const t = setTimeout(() => setLogFilters({ text }), 300);
    return () => clearTimeout(t);
  }, [text, filters.text]);

  const only = (list: readonly string[], v: string) => list.length === 1 && list[0] === v;
  const branchNames = () => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);

  const openBranch = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      {
        label: "HEAD (Current Branch)",
        checked: only(filters.branches, "HEAD"),
        run: () => setLogFilters({ branches: ["HEAD"] }),
      },
      { kind: "separator" },
      ...branchNames().map((name) => ({
        label: name,
        icon: "branch",
        checked: filters.branches.includes(name),
        run: () => setLogFilters({ branches: [name] }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseMany({
            title: "Filter by Branch",
            options: ["HEAD", ...branchNames()],
            initial: filters.branches,
            customLabel: "Other revisions (comma-separated):",
          });
          if (r) setLogFilters({ branches: r });
        },
      },
    ]);

  const openUser = (e: ReactMouseEvent<HTMLElement>) => {
    const authors = [...new Set(commits.map((c) => c.author))].sort((a, b) => a.localeCompare(b)).slice(0, 30);
    menuBelow(e, [
      { label: ME, checked: filters.authors.includes(ME), run: () => setLogFilters({ authors: [ME] }) },
      ...(authors.length ? [{ kind: "separator" as const }] : []),
      ...authors.map((a) => ({
        label: a,
        checked: filters.authors.includes(a),
        run: () => setLogFilters({ authors: [a] }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseMany({
            title: "Filter by User",
            options: [ME, ...authors],
            initial: filters.authors,
            customLabel: "Other names or emails (comma-separated):",
          });
          if (r) setLogFilters({ authors: r });
        },
      },
    ]);
  };

  const openDate = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      ...DATE_OPTIONS.map((o) => ({
        label: o.label,
        checked: filters.date?.label === o.label,
        run: () => setLogFilters({ date: { after: Date.now() - o.days * DAY, before: null, label: o.label } }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseDateRange();
          if (r) setLogFilters({ date: { ...r, label: dateRangeLabel(r.after, r.before) } });
        },
      },
    ]);

  const openPaths = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      {
        label: "Select Folders…",
        run: async () => {
          const cur = filters.path && root ? relTo(root, filters.path) : (filters.path ?? "");
          const r = await promptText({ title: "Filter by Path", label: "File or folder", initial: cur, mono: true });
          if (!r) return;
          const v = r.value.trim();
          setLogFilters({ path: v ? (v.startsWith("/") || !root ? v : `${root}/${v}`) : null });
        },
      },
    ]);

  return (
    <div className={styles.filters} role="toolbar" aria-label="Log filters">
      <SearchField
        className={styles.textFilter}
        value={text}
        onChange={setText}
        placeholder="Text or hash"
        aria-label="Filter by message"
        toggles={[
          {
            id: "regex",
            icon: "regex",
            title: "Regex",
            pressed: filters.regex,
            onToggle: (regex) => setLogFilters({ regex }),
          },
          {
            id: "case",
            icon: "case",
            title: "Match Case",
            pressed: filters.matchCase,
            onToggle: (matchCase) => setLogFilters({ matchCase }),
          },
        ]}
      />
      <FilterButton
        label="Branch"
        value={filters.branches.join(", ") || null}
        onOpen={openBranch}
        onClear={() => setLogFilters({ branches: [] })}
      />
      <FilterButton
        label="User"
        value={filters.authors.join(", ") || null}
        onOpen={openUser}
        onClear={() => setLogFilters({ authors: [] })}
      />
      <FilterButton
        label="Date"
        value={filters.date?.label ?? null}
        onOpen={openDate}
        onClear={() => setLogFilters({ date: null })}
      />
      <FilterButton
        label="Paths"
        value={filters.path ? (root ? relTo(root, filters.path) : filters.path) || "." : null}
        onOpen={openPaths}
        onClear={() => setLogFilters({ path: null })}
      />
      <span className={styles.grow} />
      <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reloadLog()} />
      <IconButton
        icon="sort"
        title="Graph Options"
        size="small"
        aria-haspopup="menu"
        onClick={(e) => menuBelow(e, graphOptionsMenu(useLogOptions.getState()))}
      />
      <IconButton
        icon="eye"
        title="View Options"
        size="small"
        aria-haspopup="menu"
        onClick={(e) => menuBelow(e, viewOptionsMenu(useLogOptions.getState()))}
      />
      <IconButton icon="search" title="Go to Hash/Branch/Tag" size="small" action="vcs.log.goToRef" />
    </div>
  );
}

const toggle = (label: string, o: LogOptions, key: keyof LogOptions): MenuItem => ({
  label,
  checked: !!o[key],
  run: () => updateLogOptions({ [key]: !o[key] }),
});

/** IDEA's Git Log › Graph Options (sort, first parent / no merges, linear branches). */
export function graphOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Sort" },
    { label: "By Commit Date", checked: o.sort === "date", run: () => updateLogOptions({ sort: "date" }) },
    { label: "Topologically", checked: o.sort === "topo", run: () => updateLogOptions({ sort: "topo" }) },
    { kind: "separator" },
    { kind: "header", label: "Options" },
    toggle("First Parent", o, "firstParent"),
    toggle("No Merges", o, "noMerges"),
    { kind: "separator" },
    { kind: "header", label: "Branch Actions" },
    {
      label: "Collapse Linear Branches",
      disabled: o.collapseLinear,
      run: () => updateLogOptions({ collapseLinear: true }),
    },
    {
      label: "Expand Linear Branches",
      disabled: !o.collapseLinear,
      run: () => updateLogOptions({ collapseLinear: false }),
    },
  ];
}

/** IDEA's Git Log › View Options (what rows show and highlight). */
export function viewOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Show" },
    toggle("Compact References View", o, "compactRefs"),
    toggle("Tag Names", o, "tagNames"),
    toggle("Long Edges", o, "longEdges"),
    toggle("Commit Timestamp", o, "commitTimestamp"),
    toggle("References on the Left", o, "refsOnLeft"),
    {
      label: "Columns",
      submenu: [toggle("Author", o, "showAuthor"), toggle("Date", o, "showDate"), toggle("Hash", o, "showHash")],
    },
    { kind: "separator" },
    { kind: "header", label: "Highlight" },
    toggle("My Commits", o, "highlightMine"),
    toggle("Merge Commits", o, "highlightMerges"),
    toggle("Current Branch", o, "highlightCurrentBranch"),
  ];
}

/** IDEA's Git Log commit context menu (Git.Log.ContextMenu); `selection` = all selected commits, newest first. */
export function commitMenu(c: Commit, selection: Commit[] = [c]): MenuItem[] {
  const many = selection.length > 1 && selection.some((x) => x.id === c.id);
  const head = useVcs.getState().branch?.head ?? null;
  const { outgoing } = useGitLog.getState();
  const pushed = (x: Commit) => !!outgoing && !outgoing.has(x.id);
  if (many) {
    const anyPushed = selection.some(pushed);
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: selection, label: "Copy Revision Numbers" },
      { kind: "action", action: "vcs.log.createPatch", arg: selection },
      { kind: "action", action: "vcs.log.cherryPick", arg: selection },
      ...(selection.length === 2
        ? [{ kind: "action", action: "vcs.log.compareVersions", arg: selection } satisfies MenuItem]
        : []),
      { kind: "separator" },
      { kind: "action", action: "vcs.log.revert", arg: selection, label: "Revert Commits" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.squashCommits", arg: selection, disabled: anyPushed },
      { kind: "action", action: "vcs.log.dropCommit", arg: selection, label: "Drop Commits", disabled: anyPushed },
    ];
  }
  const isPushed = pushed(c);
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere = !!head && (outgoing ? outgoing.has(c.id) : true);
  return [
    { kind: "action", action: "vcs.log.copyRevision", arg: c },
    { label: "Copy Commit Message", run: () => void navigator.clipboard?.writeText(c.message) },
    { kind: "action", action: "vcs.log.createPatch", arg: c },
    { kind: "action", action: "vcs.log.cherryPick", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.checkoutRevision", arg: c },
    { kind: "action", action: "vcs.log.compareWithLocal", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.resetToHere", arg: c },
    { kind: "action", action: "vcs.log.revert", arg: c },
    { kind: "action", action: "vcs.log.undoCommit", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.editMessage", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.fixup", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.squashInto", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.dropCommit", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.interactiveRebase", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.pushUpToHere", arg: c, disabled: !canPushHere },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.rebaseOntoCommit",
      arg: c,
      label: `Rebase '${head ?? "HEAD"}' onto Selected Commit`,
      disabled: !head,
    },
    { kind: "action", action: "vcs.log.newBranch", arg: c },
    { kind: "action", action: "vcs.log.newTag", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.goToChild", arg: c },
    { kind: "action", action: "vcs.log.goToParent", arg: c, disabled: !c.parents.length },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.openInBrowser", arg: c },
  ];
}

function CommitList() {
  const all = useGitLog((s) => s.commits);
  const allRows = useGitLog((s) => s.rows);
  const opts = useLogOptions();
  const user = useGitLog((s) => s.user);
  const headCommit = useVcs((s) => s.branch?.headCommit ?? null);
  const branches = useVcs((s) => s.branches);
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);
  // Date, No Merges and First Parent are applied by the backend with parent rewriting,
  // so the graph stays connected under them.
  const collapsed = useMemo(
    () => (opts.collapseLinear ? collapseLinear(all, new Set(headCommit ? [headCommit] : [])) : null),
    [all, opts.collapseLinear, headCommit],
  );
  const commits = collapsed ? collapsed.commits : all;
  const rows = useMemo(() => {
    const laid = collapsed ? computeGraph(collapsed.graph).rows : allRows;
    return opts.longEdges ? laid : hideLongEdges(laid);
  }, [collapsed, allRows, opts.longEdges]);
  const onBranch = useMemo(() => {
    if (!opts.highlightCurrentBranch) return null;
    const reach = reachableFrom(all, headCommit);
    // Nothing to tell apart when only the current branch is shown.
    return all.every((c) => reach.has(c.id)) ? null : reach;
  }, [all, headCommit, opts.highlightCurrentBranch]);
  const loading = useGitLog((s) => s.loading);
  const done = useGitLog((s) => s.done);
  const error = useGitLog((s) => s.error);
  const selected = useGitLog((s) => s.selected);
  const selection = useGitLog((s) => s.selection);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const revealTick = useGitLog((s) => s.revealTick);
  const scrollRef = useRef<HTMLDivElement>(null);
  const finished = done;
  const virtualizer = useVirtualizer({
    count: commits.length + (finished ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  useEffect(() => {
    if (!finished && !loading && last && last.index >= commits.length - 40) void loadMore();
  }, [last, commits.length, finished, loading]);

  const selectedIndex = selected ? commits.findIndex((c) => c.id === selected) : -1;
  useLayoutEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "center" });
    // Only on explicit reveal requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  const visible = useRef(commits);
  visible.current = commits;
  const pick = useCallback((id: string, e: ReactMouseEvent) => {
    if (e.button === 2) {
      if (!useGitLog.getState().selection.includes(id)) selectCommit(id);
    } else if (e.button !== 0) return;
    else if (e.shiftKey) extendCommitSelection(id, visible.current);
    else if (e.metaKey || e.ctrlKey) toggleCommitSelection(id);
    else selectCommit(id);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const lead = selectedIndex >= 0 ? commits[selectedIndex] : undefined;
    if (lead && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.key === "ArrowLeft") goToChild(lead);
      else void goToParent(lead);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(commits.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = commits.length - 1;
    else if (e.key === "PageDown") next = Math.min(commits.length - 1, selectedIndex + 20);
    else if (e.key === "PageUp") next = Math.max(0, selectedIndex - 20);
    else return;
    e.preventDefault();
    const c = commits[next];
    if (c) {
      if (e.shiftKey) extendCommitSelection(c.id, commits);
      else selectCommit(c.id);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  if (error && !commits.length) return <div className={styles.message}>{error}</div>;

  return (
    <div className={styles.listWrap}>
      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        aria-label="Commits"
        aria-multiselectable
        aria-activedescendant={selectedIndex >= 0 ? `commit-${selectedIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {!commits.length && !loading && finished && (
          <div className={styles.message}>{headCommit ? "No commits match the filters" : "No commits yet"}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const c = commits[v.index];
            if (!c)
              return (
                <div key="loading" className={styles.row} style={{ transform: `translateY(${v.start}px)` }}>
                  <Spinner size={12} />{" "}
                  <span className={styles.muted}>
                    <T>Loading…</T>
                  </span>
                </div>
              );
            return (
              <CommitRow
                key={c.id}
                id={`commit-${v.index}`}
                commit={c}
                graph={rows[v.index]}
                top={v.start}
                selected={selectedSet.has(c.id)}
                head={c.id === headCommit}
                mine={opts.highlightMine && isMine(c, user)}
                onBranch={!!onBranch?.has(c.id)}
                opts={opts}
                remoteNames={remoteNames}
                onPick={pick}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  id,
  commit: c,
  graph,
  top,
  selected,
  head,
  mine,
  onBranch,
  opts,
  remoteNames,
  onPick,
}: {
  id: string;
  commit: Commit;
  graph: GraphRow | undefined;
  top: number;
  selected: boolean;
  head: boolean;
  mine: boolean;
  onBranch: boolean;
  opts: LogOptions;
  remoteNames: ReadonlySet<string>;
  onPick: (id: string, e: ReactMouseEvent) => void;
}) {
  const merge = opts.highlightMerges && c.parents.length > 1;
  const refs = c.refs.length > 0 && (
    <RefLabels
      refs={c.refs}
      compact={opts.compactRefs}
      tagNames={opts.tagNames}
      remoteNames={remoteNames}
      left={opts.refsOnLeft}
    />
  );
  const time = opts.commitTimestamp ? (c.commitTimeMs ?? c.timeMs) : c.timeMs;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={clsx(styles.row, onBranch && styles.currentBranch, selected && styles.selected)}
      style={{ transform: `translateY(${top}px)` }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on range clicks
        onPick(c.id, e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, commitMenu(c, selectedCommits()));
      }}
    >
      <span className={styles.colSubject}>
        {graph && <GraphCell row={graph} head={head} />}
        {opts.refsOnLeft && refs}
        <span
          className={clsx(styles.subject, head && styles.headSubject, merge && styles.mergeSubject)}
          title={c.message}
        >
          {c.summary}
        </span>
        {!opts.refsOnLeft && refs}
      </span>
      {opts.showAuthor && (
        <span className={clsx(styles.colAuthor, styles.muted, mine && styles.mine)} title={`${c.author} <${c.email}>`}>
          {c.author}
        </span>
      )}
      {opts.showDate && <span className={clsx(styles.colDate, styles.muted)}>{formatTime(time)}</span>}
      {opts.showHash && <span className={clsx(styles.colHash, styles.muted, styles.hash)}>{c.shortId}</span>}
    </div>
  );
});

function x(lane: number) {
  return LANE / 2 + lane * LANE;
}

function seg(fromX: number, fromY: number, toX: number, toY: number) {
  if (fromX === toX) return `M${fromX} ${fromY}L${toX} ${toY}`;
  const mid = (fromY + toY) / 2;
  return `M${fromX} ${fromY}C${fromX} ${mid} ${toX} ${mid} ${toX} ${toY}`;
}

export function GraphCell({ row, head }: { row: GraphRow; head?: boolean }) {
  const width = Math.min(row.width, 24) * LANE;
  const cy = ROW / 2;
  return (
    <svg className={styles.graph} width={width} height={ROW} aria-hidden>
      {row.up.map((s, i) => (
        <path
          key={`u${i}`}
          d={seg(x(s.from), 0, x(s.to), cy) + (s.arrow ? arrowHead(x(s.from), 0, -1) : "")}
          stroke={laneColor(s.color)}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {row.down.map((s, i) => (
        <path
          key={`d${i}`}
          d={seg(x(s.from), cy, x(s.to), ROW) + (s.arrow ? arrowHead(x(s.to), ROW, 1) : "")}
          stroke={laneColor(s.color)}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      <circle
        cx={x(row.lane)}
        cy={cy}
        r={head ? 4 : 3.2}
        fill={head ? "var(--bg-app)" : laneColor(row.color)}
        stroke={laneColor(row.color)}
        strokeWidth={head ? 2 : 0}
      />
    </svg>
  );
}

/** Arrow head at (`px`, `py`) pointing up (`dir` -1) or down (1): a long edge continues. */
function arrowHead(px: number, py: number, dir: 1 | -1) {
  const back = py - dir * 4;
  return `M${px - 3} ${back}L${px} ${py}L${px + 3} ${back}`;
}

const REF_KIND_CLASS = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

const NO_REMOTES: ReadonlySet<string> = new Set();

export function RefLabels({
  refs,
  compact = false,
  tagNames = true,
  remoteNames = NO_REMOTES,
  left = false,
}: {
  refs: string[];
  compact?: boolean;
  tagNames?: boolean;
  remoteNames?: ReadonlySet<string>;
  left?: boolean;
}) {
  const labels = refLabels(refs, { compact, tagNames }, remoteNames);
  return (
    <span className={clsx(styles.refs, left && styles.refsLeft)}>
      {labels.map((l) => (
        <span key={`${l.kind}:${l.title}`} className={clsx(styles.ref, REF_KIND_CLASS[l.kind])} title={l.title}>
          {l.text}
        </span>
      ))}
    </span>
  );
}

/**
 * The selected commits' changes: one commit's files against its first parent, or, for several
 * (IDEA), their combined changes with every selected commit listed below.
 */
export function CommitDetails({ commits }: { commits: Commit[] }) {
  const selected = useGitLog((s) => s.selected);
  const selection = useGitLog((s) => s.selection);
  // Newest first (log order).
  const chosen = useMemo(() => {
    const ids = new Set(selection);
    return commits.filter((c) => ids.has(c.id));
  }, [commits, selection]);
  const commit = selected ? commits.find((c) => c.id === selected) : undefined;
  const many = chosen.length > 1;
  const idsKey = many ? chosen.map((c) => c.id).join(" ") : (selected ?? "");
  const root = useVcs((s) => s.root) ?? "";
  const [files, setFiles] = useState<(ChangedFile | RevisionChange)[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!idsKey) return;
    const ids = idsKey.split(" ");
    let alive = true;
    const load =
      ids.length > 1
        ? call(commands.vcsCommitsChanges(currentRepo(), ids.reverse()))
        : call(commands.vcsCommitFiles(currentRepo(), ids[0]!));
    load.then((f) => alive && setFiles(f)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [idsKey]);

  const tree = useMemo(() => buildFileTree(files ?? [], (f) => relTo(root, f.path)), [files, root]);
  const allDirs = useMemo(() => dirKeys(tree), [tree]);

  if (!commit)
    return (
      <div className={styles.details}>
        <EmptyState>
          <T>Select a commit to view changes</T>
        </EmptyState>
      </div>
    );

  const open = (f: ChangedFile) => {
    const all = files ?? [f];
    void openDiff(
      withChain(
        all.map((x) => (many ? revisionChangeDiffData(x as RevisionChange) : commitFileDiffData(commit, x))),
        Math.max(0, all.indexOf(f)),
      ),
    );
  };

  return (
    <div className={styles.details}>
      <SplitGroup orientation="vertical" id="git-log-details">
        <SplitPanel id="files" defaultSize="60%" minSize="60px">
          <div className={styles.filesPane}>
            <div className={styles.detailsBar} role="toolbar" aria-label="Changed files">
              <span className={styles.detailsCount}>
                {files ? `${files.length} file${files.length === 1 ? "" : "s"}` : ""}
                {many ? ` in ${chosen.length} commits` : ""}
              </span>
              <span className={styles.grow} />
              <IconButton
                icon="expand-all"
                title="Expand All"
                size="small"
                onClick={() => setExpanded(new Set(allDirs))}
              />
              <IconButton
                icon="collapse-all"
                title="Collapse All"
                size="small"
                onClick={() => setExpanded(new Set())}
              />
            </div>
            {error && <div className={styles.message}>{error}</div>}
            {!files && !error && (
              <div className={styles.message}>
                <Spinner size={12} />
              </div>
            )}
            {files && (
              <Tree<FileTreeNode<ChangedFile>>
                roots={tree}
                getKey={(n) => n.key}
                getLabel={(n) => n.name}
                getChildren={(n) => (n.file ? undefined : n.children)}
                isExpandable={(n) => !n.file}
                expanded={expanded ?? new Set(allDirs)}
                onExpandedChange={(next) => setExpanded(next)}
                multiSelect={false}
                renderNode={(n) => <ChangedFileRow node={n} />}
                onActivate={(n) => n.file && open(n.file)}
                aria-label="Changed files"
                className={styles.fileTree}
              />
            )}
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="message" minSize="60px">
          <div className={styles.messageBox}>
            {many ? (
              chosen.map((c) => <CommitMessage key={c.id} commit={c} compact />)
            ) : (
              <CommitMessage commit={commit} />
            )}
          </div>
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

/** A commit's message and metadata; `compact` (one of several selected): without the body. */
function CommitMessage({ commit, compact = false }: { commit: Commit; compact?: boolean }) {
  const [subject, ...bodyLines] = commit.message.replace(/\s+$/, "").split("\n");
  const body = compact ? "" : bodyLines.join("\n").replace(/^\n+/, "");
  return (
    <div className={clsx(compact && styles.commitEntry)}>
      <div className={styles.subjectLine}>
        <IssueText text={subject ?? ""} />
      </div>
      {body && (
        <div className={styles.fullMessage}>
          <IssueText text={body} />
        </div>
      )}
      <div className={clsx(styles.meta, compact && styles.metaCompact)}>
        <button
          type="button"
          className={clsx(styles.linkButton, styles.hash)}
          title="Copy revision number"
          onClick={() => void navigator.clipboard?.writeText(commit.id)}
        >
          {commit.shortId}
        </button>{" "}
        {commit.author} &lt;{commit.email}&gt;
        {commit.timeMs ? ` on ${new Date(commit.timeMs).toLocaleString()}` : ""}
      </div>
      {commit.parents.length > 1 && (
        <div className={styles.meta}>Merge of {commit.parents.map((p) => p.slice(0, 8)).join(", ")}</div>
      )}
      {commit.refs.length > 0 && (
        <div className={styles.meta}>
          <RefLabels refs={commit.refs} />
        </div>
      )}
    </div>
  );
}

function ChangedFileRow({ node }: { node: FileTreeNode<ChangedFile> }) {
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} className={styles.fileIcon} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDir}>
          {node.count} file{node.count === 1 ? "" : "s"}
        </span>
      </span>
    );
  const f = node.file;
  const kind: EffectiveKind = f.kind === "untracked" ? "added" : f.kind;
  return (
    <span className={styles.fileRow} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <Icon name={fileIconName(node.name)} size={16} className={styles.fileIcon} />
      <span className={styles.fileName} style={{ color: KIND_COLOR[kind] }}>
        {node.name}
      </span>
      {f.oldPath && <span className={styles.fileDir}>renamed from {baseName(f.oldPath)}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Console

function ConsoleView() {
  const lines = useVcsConsole((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className={styles.consoleWrap}>
      <div className={styles.consoleBar}>
        <IconButton icon="trash" title="Clear All" size="small" onClick={clearConsole} />
      </div>
      <div
        ref={ref}
        className={styles.console}
        role="log"
        aria-label="Git console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
      >
        {!lines.length && (
          <div className={styles.muted}>
            <T>Git commands run by the IDE appear here.</T>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={clsx(styles.line, styles[`line-${l.kind}`])}>
            {l.kind === "cmd" && (
              <span className={styles.time}>{new Date(l.time).toLocaleTimeString(undefined, { hour12: false })} </span>
            )}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
