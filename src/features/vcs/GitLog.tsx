import { branchesByRepo, commitKey, commitRepo, graphCommit, type RepoCommit } from "./multiRoot";
/** Git tool window: Log (graph, filters, commit details) and Console tabs. */
import { IssueText } from "./issueLinks";
import { BranchFilterPopup } from "./BranchFilterPopup";
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
import type { Branch, ChangedFile, Commit, RevisionChange } from "@/bindings";
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
  copyText,
} from "@/ui";
import { hasPrimaryModifier } from "@/platform/keymap";
import { collapseLinear, computeGraph, hideLongEdges, laneColor, reachableFrom, type GraphRow } from "./graph";
import {
  closeLogTab,
  extendCommitSelection,
  goToChild,
  goToParent,
  initLogBranchFilter,
  isPushed,
  isMine,
  loadMore,
  ME,
  dateRangeLabel,
  refsSignature,
  reloadLog,
  selectCommit,
  selectGitTab,
  selectedCommits,
  setLogBranches,
  setLogFilters,
  toggleCommitSelection,
  updateLogOptions,
  useGitLog,
} from "./logStore";
import { logOptions, refLabels, useLogOptions, type LogOptions } from "./logOptions";
import { KIND_COLOR, baseName, dirName, fileCount, formatTime, relTo, type EffectiveKind } from "./model";
import { clearConsole, useVcsConsole } from "./ops";
import { currentRepo, loadBranches, repoName, useVcs } from "./store";
import { loadFavoriteBranches, useFavoriteBranches } from "./branchOps";
import { branchMenu, inRepo, tagMenu } from "./branchMenu";
import {
  branchFolderKeys,
  branchGroupKeys,
  buildBranchTree,
  buildRepositoryBranchTree,
  filterBranchTree,
  isFavoriteBranch,
  type BranchTreeNode,
} from "./branches";
import { chooseDateRange, chooseMany, promptText } from "./dialogs";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import {
  absolutePath,
  filesUnder,
  flatFileNodes,
  showChangesDiff,
  toLogChanges,
  useLogChanges,
  type LogChange,
} from "./logChanges";
import { canDeleteBranch, canUpdateBranch, useBranchesPane, type BranchTarget } from "./logPaneActions";
import styles from "./GitLog.module.css";
import { tx } from "@/platform/i18n";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { gitTabs, shownTab } from "./gitTabs";
import { ChangesTree, StashContent, tabItems, useStashTabCounts } from "./CommitView";
import { WorktreesPanel } from "./gitMenuDialogs";

const ROW = 22;
const LANE = 12;

/** The Git window's tabs (they depend on the commit interface) and the one shown. */
function useGitTabs() {
  const available = useVcs((s) => s.available);
  const modal = useWorkflowSettings((s) => !s.vcs.commit.nonModal);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = useGitLog((s) => s.tab);
  const logTabs = useGitLog((s) => s.logTabs);
  const counts = useStashTabCounts(available && modal);
  const tabs = gitTabs({ modal, combine, tab, logTabs, ...counts });
  return { tabs, shown: shownTab(tab, tabs, combine) };
}

/** Tool window header: [Local Changes / Stash…] Log, log tabs, Console and Worktrees content tabs. */
export function GitTabs() {
  const available = useVcs((s) => s.available);
  const { tabs, shown } = useGitTabs();
  if (!available) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.headerTabs}
      activeId={shown}
      onSelect={selectGitTab}
      onClose={closeLogTab}
      aria-label="Git"
      panelIdPrefix="openidea-git"
      items={tabItems(tabs)}
    />
  );
}

export function GitToolWindow() {
  const { shown } = useGitTabs();
  const shownLog = useGitLog((s) => s.shownLog);
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
      id={`openidea-git-panel-${shown}`}
      aria-labelledby={`openidea-git-tab-${shown}`}
    >
      {shown === "changes" ? (
        <ChangesTree mode="local" />
      ) : shown === "shelf" || shown === "stashes" ? (
        <StashContent tab={shown} />
      ) : shown === "console" ? (
        <ConsoleView />
      ) : shown === "worktrees" ? (
        <WorktreesPanel className={styles.worktrees} listClassName={styles.worktreeList} />
      ) : (
        // Each log tab has its own view (its filters and commits are swapped into the store).
        <LogView key={shownLog} />
      )}
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
  const repo = useVcs((s) => s.roots);
  const showBranches = useLogOptions((s) => s.showBranches);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const lastRefs = useRef<string | null>(null);
  const allRefs = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    void branchesByRepo(repo)
      .then((all) => {
        if (!live) return;
        const signature = JSON.stringify(all);
        if (allRefs.current !== null && allRefs.current !== signature) void reloadLog();
        allRefs.current = signature;
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo, version]);

  // On mount, when the window switches to another project and when another of its
  // repositories is selected (its branches are needed to notice its refs moving).
  useEffect(() => {
    lastRefs.current = null;
    allRefs.current = null;
    if (!useGitLog.getState().commits.length) void reloadLog();
    void loadBranches().catch(() => undefined);
  }, [root, repo]);

  // Once the repository's branches are known, settle the branch filter (the
  // remembered refs, else the current branch) and load the log with it.
  useEffect(() => {
    if (!branchesLoaded) return;
    // The refs the log is loaded with, so the first checkout or commit after this reloads it.
    const { branch, branches } = useVcs.getState();
    lastRefs.current = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const settled = initLogBranchFilter();
    const { commits, loading } = useGitLog.getState();
    if (settled || (!commits.length && !loading)) void reloadLog();
  }, [root, repo, branchesLoaded]);

  // HEAD or a branch tip moved (commit, undo, reset, rebase, fetch…): reload (keeps the selection).
  useEffect(() => {
    const { branch, branches, branchesLoaded } = useVcs.getState();
    if (!branchesLoaded) return;
    const refs = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const previous = lastRefs.current;
    lastRefs.current = refs;
    if (previous !== null && previous !== refs && useGitLog.getState().commits.length) void reloadLog();
  }, [version]);

  return (
    // Its own layout without the Branches pane, so each keeps its sizes.
    <SplitGroup
      key={showBranches ? "branches" : "no-branches"}
      orientation="horizontal"
      id={showBranches ? "git-log" : "git-log-no-branches"}
      className={styles.split}
    >
      {showBranches && (
        <>
          <SplitPanel id="branches" defaultSize="18%" minSize="120px">
            <BranchesPanel />
          </SplitPanel>
          <SplitHandle />
        </>
      )}
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
  return [b.current ? tx("current") : "", sync].filter(Boolean).join("  ") || undefined;
}

export function BranchesPanel() {
  const selectedBranches = useVcs((s) => s.branches);
  const repositories = useVcs((s) => s.roots);
  const version = useVcs((s) => s.version);
  const [allBranches, setAllBranches] = useState<Record<string, Branch[]>>({});
  const [allTags, setAllTags] = useState<Record<string, string[]>>({});
  const branches = selectedBranches;
  const root = useVcs((s) => s.root);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const current = useVcs((s) => s.branch?.head ?? null);
  const favorites = useFavoriteBranches((s) => s.names);
  const filterBranches = useGitLog((s) => s.filters.branches);
  const filterRepositories = useGitLog((s) => s.filters.repositories);
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => loadFavoriteBranches(), [root]);
  // Branches reload when refs move (fetch, new tag…): the tags are re-read with them.
  useEffect(() => {
    let live = true;
    call(commands.vcsTags(currentRepo())).then(
      (t) => live && setTags(t),
      () => live && setTags([]),
    );
    return () => {
      live = false;
    };
  }, [root, branches]);
  useEffect(() => {
    let live = true;
    void branchesByRepo(repositories)
      .then((value) => live && setAllBranches(value))
      .catch(() => undefined);
    void Promise.all(repositories.map(async (r) => [r, await call(commands.vcsTags(r))] as const))
      .then((value) => live && setAllTags(Object.fromEntries(value)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repositories, version]);
  const allRoots = useMemo(() => {
    if (repositories.length < 2) return buildBranchTree(branches, favorites, tags);
    return buildRepositoryBranchTree(
      repositories.map((repo) => ({
        root: repo,
        name: repoName(repo),
        branches: allBranches[repo] ?? [],
        tags: allTags[repo] ?? [],
      })),
      favorites,
    );
  }, [repositories, allBranches, allTags, branches, favorites, tags]);
  const roots = useMemo(() => filterBranchTree(allRoots, query), [allRoots, query]);
  // While searching every match is shown expanded.
  const searchExpanded = useMemo(() => (query.trim() ? new Set(branchGroupKeys(roots)) : undefined), [roots, query]);
  // Highlighted rows: a click only selects (IDEA), and only a double click or
  // Enter switches the log, so the selection is the pane's own state. It still
  // follows the filter when something else changes it (Show Log, the filter bar).
  const filterKeys = useMemo(
    () =>
      filterBranches.flatMap((b) => {
        if (b === "HEAD") return ["head"];
        if (repositories.length < 2) return [`b:${b}`];
        return (filterRepositories?.length ? filterRepositories : repositories).map((r) => `${r}:b:${b}`);
      }),
    [filterBranches, filterRepositories, repositories],
  );
  const filterKey = filterKeys.join("\n");
  const [shownKey, setShownKey] = useState(filterKey);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(filterKeys));
  if (shownKey !== filterKey) {
    // The filter changed elsewhere (Show Log, the filter bar): highlight it.
    setShownKey(filterKey);
    setSelected(new Set(filterKeys));
  }
  // Refs in tree order, for Copy: full refs, so the folder path comes along
  // (`feat/x`, `origin/main`).
  const refs = useMemo(() => {
    const out: { key: string; ref: string; branch?: Branch; repo?: string }[] = [];
    const walk = (nodes: readonly BranchTreeNode[]) => {
      for (const n of nodes) {
        if (n.ref) out.push({ key: n.key, ref: n.ref, branch: n.branch, repo: n.repo });
        walk(n.children ?? []);
      }
    };
    walk(allRoots);
    return out;
  }, [allRoots]);
  const targets = useMemo(
    (): BranchTarget[] =>
      refs.filter((r) => selected.has(r.key)).map(({ ref, branch, repo }) => ({ ref, branch, repo })),
    [refs, selected],
  );
  useEffect(() => {
    useBranchesPane.setState({ selected: targets });
  }, [targets]);
  useEffect(() => () => useBranchesPane.setState({ selected: [] }), []);
  const target = targets[0] ?? undefined;
  const favorite = !!target?.branch && isFavoriteBranch(target.branch, favorites);
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "c" && e.key !== "C") || !hasPrimaryModifier(e) || e.altKey || e.shiftKey) return;
    // The branch search keeps the browser's own copy.
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const names = targets.map((r) => r.ref);
    if (!names.length) return;
    e.preventDefault();
    e.stopPropagation();
    void copyText(names.join("\n"));
  };
  return (
    <div className={styles.branches} onKeyDownCapture={onKeyDownCapture}>
      <div className={styles.branchesTools} role="toolbar" aria-orientation="vertical" aria-label={tx("Branches")}>
        <IconButton icon="chevron-left" title="Hide Branches" size="small" action="vcs.log.showBranches" />
        <IconButton icon="plus" title="New Branch…" size="small" action="vcs.log.branches.new" actionArg={target} />
        <IconButton
          icon="git-pull"
          size="small"
          title="Update Selected"
          action="vcs.log.branches.update"
          actionArg={target}
          disabled={!canUpdateBranch(target ?? null)}
        />
        <IconButton
          icon="trash"
          size="small"
          title="Delete Branch"
          action="vcs.log.branches.delete"
          actionArg={target}
          disabled={!canDeleteBranch(target ?? null)}
        />
        <IconButton
          icon="locate"
          size="small"
          title="Navigate Log to Selected Branch"
          action="vcs.log.branches.navigate"
          actionArg={target}
          disabled={!target}
        />
        <IconButton
          icon={favorite ? "star" : "star-outline"}
          title={favorite ? "Remove from Favorites" : "Add to Favorites"}
          size="small"
          action="vcs.log.branches.toggleFavorite"
          actionArg={target}
          pressed={favorite}
          disabled={!target?.branch}
        />
        <IconButton icon="git-fetch" title="Fetch" size="small" action="vcs.fetch" />
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void loadBranches()} />
      </div>
      <div className={styles.branchesMain}>
        <div className={styles.branchesBar}>
          <SearchField
            className={styles.branchSearch}
            value={query}
            onChange={setQuery}
            placeholder="Branch or tag"
            aria-label="Filter branches and tags"
          />
        </div>
        <Tree<BranchTreeNode>
          key={`${root ?? ""}:${branchesLoaded}`}
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) => (n.kind === "head" || n.kind === "group" ? tx(n.label) : n.label)}
          getChildren={(n) => n.children}
          isExpandable={(n) => !!n.children}
          defaultExpanded={[
            ...branchGroupKeys(allRoots),
            "g:local",
            "g:remote",
            ...roots.flatMap((r) => r.children?.filter((c) => c.kind === "remote").map((c) => c.key) ?? []),
            ...(current ? branchFolderKeys(roots, current) : []),
          ]}
          expanded={searchExpanded}
          getIcon={(n) =>
            n.kind === "head"
              ? "commit"
              : n.kind === "tag"
                ? "tag"
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
          onSelectionChange={(sel) => setSelected(sel)}
          onActivate={(n) => {
            // IDEA: double click (or Enter) switches the log to that ref, or to every
            // selected one when it is part of a multi-selection; checking out stays in the context menu.
            if (!n.ref) return;
            const sel = selected.has(n.key) ? targets.filter((r) => r.repo === n.repo).map((r) => r.ref) : [n.ref];
            setLogFilters({ branches: sel, repositories: n.repo ? [n.repo] : [] });
          }}
          onContextMenu={(n, _s, e) => {
            const menu = n?.branch
              ? branchMenu(n.branch, n.repo ? (useVcs.getState().heads[n.repo]?.head ?? null) : current)
              : n?.kind === "tag"
                ? tagMenu(n.ref!)
                : [];
            const items = n?.repo ? inRepo(n.repo, menu) : menu;
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
    </div>
  );
}

// --- filters ----------------------------------------------------------------

const DAY = 86_400_000;
/** Keyboard moves through several files quickly: preview the one the selection settles on. */
const PREVIEW_DELAY = 120;

function fileNodeAt<F>(nodes: readonly FileTreeNode<F>[], key: string): FileTreeNode<F> | null {
  for (const n of nodes) {
    if (n.key === key) return n.file ? n : null;
    if (!n.file) {
      const hit = fileNodeAt(n.children, key);
      if (hit) return hit;
    }
  }
  return null;
}
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
            {tx(label)}: <span className={styles.filterValue}>{value}</span>
          </>
        ) : (
          tx(label)
        )}
        {!value && <Icon name="chevron-down" size={12} className={styles.filterChevron} />}
      </button>
      {value && (
        <button
          type="button"
          className={styles.filterClear}
          aria-label={tx`Clear ${tx(label)} filter`}
          onClick={onClear}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

function FilterBar() {
  const filters = useGitLog((s) => s.filters);
  const commits = useGitLog((s) => s.commits);
  const selectedBranches = useVcs((s) => s.branches);
  const [branches, setBranches] = useState(selectedBranches);
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root);
  const repositories = useVcs((s) => s.roots);
  const showBranches = useLogOptions((s) => s.showBranches);
  useEffect(() => {
    let live = true;
    const roots = filters.repositories?.length ? filters.repositories : repositories;
    void branchesByRepo(roots)
      .then((all) => {
        if (live)
          setBranches([
            ...new Map(
              Object.values(all)
                .flat()
                .map((b) => [b.name, b]),
            ).values(),
          ]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repositories, filters.repositories, version]);
  const [text, setText] = useState(filters.text);
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);

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

  const branchNames = () => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);

  const selectBranches = async () => {
    setBranchAnchor(null);
    const r = await chooseMany({
      title: "Filter by Branch",
      options: ["HEAD", ...branchNames()],
      initial: filters.branches,
      customLabel: "Other revisions (comma-separated):",
    });
    if (r) setLogBranches(r);
  };

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
    <div className={styles.filters} role="toolbar" aria-label={tx("Log filters")}>
      {!showBranches && (
        <IconButton icon="chevron-right" title="Show Branches" size="small" action="vcs.log.showBranches" />
      )}
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
      {repositories.length > 1 && (
        <FilterButton
          label="Repository"
          value={filters.repositories?.map(repoName).join(", ") || null}
          onOpen={(e) =>
            menuBelow(
              e,
              repositories.map((repo) => ({
                label: repoName(repo),
                checked: filters.repositories?.includes(repo) ?? false,
                run: () => setLogFilters({ repositories: [repo] }),
              })),
            )
          }
          onClear={() => setLogFilters({ repositories: [] })}
        />
      )}
      <FilterButton
        label="Branch"
        value={filters.branches.join(", ") || null}
        onOpen={(e) => setBranchAnchor(e.currentTarget)}
        onClear={() => setLogBranches([])}
      />
      {branchAnchor && (
        <BranchFilterPopup
          anchor={branchAnchor}
          branches={branches}
          selected={filters.branches}
          onClose={() => setBranchAnchor(null)}
          onSelect={(branch) => {
            setLogBranches([branch]);
            setBranchAnchor(null);
          }}
          onSelectMany={() => void selectBranches()}
        />
      )}
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
    { kind: "action", action: "vcs.log.collapseLinear" },
    { kind: "action", action: "vcs.log.expandLinear" },
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
  const many = selection.length > 1 && selection.some((x) => commitKey(x) === commitKey(c));
  const head = (commitRepo(c) ? useVcs.getState().heads[commitRepo(c)!]?.head : useVcs.getState().branch?.head) ?? null;
  const { outgoing } = useGitLog.getState();
  const pushed = (x: Commit) =>
    commitRepo(x) === undefined ? !!outgoing && !outgoing.has(x.id) : isPushed(commitKey(x));
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
  const pushedCommit = pushed(c);
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere =
    !!head &&
    ((commitRepo(c) === undefined ? !!outgoing : useGitLog.getState().tracked.has(commitRepo(c) ?? ""))
      ? !!outgoing?.has(commitKey(c))
      : true);
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
    { kind: "action", action: "vcs.log.editMessage", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.fixup", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.squashInto", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.dropCommit", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.interactiveRebase", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.pushUpToHere", arg: c, disabled: !canPushHere },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.rebaseOntoCommit",
      arg: c,
      label: tx`Rebase '${head ?? "HEAD"}' onto Selected Commit`,
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
  const heads = useVcs((s) => s.heads);
  const headKeys = useMemo(
    () =>
      new Set(
        all.filter((c) => c.id === (commitRepo(c) ? heads[commitRepo(c)!]?.headCommit : headCommit)).map(commitKey),
      ),
    [all, heads, headCommit],
  );
  const collapsed = useMemo(
    () => (opts.collapseLinear ? collapseLinear(all.map(graphCommit), headKeys) : null),
    [all, opts.collapseLinear, headKeys],
  );
  const commits = useMemo(() => {
    if (!collapsed) return all;
    const byKey = new Map(all.map((c) => [commitKey(c), c]));
    return collapsed.commits.map((c) => byKey.get(c.id)!);
  }, [all, collapsed]);
  const rows = useMemo(() => {
    const laid = collapsed ? computeGraph(collapsed.graph).rows : allRows;
    return opts.longEdges ? laid : hideLongEdges(laid);
  }, [collapsed, allRows, opts.longEdges]);
  const onBranch = useMemo(() => {
    if (!opts.highlightCurrentBranch) return null;
    const reach = new Set<string>();
    for (const head of headKeys) for (const id of reachableFrom(all.map(graphCommit), head)) reach.add(id);
    // Nothing to tell apart when only the current branch is shown.
    return all.every((c) => reach.has(commitKey(c))) ? null : reach;
  }, [all, headKeys, opts.highlightCurrentBranch]);
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

  const selectedIndex = selected ? commits.findIndex((c) => commitKey(c) === selected) : -1;
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
      if (e.shiftKey) extendCommitSelection(commitKey(c), commits);
      else selectCommit(commitKey(c));
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  if (error && !commits.length) return <div className={styles.message}>{error}</div>;

  return (
    <div className={styles.listWrap}>
      {error && (
        <div role="alert" className={styles.message}>
          {error}
        </div>
      )}
      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        aria-label={tx("Commits")}
        aria-multiselectable
        aria-activedescendant={selectedIndex >= 0 ? `commit-${selectedIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {!commits.length && !loading && finished && (
          <div className={styles.message}>{headCommit ? tx("No commits match the filters") : tx("No commits yet")}</div>
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
                key={commitKey(c)}
                id={`commit-${v.index}`}
                commit={c}
                graph={rows[v.index]}
                top={v.start}
                selected={selectedSet.has(commitKey(c))}
                head={headKeys.has(commitKey(c))}
                mine={opts.highlightMine && isMine(c, user)}
                onBranch={!!onBranch?.has(commitKey(c))}
                opts={opts}
                remoteNames={new Set((c as RepoCommit).remoteNames ?? remoteNames)}
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
        onPick(commitKey(c), e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, commitMenu(c, selectedCommits()));
      }}
    >
      {commitRepo(c) && useVcs.getState().roots.length > 1 && (
        <span className={styles.colRepository} title={commitRepo(c)!}>
          {repoName(commitRepo(c)!)}
        </span>
      )}
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
    return commits.filter((c) => ids.has(commitKey(c)));
  }, [commits, selection]);
  const commit = selected ? commits.find((c) => commitKey(c) === selected) : undefined;
  const many = chosen.length > 1;
  const idsKey = chosen.map(commitKey).join(" ");
  const commitRoot = commit ? commitRepo(commit) : null;
  const root = useVcs((s) => s.root) ?? "";
  const [files, setFiles] = useState<(ChangedFile | RevisionChange)[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!idsKey) return;
    const ids = chosen.map((c) => c.id);
    let alive = true;
    const load =
      ids.length > 1
        ? call(commands.vcsCommitsChanges(commitRoot ?? currentRepo(), ids.reverse()))
        : call(commands.vcsCommitFiles(commitRoot ?? currentRepo(), ids[0]!));
    load.then((f) => alive && setFiles(f)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [idsKey]);

  const groupByDirectory = useLogOptions((s) => s.groupByDirectory);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const changes = useMemo(
    () => (files && commit ? toLogChanges(files, many ? null : commit, commitRoot) : []),
    [files, commit, many, commitRoot],
  );
  const tree = useMemo(
    () =>
      groupByDirectory
        ? buildFileTree(changes, (f) => relTo(root, f.path))
        : flatFileNodes(changes, (f) => relTo(root, f.path)),
    [changes, root, groupByDirectory],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);
  const ordered = useMemo(() => filesUnder(tree), [tree]);
  const chosenChanges = useMemo(() => filesUnder(tree, selectedKeys), [tree, selectedKeys]);

  // Show Diff Preview: a single selected file follows into the editor's preview tab.
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const previewSelection = (sel: ReadonlySet<string>) => {
    clearTimeout(previewTimer.current);
    if (!logOptions().diffPreview || sel.size !== 1) return;
    const file = fileNodeAt(tree, [...sel][0]!)?.file;
    // A preview that cannot open (no editor yet, the file went away) is just skipped.
    if (file)
      previewTimer.current = setTimeout(() => void showChangesDiff([file], true).catch(() => undefined), PREVIEW_DELAY);
  };

  useEffect(() => {
    useLogChanges.setState({ commits: chosen, all: ordered, selected: chosenChanges });
  }, [chosen, ordered, chosenChanges]);
  useEffect(() => () => useLogChanges.setState({ commits: [], all: [], selected: [] }), []);

  if (!commit)
    return (
      <div className={styles.details}>
        <EmptyState>
          <T>Select a commit to view changes</T>
        </EmptyState>
      </div>
    );

  const openViewOptions = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      { kind: "header", label: "Group By" },
      { kind: "action", action: "vcs.log.changes.groupByDirectory" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.changes.diffPreview" },
    ]);

  const onFileMenu = (node: FileTreeNode<LogChange> | null, sel: ReadonlySet<string>, e: ReactMouseEvent) => {
    if (!node) return;
    const target = sel.has(node.key) ? filesUnder(tree, sel) : filesUnder([node]);
    if (!target.length) return;
    e.preventDefault();
    showContextMenu(e, changesMenu(target));
  };

  return (
    <div className={styles.details}>
      <SplitGroup orientation="vertical" id="git-log-details">
        <SplitPanel id="files" defaultSize="60%" minSize="60px">
          <div className={styles.filesPane}>
            <div className={styles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
              <IconButton
                icon="diff"
                size="small"
                title="Show Diff"
                action="vcs.log.changes.showDiff"
                actionArg={chosenChanges}
                disabled={!chosenChanges.length}
              />
              <IconButton
                icon="revert"
                size="small"
                title="Revert Selected Changes"
                action="vcs.log.changes.revert"
                actionArg={chosenChanges}
                disabled={!chosenChanges.length}
              />
              <IconButton icon="eye" title="View Options" size="small" aria-haspopup="menu" onClick={openViewOptions} />
              <span className={styles.detailsCount}>
                {files ? fileCount(files.length) : ""}
                {many ? " " + tx`in ${chosen.length} commits` : ""}
              </span>
              <span className={styles.grow} />
              <IconButton
                icon="expand-all"
                title="Expand All"
                size="small"
                disabled={!allDirs.length}
                onClick={() => setExpanded(new Set(allDirs))}
              />
              <IconButton
                icon="collapse-all"
                title="Collapse All"
                size="small"
                disabled={!allDirs.length}
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
              <Tree<FileTreeNode<LogChange>>
                roots={tree}
                getKey={(n) => n.key}
                getLabel={(n) => n.name}
                getChildren={(n) => (n.file ? undefined : n.children)}
                isExpandable={(n) => !n.file}
                expanded={expanded ?? new Set(allDirs)}
                onExpandedChange={(next) => setExpanded(next)}
                selected={selectedKeys}
                onSelectionChange={(sel) => {
                  setSelectedKeys(sel);
                  previewSelection(sel);
                }}
                renderNode={(n) => <ChangedFileRow node={n} flat={!groupByDirectory} />}
                onActivate={(n) => n.file && void showChangesDiff([n.file])}
                onContextMenu={onFileMenu}
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
              chosen.map((c) => <CommitMessage key={commitKey(c)} commit={c} compact />)
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
          title={tx("Copy revision number")}
          onClick={() => void navigator.clipboard?.writeText(commit.id)}
        >
          {commit.shortId}
        </button>{" "}
        {commit.author} &lt;{commit.email}&gt;
        {commit.timeMs ? " " + tx`on ${new Date(commit.timeMs).toLocaleString()}` : ""}
      </div>
      {commit.parents.length > 1 && (
        <div className={styles.meta}>{tx`Merge of ${commit.parents.map((p) => p.slice(0, 8)).join(", ")}`}</div>
      )}
      {commit.refs.length > 0 && (
        <div className={styles.meta}>
          <RefLabels refs={commit.refs} />
        </div>
      )}
    </div>
  );
}

/** IDEA's changes browser context menu in the Git Log; `changes` = the files it acts on. */
export function changesMenu(changes: LogChange[]): MenuItem[] {
  const one = changes.length === 1 ? changes[0]! : null;
  return [
    { kind: "action", action: "vcs.log.changes.showDiff", arg: changes },
    { kind: "action", action: "vcs.log.changes.compareWithLocal", arg: changes, disabled: !one?.after },
    { kind: "action", action: "vcs.log.changes.compareBeforeWithLocal", arg: changes, disabled: !one?.before },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.changes.jumpToSource",
      arg: changes,
      disabled: !changes.some((c) => c.after),
    },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.changes.revert", arg: changes },
    { kind: "action", action: "vcs.log.changes.getFromRevision", arg: changes },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.showHistory",
      arg: one ? absolutePath(one.path, one.repo) : undefined,
      disabled: !one?.after,
    },
  ];
}

function ChangedFileRow({ node, flat = false }: { node: FileTreeNode<ChangedFile | LogChange>; flat?: boolean }) {
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} className={styles.fileIcon} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDir}>{fileCount(node.count)}</span>
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
      {flat && dirName(f.path) && <span className={styles.fileDir}>{dirName(f.path)}</span>}
      {f.oldPath && <span className={styles.fileDir}>{tx`renamed from ${baseName(f.oldPath)}`}</span>}
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
        aria-label={tx("Git console")}
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
