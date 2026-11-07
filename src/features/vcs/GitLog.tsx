import { useBookmarkPopups } from "@/features/search/bookmarks/store";
import { commitBookmarkPath } from "./logBookmarks";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { branchesByRepo, commitKey, commitRepo, graphCommit, type RepoCommit } from "./multiRoot";
/** Git tool window: Log (graph, filters, commit details) and Console tabs. */
import { IssueText } from "./issueLinks";
import { BranchFilterPopup } from "./BranchFilterPopup";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Branch, ChangedFile, Commit } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { maybeEditorService, useGitLogChecks, type EditorInput } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Popup,
  TOOLTIP_DELAY,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
  T,
  copyText,
  lazyComponent,
} from "@/ui";
import { hasPrimaryModifier } from "@/platform/keymap";
import { laneColor, reachableFrom, type GraphRow, type GraphSegment } from "./graph";
import { nextSpeedMatch } from "./logSearch";
import { presentLogGraph } from "./logPresentation";
import {
  closeLogTab,
  extendCommitSelection,
  goToChild,
  goToParent,
  initLogBranchFilter,
  isPushed,
  isMine,
  loadMore,
  logState,
  loadNewer,
  ME,
  dateRangeLabel,
  refsSignature,
  reloadLog,
  openLogTab,
  recentLogFilters,
  recentFilterValues,
  toggleCommitBookmark,
  selectCommit,
  selectGitTab,
  selectedCommits,
  setLogBranches,
  setLogFilters,
  toggleCommitSelection,
  toggleRepository,
  updateLogOptions,
  useGitLog,
  PAGE,
} from "./logStore";
import { logOptions, refLabels, useLogOptions, type LogOptions } from "./logOptions";
import { KIND_COLOR, baseName, dirName, fileCount, formatTime, relTo, type EffectiveKind } from "./model";
import { clearConsole, useVcsConsole } from "./ops";
import { currentRepo, currentRepoRoot, loadBranches, repoName, useVcs } from "./store";
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
import { chooseDateRange, chooseMany } from "./dialogs";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { DIFF_KIND, diffInput } from "./diffInput";
import {
  absolutePath,
  filesUnder,
  flatFileNodes,
  showChangesDiff,
  toLogChanges,
  useLogChanges,
  withLineStats,
  type LogChange,
} from "./logChanges";
import { canDeleteBranch, canUpdateBranch, useBranchesPane, type BranchTarget } from "./logPaneActions";
import styles from "./GitLog.module.css";
import { tx } from "@/platform/i18n";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { gitTabs, shownTab } from "./gitTabs";
import { LocalChangesView, StashContent, tabItems, useStashTabCounts } from "./CommitView";
import { WorktreesPanel } from "./gitMenuDialogs";
import { chooseLogPaths } from "./PathFilterDialog";
import { goToRef } from "./logStore";
import { LogIdContext } from "./logContext";
import { LogScope } from "./LogScope";
import { browseRepositoryAt, openExternalLog } from "./RevisionBrowser";
import { invalidateLogDetails, loadLogDetails, useCommitDetails } from "./logDetails";

const ROW = 26;
const LANE = 14;
interface LogColumn {
  id: string;
  title: string;
  width: number;
  render(commit: Commit): ReactNode;
}
const LogMergePreview = lazyComponent(() => import("./GitMergeDiff").then((m) => m.GitMergeDiff));
const LogDiffPreview = lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor));

function useLogRepositories() {
  const scope = useContext(LogIdContext);
  const tab = useGitLog((s) => s.logTabs.find((t) => t.id === (scope ?? s.shownLog)));
  const roots = useVcs((s) => s.roots);
  const repo = tab?.repo;
  const repositories = tab?.repositories;
  return useMemo(() => (repositories?.length ? repositories : repo ? [repo] : roots), [repo, roots, repositories]);
}

function useReadOnlyLog() {
  const scope = useContext(LogIdContext);
  return useGitLog((s) => s.logTabs.find((t) => t.id === (scope ?? s.shownLog))?.readOnly === true);
}

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
  const external = useGitLog((s) => s.logTabs.some((t) => t.id === s.tab && t.readOnly));
  const { tabs, shown } = useGitTabs();
  if (!available && !external) return null;
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
  const available = useVcs((s) => s.available);
  const external = useGitLog((s) => s.logTabs.some((t) => t.id === s.tab && t.readOnly));
  if (!available && !external)
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
        <LocalChangesView />
      ) : shown === "shelf" || shown === "stashes" ? (
        <StashContent tab={shown} />
      ) : shown === "console" ? (
        <ConsoleView />
      ) : shown === "worktrees" ? (
        <WorktreesPanel className={styles.worktrees} listClassName={styles.worktreeList} />
      ) : (
        // Each log tab has its own view (its filters and commits are swapped into the store).
        <LogScope id={shown}>
          <LogView key={shown} />
        </LogScope>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log

export function LogView() {
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const version = useVcs((s) => s.version);
  const commits = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const root = useVcs((s) => s.root);
  const repo = useLogRepositories();
  const readOnly = useReadOnlyLog();
  const showBranches = useLogOptions((s) => s.showBranches);
  const showDetails = useLogOptions((s) => s.showDetails);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const lastRefs = useRef<string | null>(null);
  const allRefs = useRef<string | null>(null);
  const externalRefs = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      branchesByRepo(repo),
      Promise.all(repo.map(async (root) => [root, await call(commands.vcsLogRefs(root))] as const)),
    ])
      .then(([all, refs]) => {
        if (!live) return;
        const signature = JSON.stringify([all, refs]);
        if (allRefs.current !== null && allRefs.current !== signature) {
          invalidateLogDetails(repo);
          void reloadLog({ preserve: true }, scope ?? undefined);
        }
        allRefs.current = signature;
        if (readOnly) externalRefs.current = JSON.stringify(refs.map(([, value]) => value));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo, version, readOnly, scope]);
  useEffect(() => {
    if (!readOnly) return;
    let live = true;
    const timer = setInterval(() => {
      void Promise.all(repo.map((root) => call(commands.vcsLogRefs(root))))
        .then((refs) => {
          if (!live) return;
          const signature = JSON.stringify(refs);
          if (externalRefs.current && externalRefs.current !== signature) {
            invalidateLogDetails(repo);
            void reloadLog({ preserve: true }, scope ?? undefined);
          }
          externalRefs.current = signature;
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [repo, readOnly, scope]);

  // On mount, when the window switches to another project and when another of its
  // repositories is selected (its branches are needed to notice its refs moving).
  useEffect(() => {
    lastRefs.current = null;
    allRefs.current = null;
    void reloadLog({ preserve: logState(scope ?? undefined).commits.length > 0 }, scope ?? undefined);
    if (!readOnly) void loadBranches().catch(() => undefined);
  }, [root, repo, readOnly, scope]);

  // Once the repository's branches are known, settle the branch filter (the
  // remembered refs, else the current branch) and load the log with it.
  useEffect(() => {
    if (!active) return;
    if (!branchesLoaded) return;
    // The refs the log is loaded with, so the first checkout or commit after this reloads it.
    const { branch, branches } = useVcs.getState();
    lastRefs.current = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const settled = initLogBranchFilter();
    const { commits, loading } = useGitLog.getState();
    if (settled || (!commits.length && !loading)) void reloadLog();
  }, [root, repo, branchesLoaded, active]);

  // HEAD or a branch tip moved (commit, undo, reset, rebase, fetch…): reload (keeps the selection).
  useEffect(() => {
    if (!active) return;
    const { branch, branches, branchesLoaded } = useVcs.getState();
    if (!branchesLoaded) return;
    const refs = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const previous = lastRefs.current;
    lastRefs.current = refs;
    if (previous !== null && previous !== refs && useGitLog.getState().commits.length)
      void reloadLog({ preserve: true });
  }, [version, active]);

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
      {showDetails && (
        <>
          <SplitHandle />
          <SplitPanel id="details" defaultSize="28%" minSize="15%">
            <CommitDetails key={selection.join(" ") || "none"} commits={commits} />
          </SplitPanel>
        </>
      )}
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
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const logGeneration = useGitLog((s) => s.generation);
  const selectedBranches = useVcs((s) => s.branches);
  const repositories = useLogRepositories();
  const readOnly = useReadOnlyLog();
  const version = useVcs((s) => s.version);
  const [allBranches, setAllBranches] = useState<Record<string, Branch[]>>({});
  const [allTags, setAllTags] = useState<Record<string, string[]>>({});
  const currentRepository = currentRepo();
  const branches = useMemo(
    () =>
      repositories.length === 1 && repositories[0] !== currentRepository
        ? (allBranches[repositories[0]!] ?? [])
        : selectedBranches,
    [repositories, currentRepository, allBranches, selectedBranches],
  );
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
    call(commands.vcsTags(repositories[0] ?? currentRepo())).then(
      (t) => live && setTags(t),
      () => live && setTags([]),
    );
    return () => {
      live = false;
    };
  }, [root, branches, repositories]);
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
  }, [repositories, version, logGeneration]);
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
    if (!active) return;
    useBranchesPane.setState({ selected: targets });
    return () => useBranchesPane.setState({ selected: [] });
  }, [targets, active]);
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
        {!readOnly && (
          <>
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
          </>
        )}
        <IconButton
          icon="refresh"
          title="Refresh"
          size="small"
          onClick={() => (readOnly ? void reloadLog({ preserve: true }) : void loadBranches())}
        />
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
            if (readOnly) {
              if (!n?.ref) return;
              e.preventDefault();
              showContextMenu(e, [
                { label: "Show in Git Log", run: () => setLogBranches([n.ref!]) },
                { label: "Copy", run: () => void copyText(n.ref!) },
              ]);
              return;
            }
            const menu = n?.branch
              ? branchMenu(n.branch, n.repo ? (useVcs.getState().heads[n.repo]?.head ?? null) : current)
              : n?.kind === "tag"
                ? tagMenu(n.ref!)
                : n?.kind === "remote" || (n?.kind === "group" && n.key.endsWith("g:remote"))
                  ? REMOTES_MENU
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

/** IDEA: the Remote node and each remote of the Branches pane offer Manage Remotes…. */
const REMOTES_MENU: MenuItem[] = [{ label: "Manage Remotes…", run: () => void executeAction("vcs.manageRemotes") }];

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

function menuBelow(anchor: HTMLElement | ReactMouseEvent<HTMLElement>, items: MenuItem[]) {
  const r = ("currentTarget" in anchor ? anchor.currentTarget : anchor).getBoundingClientRect();
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
}

interface LogFilter {
  label: string;
  value: string | null;
  onOpen: (anchor: HTMLElement) => void;
  onClear: () => void;
}

function FilterButton({ label, value, onOpen, onClear, hidden }: LogFilter & { hidden?: boolean }) {
  return (
    <span
      className={clsx(styles.filterButton, value && styles.filterActive, hidden && styles.filterHidden)}
      inert={hidden}
    >
      <button type="button" className={styles.filterMain} onClick={(e) => onOpen(e.currentTarget)} aria-haspopup="menu">
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
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const logGeneration = useGitLog((s) => s.generation);
  const filters = useGitLog((s) => s.filters);
  const commits = useGitLog((s) => s.commits);
  const selectedBranches = useVcs((s) => s.branches);
  const [branches, setBranches] = useState(selectedBranches);
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root);
  const repositories = useLogRepositories();
  const readOnly = useReadOnlyLog();
  const bookmarks = useGitLog((s) => s.bookmarks);
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
  }, [repositories, filters.repositories, version, logGeneration]);
  const [text, setText] = useState(filters.text);
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);
  // Filters that do not fit move behind a chevron, like a toolbar's overflow.
  const groupRef = useRef<HTMLSpanElement>(null);
  const [hiddenFrom, setHiddenFrom] = useState(Infinity);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const items = [...group.children] as HTMLElement[];
      const i = items.findIndex((el) => el.offsetLeft + el.offsetWidth > group.clientWidth + 1);
      setHiddenFrom(i < 0 ? Infinity : i);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(group);
    for (const el of group.children) ro.observe(el);
    return () => ro.disconnect();
  }, [filters, repositories.length]);

  // Keep the field in sync when filters change elsewhere (Show History, reveal).
  const [seen, setSeen] = useState(filters);
  if (seen !== filters) {
    setSeen(filters);
    setText(filters.text);
  }

  useEffect(() => {
    if (!active || text === filters.text) return;
    const t = setTimeout(() => setLogFilters({ text }), 300);
    return () => clearTimeout(t);
  }, [text, filters.text, active]);

  const branchNames = () => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);

  const selectBranches = async () => {
    setBranchAnchor(null);
    const r = await chooseMany({
      title: "Filter by Branch",
      options: [
        ...new Set([
          "HEAD",
          ...branchNames(),
          ...recentFilterValues("branches").flat(),
          ...recentFilterValues("range").filter((s): s is string => !!s),
        ]),
      ],
      initial: filters.branches,
      customLabel: "Branches, patterns, exclusions or ranges (comma-separated):",
    });
    if (r) setLogBranches(r);
  };

  const openUser = async (anchor: HTMLElement) => {
    const roots = filters.repositories?.length
      ? filters.repositories
      : repositories.length
        ? repositories
        : [currentRepo()];
    const users = await Promise.all(roots.map((repo) => call(commands.vcsLogUsers(repo)).catch(() => [] as string[])));
    const authors = [...new Set(users.flat().concat(commits.map((c) => `${c.author} <${c.email}>`)))].sort((a, b) =>
      a.localeCompare(b),
    );
    menuBelow(anchor, [
      ...recentFilterValues("authors").map((authors) => ({
        label: authors.join(", "),
        run: () => setLogFilters({ authors }),
      })),
      { label: ME, checked: filters.authors.includes(ME), run: () => setLogFilters({ authors: [ME] }) },
      ...(authors.length ? [{ kind: "separator" as const }] : []),
      ...authors.slice(0, 30).map((a) => ({
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

  const openDate = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      ...recentFilterValues("date")
        .filter((date) => date != null)
        .map((date) => ({ label: date.label, run: () => setLogFilters({ date }) })),
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

  const openPaths = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      ...recentFilterValues("paths")
        .filter((paths) => paths?.length)
        .map((paths) => ({ label: paths!.join(", "), run: () => setLogFilters({ paths, path: null }) })),
      {
        label: "Select Folders…",
        run: async () => {
          const paths = await chooseLogPaths(
            repositories.length ? repositories : root ? [root] : [],
            filters.paths ?? (filters.path ? [filters.path] : []),
            readOnly,
          );
          if (paths) setLogFilters({ path: null, paths });
        },
      },
    ]);

  const logFilters: LogFilter[] = [
    ...(repositories.length > 1
      ? [
          {
            label: "Repository",
            value: filters.repositories?.map(repoName).join(", ") || null,
            onOpen: (anchor: HTMLElement) =>
              menuBelow(
                anchor,
                repositories.map((repo) => ({
                  label: repoName(repo),
                  checked: filters.repositories?.includes(repo) ?? false,
                  run: () => setLogFilters({ repositories: toggleRepository(filters.repositories, repo) }),
                })),
              ),
            onClear: () => setLogFilters({ repositories: [] }),
          },
        ]
      : []),
    {
      label: "Branch",
      value: filters.range || filters.branches.join(", ") || null,
      onOpen: setBranchAnchor,
      onClear: () => setLogBranches([]),
    },
    {
      label: "User",
      value: filters.authors.join(", ") || null,
      onOpen: openUser,
      onClear: () => setLogFilters({ authors: [] }),
    },
    {
      label: "Date",
      value: filters.date?.label ?? null,
      onOpen: openDate,
      onClear: () => setLogFilters({ date: null }),
    },
    {
      label: "Paths",
      value: filters.paths?.length
        ? filters.paths.map((p) => (root ? relTo(root, p) : p)).join(", ")
        : filters.path
          ? (root ? relTo(root, filters.path) : filters.path) || "."
          : null,
      onOpen: openPaths,
      onClear: () => setLogFilters({ path: null, paths: [] }),
    },
  ];

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
      <span ref={groupRef} className={styles.filterGroup}>
        {logFilters.map((f, i) => (
          <FilterButton key={f.label} {...f} hidden={i >= hiddenFrom} />
        ))}
      </span>
      {hiddenFrom < logFilters.length && (
        <IconButton
          icon="chevron-right"
          title="More Filters"
          size="small"
          aria-haspopup="menu"
          onClick={(e) => {
            const anchor = e.currentTarget;
            menuBelow(
              anchor,
              logFilters.slice(hiddenFrom).map((f) => ({
                label: f.value ? `${tx(f.label)}: ${f.value}` : f.label,
                run: () => f.onOpen(anchor),
              })),
            );
          }}
        />
      )}
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
      <span className={styles.grow} />
      <IconButton
        icon="bookmark"
        title="Bookmarked Commits"
        size="small"
        disabled={!Object.keys(bookmarks).length}
        onClick={(e) =>
          menuBelow(
            e,
            Object.entries(bookmarks).map(([key, summary]) => ({
              label: summary,
              run: () => {
                const split = key.lastIndexOf("\0");
                void goToRef(key.slice(split + 1), split >= 0 ? key.slice(0, split) : undefined);
              },
            })),
          )
        }
      />
      <IconButton
        icon="plus"
        title="Open Another Log Tab"
        size="small"
        onClick={(e) =>
          menuBelow(e, [
            {
              label: "In Tool Window",
              run: () => {
                openLogTab("log", `Log ${useGitLog.getState().logTabs.length + 1}`);
              },
            },
            {
              label: "In Editor",
              run: () => {
                openLogTab("log", `Log ${useGitLog.getState().logTabs.length + 1}`, "editor");
              },
            },
            { label: "External Repository…", run: openExternalLog },
          ])
        }
      />
      <IconButton
        icon="clock"
        title="Recent Filters"
        size="small"
        onClick={(e) =>
          menuBelow(
            e,
            recentLogFilters().map((filters) => ({
              label:
                [
                  filters.range,
                  filters.branches.join(", "),
                  filters.authors.join(", "),
                  filters.text,
                  filters.path,
                  filters.paths?.join(", "),
                  filters.date?.label,
                ]
                  .filter(Boolean)
                  .join(" · ") || tx("All commits"),
              run: () => setLogFilters(filters),
            })),
          )
        }
      />
      <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reloadLog({ preserve: true })} />
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
    {
      label: "Incoming Commits First",
      checked: o.sort === "standard",
      run: () => updateLogOptions({ sort: "standard" }),
    },
    { kind: "separator" },
    { kind: "header", label: "Options" },
    toggle("First Parent", o, "firstParent"),
    toggle("No Merges", o, "noMerges"),
    {
      label: "Linearize Merges",
      checked: o.linearizeMerges,
      run: () =>
        updateLogOptions({ linearizeMerges: !o.linearizeMerges, ...(!o.linearizeMerges ? { sort: "standard" } : {}) }),
    },
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
    toggle("Details", o, "showDetails"),
    toggle("Repository", o, "showRepository"),
    {
      label: "Columns",
      submenu: [
        toggle("Author", o, "showAuthor"),
        toggle("Date", o, "showDate"),
        toggle("Hash", o, "showHash"),
        toggle("Signature", o, "showSignature"),
        toggle("GitHub Commit Checks", o, "showGitHubChecks"),
        { kind: "separator" },
        toggle("Column Headers", o, "showColumnHeaders"),
      ],
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
  if ((c as RepoCommit).readOnly)
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: c },
      { label: "Copy Commit Message", run: () => copyCommitMessage(c) },
      {
        label: useGitLog.getState().bookmarks[commitKey(c)] ? "Remove Commit Bookmark" : "Bookmark Commit",
        run: () => toggleCommitBookmark(c),
      },
      {
        label: "Assign Mnemonic",
        run: () => useBookmarkPopups.setState({ chooser: { path: commitBookmarkPath(c), line: 0, text: c.summary } }),
      },
      { kind: "action", action: "vcs.log.goToParent", arg: c },
      { kind: "action", action: "vcs.log.goToChild", arg: c },
      { label: "Browse Repository at Revision", run: () => browseRepositoryAt(c) },
    ];
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
    {
      label: useGitLog.getState().bookmarks[commitKey(c)] ? "Remove Commit Bookmark" : "Bookmark Commit",
      run: () => toggleCommitBookmark(c),
    },
    { label: "Copy Commit Message", run: () => copyCommitMessage(c) },
    { kind: "action", action: "vcs.log.createPatch", arg: c },
    { kind: "action", action: "vcs.log.cherryPick", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.checkoutRevision", arg: c },
    { label: "Browse Repository at Revision", run: () => browseRepositoryAt(c) },
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
    {
      label: "Assign Mnemonic",
      run: () => useBookmarkPopups.setState({ chooser: { path: commitBookmarkPath(c), line: 0, text: c.summary } }),
    },
    { kind: "action", action: "vcs.log.goToChild", arg: c },
    { kind: "action", action: "vcs.log.goToParent", arg: c, disabled: !c.parents.length },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.openInBrowser", arg: c },
  ];
}

async function copyCommitMessage(c: Commit) {
  const message = c.messageTruncated ? (await loadLogDetails(c)).message : c.message;
  await copyText(message);
}

function CommitList() {
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const all = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const earlier = useMemo(() => {
    const seen = new Set<string | null | undefined>();
    return all.some((c) => {
      const repo = commitRepo(c);
      if (seen.has(repo)) return false;
      seen.add(repo);
      return (c.logPosition ?? 0) > 0;
    });
  }, [all]);
  const opts = useLogOptions();
  const ChecksCell = useGitLogChecks((s) => s.cell);
  const bookmarks = useGitLog((s) => s.bookmarks);
  const fragments = useGitLog((s) => s.fragments);
  const { expanded: expandedFragments, collapsed: collapsedFragments, merges: expandedMerges } = fragments;
  const [hoverColor, setHoverColor] = useState<string | null>(null);
  const [boundaryTitles, setBoundaryTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const boundaryRequests = useRef(new Set<string>());
  const [speedSearch, setSpeedSearch] = useState("");
  const speedGeneration = useRef(0);
  const speedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(speedTimer.current), []);
  const columns = useMemo(() => {
    const builtins: LogColumn[] = [
      ...(opts.showAuthor ? [{ id: "author", title: "Author", width: 130, render: (c: Commit) => c.author }] : []),
      ...(opts.showDate
        ? [
            {
              id: "date",
              title: "Date",
              width: 120,
              render: (c: Commit) => formatTime(opts.commitTimestamp ? (c.commitTimeMs ?? c.timeMs) : c.timeMs),
            },
          ]
        : []),
      ...(opts.showHash ? [{ id: "hash", title: "Hash", width: 72, render: (c: Commit) => c.shortId }] : []),
      ...(opts.showSignature
        ? [{ id: "signature", title: "Signature", width: 100, render: (c: Commit) => <CommitSignature commit={c} /> }]
        : []),
      ...(opts.showGitHubChecks && ChecksCell
        ? [
            {
              id: "github-checks",
              title: "GitHub Commit Checks",
              width: 44,
              render: (c: Commit) => {
                const root = commitRepo(c) ?? currentRepoRoot();
                return root && !(c as RepoCommit).readOnly ? <ChecksCell root={root} revision={c.id} /> : null;
              },
            },
          ]
        : []),
    ];
    const order = [...new Set([...opts.columnOrder, ...builtins.map((c) => c.id)])];
    return builtins.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [
    opts.showAuthor,
    opts.showDate,
    opts.showHash,
    opts.showSignature,
    opts.showGitHubChecks,
    opts.commitTimestamp,
    opts.columnOrder,
    ChecksCell,
  ]);
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
        all
          .filter(
            (c) => c.refs.includes("HEAD") || c.id === (commitRepo(c) ? heads[commitRepo(c)!]?.headCommit : headCommit),
          )
          .map(commitKey),
      ),
    [all, heads, headCommit],
  );
  const keep = useMemo(
    () =>
      opts.collapseLinear || fragments.collapsed.size
        ? new Set([...headKeys, ...selection, ...Object.keys(bookmarks)])
        : null,
    [opts.collapseLinear, fragments.collapsed, headKeys, selection, bookmarks],
  );
  const {
    commits,
    rows,
    linear,
    collapsed,
    graph: displayedGraph,
  } = useMemo(() => presentLogGraph(all, opts, fragments, keep ?? new Set()), [all, opts, fragments, keep]);
  const { edges: highlighted, nodes: highlightedNodes } = useMemo(() => {
    const empty = { edges: new Set<string>(), nodes: new Set<string>() };
    if (!hoverColor) return empty;
    const nodeId = hoverColor.startsWith("node:") ? hoverColor.slice(5) : null;
    const merge = nodeId ?? linear?.fragments.get(hoverColor);
    const fragment = merge ? linear?.nodes.get(merge) : null;
    const nodes = new Set(fragment);
    if (!fragment) {
      const source = nodeId
        ? displayedGraph.find((c) => c.id === nodeId)
        : displayedGraph.find((c) => c.parents.some((p) => `${c.id}\0${p}` === hoverColor));
      const target = source?.parents.find((p) => nodeId || `${source.id}\0${p}` === hoverColor);
      if (source) nodes.add(source.id);
      const byId = new Map(displayedGraph.map((c) => [c.id, c]));
      const children = new Map<string, number>();
      for (const c of displayedGraph) for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
      for (let current = target; current && !nodes.has(current);) {
        nodes.add(current);
        const c = byId.get(current);
        if (!c || c.parents.length !== 1 || children.get(current) !== 1 || c.refs?.length || headKeys.has(current))
          break;
        current = c.parents[0];
      }
    }
    return {
      nodes,
      edges: new Set(
        displayedGraph.flatMap((c) =>
          nodes.has(c.id) ? c.parents.filter((p) => nodes.has(p)).map((p) => `${c.id}\0${p}`) : [],
        ),
      ),
    };
  }, [hoverColor, linear, displayedGraph, headKeys]);
  const minWidth = useMemo(
    () =>
      rows.reduce((width, row) => Math.max(width, row.width * LANE), 100) +
      columns.reduce(
        (width, column) => width + (opts.columnWidths[column.id] ?? column.width ?? 120),
        opts.showRepository && useVcs.getState().roots.length > 1 ? 220 : 120,
      ),
    [rows, columns, opts.columnWidths, opts.showRepository],
  );
  const filterBranches = useGitLog((s) => s.filters.branches);
  const currentBranch = useVcs((s) => s.branch?.head ?? null);
  // Nothing to tell apart when the log is filtered to the current branch.
  const onlyCurrent = filterBranches.length > 0 && filterBranches.every((b) => b === "HEAD" || b === currentBranch);
  const onBranch = useMemo(() => {
    if (!opts.highlightCurrentBranch || onlyCurrent) return null;
    const reach = all.some((c) => c.onCurrentBranch == null)
      ? reachableFrom(all.map(graphCommit), headKeys)
      : new Set<string>();
    for (const c of all) {
      if (c.onCurrentBranch === true) reach.add(commitKey(c));
      else if (c.onCurrentBranch === false) reach.delete(commitKey(c));
    }
    return reach;
  }, [all, headKeys, opts.highlightCurrentBranch, onlyCurrent]);
  const loading = useGitLog((s) => s.loading);
  const done = useGitLog((s) => s.done);
  const error = useGitLog((s) => s.error);
  const selected = useGitLog((s) => s.selected);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const revealTick = useGitLog((s) => s.revealTick);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousRows = useRef(commits);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const previous = previousRows.current;
    previousRows.current = commits;
    if (!element || previous === commits) return;
    const top = Math.max(0, Math.floor((element.scrollTop - ROW) / ROW));
    // Preserve the first surviving visible commit and its pixel offset.
    for (let i = top; i < previous.length; i++) {
      const next = commits.findIndex((c) => commitKey(c) === commitKey(previous[i]!));
      if (next < 0) continue;
      element.scrollTop += (next - i) * ROW;
      break;
    }
  }, [commits]);
  const finished = done;
  const virtualizer = useVirtualizer({
    count: commits.length + (finished ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
    scrollMargin: ROW,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  // The next page is requested while a page of rows is still ahead, so scrolling
  // quickly doesn't reach the end before `git log` answers.
  useEffect(() => {
    if (!finished && !loading && last && last.index >= commits.length - PAGE) void loadMore(scope ?? undefined);
  }, [last, commits.length, finished, loading, active, scope]);

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
  // CommitRow is memoized: rows get handlers that stay the same across renders and
  // call this render's (assigned before rendering).
  const rowEvents = useRef<RowEvents | null>(null);
  const rowHandlers = useMemo<RowEvents>(
    () => ({
      onHover: (edge) => rowEvents.current?.onHover(edge),
      onFragment: (from, target, expand) => rowEvents.current?.onFragment(from, target, expand),
      onNavigate: (index, key) => rowEvents.current?.onNavigate(index, key),
    }),
    [],
  );
  // Called while a row renders its graph, so it changes with what it reads.
  const targetTitle = useCallback(
    (index: number, key?: string) => {
      const target = commits[index];
      return target
        ? `${target.shortId} ${target.summary} — ${target.author}`
        : (key && boundaryTitles.get(key)) ||
            `${tx("Commit is outside the loaded history")} · ${key?.split("\0").at(-1)?.slice(0, 8) ?? ""}`;
    },
    [commits, boundaryTitles],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace" || e.key === "Escape")) {
      const query = e.key === "Escape" ? "" : e.key === "Backspace" ? speedSearch.slice(0, -1) : speedSearch + e.key;
      setSpeedSearch(query);
      speedGeneration.current++;
      clearTimeout(speedTimer.current);
      speedTimer.current = setTimeout(() => setSpeedSearch(""), 1500);
      if (query) {
        const found = nextSpeedMatch(commits, query, opts, -1);
        if (found >= 0) {
          selectCommit(commitKey(commits[found]!), true);
          virtualizer.scrollToIndex(found, { align: "auto" });
        } else if (query.length >= 2) {
          const generation = ++speedGeneration.current;
          const roots = [...new Set(all.map(commitRepo))];
          void Promise.all(
            roots.map(async (repo) => {
              const [hit] = await call(
                commands.vcsLog(repo ?? currentRepo(), {
                  skip: 0,
                  limit: 1,
                  summaryOnly: true,
                  speedSearch: query,
                  searchFields: [...(opts.showAuthor ? ["author"] : []), ...(opts.showHash ? ["hash"] : [])],
                  branch: null,
                  path: null,
                  author: null,
                  text: null,
                }),
              );
              return hit ? { ...hit, repo } : null;
            }),
          )
            .then((hits) => {
              const hit = hits.find(Boolean);
              if (hit && speedGeneration.current === generation) void goToRef(hit.id, commitRepo(hit));
            })
            .catch(() => undefined);
        }
      }
      e.preventDefault();
      return;
    }
    if (speedSearch && (e.key === "F3" || e.key === "Enter")) {
      e.preventDefault();
      const found = nextSpeedMatch(commits, speedSearch, opts, selectedIndex, e.shiftKey ? -1 : 1);
      if (found >= 0) selectCommit(commitKey(commits[found]!), true);
      return;
    }
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

  const fragment = (from: string, target: string, expand: boolean) => {
    if (from === target && (expandedMerges.has("*") ? !expandedMerges.has(from) : expandedMerges.has(from))) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          merges: expandedMerges.has("*")
            ? new Set([...expandedMerges, from])
            : new Set([...expandedMerges].filter((id) => id !== from)),
        },
      });
      return;
    }
    if (
      from === target &&
      linear &&
      all.find((c) => commitKey(c) === from)?.parents.length === 2 &&
      linear.graph.find((c) => c.id === from)?.parents.length === 1
    ) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          merges: expandedMerges.has("*")
            ? new Set([...expandedMerges].filter((id) => id !== from))
            : new Set([...expandedMerges, from]),
        },
      });
      return;
    }
    if (from === target) {
      const shown = (linear?.graph ?? collapsed?.graph ?? all.map(graphCommit)).find((c) => c.id === from);
      target = shown?.parents[0] ?? target;
      expand = !!shown?.dashed?.[0];
    }
    const merge = linear?.fragments.get(`${from}\0${target}`);
    if (merge) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          merges: expandedMerges.has("*")
            ? new Set([...expandedMerges].filter((id) => id !== merge))
            : new Set([...expandedMerges, merge]),
        },
      });
      return;
    }
    const graph = new Map(
      all.map((c) => {
        const g = graphCommit(c);
        return [g.id, g] as const;
      }),
    );
    const childCounts = new Map<string, number>();
    for (const c of graph.values())
      for (const parent of c.parents) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    const hidden: string[] = [];
    for (const start of expand ? (graph.get(from)?.parents ?? []) : [target]) {
      const chain: string[] = [];
      let current: string | undefined = start;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current);
        const node = graph.get(current);
        if (
          !node ||
          (expand && current === target) ||
          node.parents.length !== 1 ||
          childCounts.get(current) !== 1 ||
          node.refs.length ||
          headKeys.has(current)
        )
          break;
        chain.push(current);
        current = node.parents[0];
      }
      if (!expand || current === target) hidden.push(...chain);
    }
    if (expand) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          expanded: new Set([...expandedFragments, ...hidden]),
          collapsed: new Set([...collapsedFragments].filter((id) => !hidden.includes(id))),
        },
      });
    } else {
      useGitLog.setState({
        fragments: {
          ...fragments,
          expanded: new Set([...expandedFragments].filter((id) => !hidden.includes(id))),
          collapsed: new Set([...collapsedFragments, ...hidden]),
        },
      });
    }
  };

  rowEvents.current = {
    onHover: (edge) => {
      setHoverColor(edge);
      if (!edge) return;
      const source = displayedGraph.find((c) => c.parents.some((p) => `${c.id}\0${p}` === edge));
      const target = source?.parents.find((p) => `${source.id}\0${p}` === edge);
      if (!source || !target || commits.some((c) => commitKey(c) === target) || boundaryRequests.current.has(target))
        return;
      const original = all.find((c) => commitKey(c) === source.id);
      if (!original) return;
      boundaryRequests.current.add(target);
      const split = target.lastIndexOf("\0"),
        id = target.slice(split + 1);
      void loadLogDetails({ ...original, id })
        .then((details) =>
          setBoundaryTitles((current) =>
            new Map(current).set(target, `${id.slice(0, 8)} ${details.message.split("\n")[0]}`),
          ),
        )
        .catch(() => undefined);
    },
    onFragment: fragment,
    onNavigate: (index, key) => {
      const target = commits[index];
      if (target) selectCommit(commitKey(target), true);
      else if (key) {
        const split = key.lastIndexOf("\0");
        void goToRef(key.slice(split + 1), split >= 0 ? key.slice(0, split) : currentRepo());
      }
    },
  };

  return (
    <div className={styles.listWrap}>
      {earlier && (
        <button type="button" disabled={loading} onClick={() => void loadNewer(scope ?? undefined)}>
          {tx("Load Newer Commits")}
        </button>
      )}
      {speedSearch && (
        <div role="status" className={styles.speedSearch}>
          {speedSearch}
        </div>
      )}
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
        aria-activedescendant={selectedIndex >= 0 ? `commit-${scope ?? "log"}-${selectedIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onCopy={(e) => {
          if (window.getSelection()?.toString()) return;
          const selected = commits.filter((c) => selectedSet.has(commitKey(c)));
          if (!selected.length) return;
          e.preventDefault();
          e.clipboardData.setData(
            "text/plain",
            selected
              .map((c) =>
                [
                  c.summary,
                  c.refs.join(" "),
                  ...(opts.showRepository ? [commitRepo(c) ?? ""] : []),
                  ...columns.map((column) => (typeof column.render(c) === "string" ? column.render(c) : "")),
                ].join("\t"),
              )
              .join("\n"),
          );
          e.clipboardData.setData(
            "application/x-openidea-vcs-commits",
            JSON.stringify({ version: 1, commits: selected.map((c) => ({ root: commitRepo(c), hash: c.id })) }),
          );
        }}
      >
        {opts.showColumnHeaders && (
          <div className={clsx(styles.row, styles.columnHeader)} style={{ minWidth }}>
            {opts.showRepository && useVcs.getState().roots.length > 1 && (
              <span className={styles.colRepository}>{tx("Repository")}</span>
            )}
            <span className={styles.colSubject}>{tx("Commit")}</span>
            {columns.map((column) => (
              <LogColumnHeader key={column.id} column={column} columns={columns} options={opts} />
            ))}
          </div>
        )}
        {!commits.length && !loading && finished && (
          <div className={styles.message}>{headCommit ? tx("No commits match the filters") : tx("No commits yet")}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth }}>
          {items.map((v) => {
            const c = commits[v.index];
            if (!c)
              return (
                <div key="loading" className={styles.row} style={{ top: v.start - ROW }}>
                  <Spinner size={12} />{" "}
                  <span className={styles.muted}>
                    <T>Loading…</T>
                  </span>
                </div>
              );
            return (
              <CommitRow
                key={commitKey(c)}
                id={`commit-${scope ?? "log"}-${v.index}`}
                commit={c}
                graph={rows[v.index]}
                top={v.start - ROW}
                selected={selectedSet.has(commitKey(c))}
                head={headKeys.has(commitKey(c))}
                mine={opts.highlightMine && isMine(c, user)}
                onBranch={!!onBranch?.has(commitKey(c))}
                opts={opts}
                remoteNames={rowRemoteNames((c as RepoCommit).remoteNames, remoteNames)}
                onPick={pick}
                hoverColor={hoverColor}
                highlighted={highlighted}
                highlightedNodes={highlightedNodes}
                onHover={rowHandlers.onHover}
                onFragment={rowHandlers.onFragment}
                onNavigate={rowHandlers.onNavigate}
                targetTitle={targetTitle}
                columns={columns}
                bookmarked={!!bookmarks[commitKey(c)]}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LogColumnHeader({
  column,
  columns,
  options,
}: {
  column: LogColumn;
  columns: LogColumn[];
  options: LogOptions;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const width = options.columnWidths[column.id] ?? column.width ?? 120;
  const resize = (value: number) =>
    updateLogOptions({
      columnWidths: { ...logOptions().columnWidths, [column.id]: Math.max(40, Math.min(800, value)) },
    });
  const move = (source: string, target: string) => {
    const ids = columns.map((c) => c.id);
    const from = ids.indexOf(source),
      to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, source);
    updateLogOptions({ columnOrder: ids });
  };
  const index = columns.findIndex((c) => c.id === column.id);
  return (
    <span
      className={clsx(styles.columnCell, styles.columnHeading)}
      style={{ width }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-openidea-log-column", column.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-openidea-log-column")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        move(e.dataTransfer.getData("application/x-openidea-log-column"), column.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, [
          {
            label: "Move Left",
            disabled: index === 0,
            run: () => move(column.id, columns[index - 1]?.id ?? column.id),
          },
          {
            label: "Move Right",
            disabled: index === columns.length - 1,
            run: () => move(column.id, columns[index + 1]?.id ?? column.id),
          },
          { label: "Reset Width", run: () => resize(column.width ?? 120) },
        ]);
      }}
    >
      {tx(column.title)}
      <span
        className={styles.columnResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={tx`Resize ${tx(column.title)} column`}
        aria-valuemin={40}
        aria-valuemax={800}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          drag.current = { x: e.clientX, width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId))
            resize(drag.current.width + e.clientX - drag.current.x);
        }}
        onPointerUp={(e) => {
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.altKey) move(column.id, columns[index + (e.key === "ArrowLeft" ? -1 : 1)]?.id ?? column.id);
          else resize(width + (e.key === "ArrowLeft" ? -10 : 10));
        }}
      />
    </span>
  );
}

type RowEvents = {
  onHover: (edge: string | null) => void;
  onFragment: (from: string, target: string, expand: boolean) => void;
  onNavigate: (index: number, key?: string) => void;
};

const remoteNameSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A commit's own remote names (multi-root logs) as one set per array, else the shared one. */
function rowRemoteNames(own: readonly string[] | undefined, shared: ReadonlySet<string>): ReadonlySet<string> {
  if (!own) return shared;
  let set = remoteNameSets.get(own);
  if (!set) remoteNameSets.set(own, (set = new Set(own)));
  return set;
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
  hoverColor,
  highlighted,
  highlightedNodes,
  onHover,
  onFragment,
  onNavigate,
  targetTitle,
  columns,
  bookmarked,
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
  hoverColor: string | null;
  highlighted: ReadonlySet<string>;
  highlightedNodes: ReadonlySet<string>;
  onHover: (color: string | null) => void;
  onFragment: (from: string, target: string, expand: boolean) => void;
  onNavigate: (index: number, key?: string) => void;
  targetTitle: (index: number, key?: string) => string;
  columns: LogColumn[];
  bookmarked: boolean;
}) {
  const merge = opts.highlightMerges && c.parents.length > 1;
  const subjectRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState(false);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(tooltipTimer.current), []);
  useEffect(() => {
    if (!tooltip) return;
    const hide = () => setTooltip(false);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tooltip]);
  const enterTooltip = () => {
    clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => setTooltip(true), TOOLTIP_DELAY);
  };
  const leaveTooltip = () => {
    clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => setTooltip(false), 120);
  };
  const refs = c.refs.length > 0 && (
    <RefLabels
      refs={c.refs}
      compact={opts.compactRefs}
      tagNames={opts.tagNames}
      remoteNames={remoteNames}
      left={opts.refsOnLeft}
    />
  );
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={clsx(styles.row, onBranch && styles.currentBranch, selected && styles.selected)}
      style={{ top }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on range clicks
        onPick(commitKey(c), e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, commitMenu(c, selectedCommits()));
      }}
    >
      {opts.showRepository && commitRepo(c) && useVcs.getState().roots.length > 1 && (
        <span className={styles.colRepository} title={commitRepo(c)!}>
          {repoName(commitRepo(c)!)}
        </span>
      )}
      <span className={styles.colSubject}>
        {graph && (
          <GraphCell
            row={graph}
            head={head}
            activeColor={hoverColor}
            highlighted={highlighted}
            highlightedNodes={highlightedNodes}
            onHover={onHover}
            onNavigate={onNavigate}
            targetTitle={targetTitle}
            onFragment={(target, expand, source) => onFragment(source ?? commitKey(c), target, expand)}
            onNode={() => onFragment(commitKey(c), commitKey(c), false)}
          />
        )}
        {bookmarked && <Icon name="bookmark" size={12} />}
        {opts.refsOnLeft && refs}
        <span
          ref={subjectRef}
          className={clsx(styles.subject, head && styles.headSubject, merge && styles.mergeSubject)}
          onPointerEnter={enterTooltip}
          onPointerLeave={leaveTooltip}
          onPointerDown={() => {
            clearTimeout(tooltipTimer.current);
            setTooltip(false);
          }}
        >
          <IssueText text={c.summary} />
        </span>
        {!opts.refsOnLeft && refs}
        <Popup
          open={tooltip}
          anchor={subjectRef}
          role="tooltip"
          autoFocus={false}
          restoreFocus={false}
          onClose={() => setTooltip(false)}
          className={styles.commitTooltip}
        >
          <div onPointerEnter={() => clearTimeout(tooltipTimer.current)} onPointerLeave={leaveTooltip}>
            <CommitMessage commit={c} />
          </div>
        </Popup>
      </span>
      {columns.map((column) => (
        <span
          key={column.id}
          className={clsx(
            styles.columnCell,
            styles.muted,
            column.id === "author" && mine && styles.mine,
            column.id === "hash" && styles.hash,
          )}
          style={{ width: opts.columnWidths[column.id] ?? column.width ?? 120 }}
          title={column.id === "author" ? `${c.author} <${c.email}>` : undefined}
        >
          {column.render(c)}
        </span>
      ))}
    </div>
  );
});

function x(lane: number) {
  return LANE / 2 + lane * LANE;
}

/** Straight, also across lanes (IDEA's diagonal edges). */
function seg(fromX: number, fromY: number, toX: number, toY: number) {
  return `M${fromX} ${fromY}L${toX} ${toY}`;
}

export function GraphCell({
  row,
  head,
  activeColor,
  highlighted,
  highlightedNodes,
  onHover,
  onNavigate,
  onFragment,
  targetTitle,
  onNode,
}: {
  row: GraphRow;
  head?: boolean;
  activeColor?: string | null;
  highlighted?: ReadonlySet<string>;
  highlightedNodes?: ReadonlySet<string>;
  onHover?: (edge: string | null) => void;
  onNavigate?: (index: number, key?: string) => void;
  onFragment?: (target: string, expand: boolean, source?: string) => void;
  targetTitle?: (index: number, key?: string) => string;
  onNode?: () => void;
}) {
  const cy = ROW / 2;
  const draw = (s: GraphSegment, i: number, up: boolean) => {
    const target = (up ? row.upTargets : row.downTargets)?.[i];
    const canFragment =
      !!target &&
      !!onFragment &&
      s.kind !== "filtered" &&
      s.kind !== "shallow" &&
      (!!s.source || (!up && s.from === row.lane));
    const canNavigate = s.targetRow != null && s.kind !== "shallow" && !!onNavigate;
    const actionable = canNavigate || canFragment;
    const label =
      s.kind === "shallow"
        ? tx("Shallow history boundary")
        : s.targetRow != null
          ? (targetTitle?.(s.targetRow, target) ?? tx("Go to connected commit"))
          : s.dashed
            ? tx("Expand this fragment")
            : tx("Collapse this fragment");
    const activate = () => {
      if (canNavigate) onNavigate?.(s.targetRow!, target);
      else if (canFragment) onFragment?.(target!, !!s.dashed, s.source);
    };
    const fromX = x(s.fromX ?? s.from);
    const toX = x(s.toX ?? s.to);
    const path =
      seg(fromX, up ? 0 : cy, toX, up ? cy : ROW) +
      (s.arrow ? arrowHead(up ? fromX : toX, up ? 0 : ROW, up ? -1 : 1) : "");
    return (
      <g
        key={`${up ? "u" : "d"}${i}`}
        role={actionable ? "button" : undefined}
        tabIndex={actionable ? 0 : undefined}
        aria-label={actionable ? label : undefined}
        onMouseEnter={() => onHover?.(s.edge ?? `${s.source ?? ""}\0${target ?? ""}`)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          activate();
        }}
        onKeyDown={(e) => {
          if (actionable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.stopPropagation();
            activate();
          }
        }}
      >
        <title>{label}</title>
        <rect
          x={Math.min(fromX, toX) - 5}
          y={up ? 0 : cy}
          width={Math.max(10, Math.abs(fromX - toX) + 10)}
          height={cy}
          fill="transparent"
          pointerEvents="none"
        />
        <path d={path} stroke="transparent" strokeWidth={10} style={{ pointerEvents: "stroke" }} />
        <path
          d={path}
          stroke={laneColor(s.color)}
          strokeWidth={s.edge != null && (activeColor === s.edge || highlighted?.has(s.edge)) ? 2.8 : 1.4}
          pointerEvents="none"
          strokeLinecap={s.dashed ? "butt" : "square"}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      </g>
    );
  };
  return (
    <svg
      className={styles.graph}
      width={row.width * LANE}
      height={ROW}
      aria-label={tx("Commit graph")}
      onMouseLeave={() => onHover?.(null)}
    >
      {row.up.map((s, i) => draw(s, i, true))}
      {row.down.map((s, i) => draw(s, i, false))}
      <g
        role={onNode ? "button" : undefined}
        tabIndex={onNode ? 0 : undefined}
        aria-label={onNode ? tx("Collapse or expand this branch") : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={() => row.id && onHover?.(`node:${row.id}`)}
        onClick={(e) => {
          e.stopPropagation();
          onNode?.();
        }}
        onKeyDown={(e) => {
          if (onNode && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.stopPropagation();
            onNode();
          }
        }}
      >
        <circle cx={x(row.lane)} cy={cy} r={8} fill="transparent" />
        <circle
          cx={x(row.lane)}
          cy={cy}
          r={row.id && highlightedNodes?.has(row.id) ? 6 : head ? 5 : 3.8}
          fill={head ? "var(--log-row-bg, var(--bg-app))" : laneColor(row.color)}
          stroke={laneColor(row.color)}
          strokeWidth={head ? 1.5 : 0}
          pointerEvents="none"
        />
        {head && <circle cx={x(row.lane)} cy={cy} r={2.5} fill={laneColor(row.color)} pointerEvents="none" />}
      </g>
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
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const readOnly = useReadOnlyLog();
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
  const [result, setResult] = useState<{
    key: string;
    files: LogChange[] | null;
    error: string | null;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [parentIndex, setParentIndex] = useState(-1);
  const fromParents = useLogOptions((s) => s.changesFromParents);
  const onlyAffected = useLogOptions((s) => s.showOnlyAffected);
  const preview = useLogOptions((s) => s.diffPreview);
  const diffLocation = useLogOptions((s) => s.diffLocation);
  const showLineStats = useLogOptions((s) => s.showLineStats);
  const filters = useGitLog((s) => s.filters);
  const filesKey = JSON.stringify([idsKey, fromParents, parentIndex, commitRoot, showLineStats]);
  const files = result?.key === filesKey ? result.files : null;
  const error = result?.key === filesKey ? result.error : null;

  useEffect(() => {
    if (!idsKey) return;
    let alive = true;
    const load = (async () => {
      if (many) {
        const roots = [...new Set(chosen.map(commitRepo))];
        return (
          await Promise.all(
            roots.map(async (repo) => {
              const group = chosen.filter((c) => commitRepo(c) === repo);
              const files = await call(
                commands.vcsCommitsChanges(repo ?? currentRepo(), group.map((c) => c.id).reverse()),
              );
              return toLogChanges(files, null, repo, readOnly);
            }),
          )
        ).flat();
      }
      const c = chosen[0]!;
      if (c.parents.length > 1) {
        const groups = await Promise.all(
          c.parents.map(async (id, index) => {
            const files = await call(commands.vcsDiffRevisions(commitRoot ?? currentRepo(), id, c.id));
            return toLogChanges(files, { ...c, parents: [id] }, commitRoot, readOnly).map((f) => ({
              ...f,
              group: `${tx("Parent")} ${index + 1}: ${id.slice(0, 8)}`,
            }));
          }),
        );
        if (fromParents) return parentIndex < 0 ? groups.flat() : (groups[parentIndex] ?? []);
        // A merge's combined changes are files changed against every parent.
        return groups[0]!
          .filter((f) => groups.every((group) => group.some((x) => x.path === f.path)))
          .map((f) => ({
            ...f,
            group: undefined,
            mergeParents: c.parents
              .slice(0, 2)
              .map((rev, i) => ({ rev, path: groups[i]!.find((x) => x.path === f.path)?.oldPath ?? f.path })),
          }));
      }
      const files = await call(commands.vcsCommitFiles(commitRoot ?? currentRepo(), c.id));
      return toLogChanges(files, c, commitRoot, readOnly);
    })();
    load
      .then((files) => (showLineStats ? withLineStats(files).catch(() => files) : files))
      .then((files) => alive && setResult({ key: filesKey, files, error: null }))
      .catch(
        (e) => alive && setResult({ key: filesKey, files: null, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
  }, [idsKey, chosen, fromParents, parentIndex, commitRoot, filesKey, many, readOnly, showLineStats]);

  const groupByDirectory = useLogOptions((s) => s.groupByDirectory);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const treeRef = useRef<TreeHandle>(null);
  const [diffToReveal, setDiffToReveal] = useState<{ key: string } | null>(null);
  const syncingDiff = useRef(false);
  const changes = useMemo(() => {
    const changes = files ?? [];
    const paths = filters.paths?.length ? filters.paths : filters.path ? [filters.path] : [];
    return onlyAffected && paths.length
      ? changes.filter((c) =>
          paths.some((p) => {
            const matches = (rel: string) => {
              const abs = absolutePath(rel, c.repo);
              return abs === p || abs.startsWith(`${p}/`) || (!many && commit?.historyPath === rel);
            };
            return matches(c.path) || (c.oldPath != null && matches(c.oldPath));
          }),
        )
      : changes;
  }, [files, commit, many, filters.path, filters.paths, onlyAffected]);
  const lineTotals = useMemo(() => {
    if (!showLineStats || !changes.length) return null;
    if (changes.some((f) => f.added === undefined || f.removed === undefined)) return null;
    return changes.reduce((sum, f) => ({ added: sum.added + f.added!, removed: sum.removed + f.removed! }), {
      added: 0,
      removed: 0,
    });
  }, [changes, showLineStats]);
  const multipleRoots = new Set(chosen.map(commitRepo)).size > 1;
  const changeTreePath = useCallback(
    (f: LogChange) => `${multipleRoots ? `${repoName(f.repo ?? "")}/` : ""}${f.group ? `${f.group}/` : ""}${f.path}`,
    [multipleRoots],
  );
  const tree = useMemo(
    () => (groupByDirectory ? buildFileTree(changes, changeTreePath) : flatFileNodes(changes, changeTreePath)),
    [changes, groupByDirectory, changeTreePath],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);
  const ordered = useMemo(() => filesUnder(tree), [tree]);
  const chosenChanges = useMemo(() => filesUnder(tree, selectedKeys), [tree, selectedKeys]);

  // Show Diff Preview: a single selected file follows into the editor's preview tab.
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!active) clearTimeout(previewTimer.current);
    return () => clearTimeout(previewTimer.current);
  }, [active]);
  const previewSelection = (sel: ReadonlySet<string>) => {
    clearTimeout(previewTimer.current);
    if (syncingDiff.current) return;
    if (!logOptions().diffPreview || logOptions().diffLocation !== "editor" || sel.size !== 1) return;
    const file = fileNodeAt(tree, [...sel][0]!)?.file;
    // A preview that cannot open (no editor yet, the file went away) is just skipped.
    if (file)
      previewTimer.current = setTimeout(() => void showChangesDiff([file], true).catch(() => undefined), PREVIEW_DELAY);
  };

  // Follow only this pane's exact diff (path AND revisions); another commit or
  // Compare with Local must not move its selection. Never take focus from F7.
  useEffect(() => {
    const editor = maybeEditorService();
    const followDiff = (input: EditorInput | null) => {
      if (input?.kind !== DIFF_KIND) return;
      const change = ordered.find((c) => diffInput(c.diff).key === input.key);
      if (!change) return;
      clearTimeout(previewTimer.current);
      const rel = changeTreePath(change);
      setExpanded((current) => {
        const next = new Set(current ?? allDirs);
        for (const key of allDirs) if (rel.startsWith(key.slice(2) + "/")) next.add(key);
        return next;
      });
      setDiffToReveal({ key: `f:${rel}` });
    };
    followDiff(editor?.activeInput?.() ?? null);
    return editor?.onActiveInputChange?.(followDiff);
  }, [ordered, allDirs, changeTreePath]);

  // Tree.reveal needs the expanded rows to have rendered. Suppress the reverse
  // preview update so it cannot reopen the diff and lose its requested chunk.
  useLayoutEffect(() => {
    if (!diffToReveal) return;
    syncingDiff.current = true;
    treeRef.current?.reveal(diffToReveal.key);
    syncingDiff.current = false;
  }, [diffToReveal]);

  useEffect(() => {
    if (!active) return;
    useLogChanges.setState({ commits: chosen, all: ordered, selected: chosenChanges });
  }, [chosen, ordered, chosenChanges, active]);
  useEffect(
    () => () => {
      if (!scope || useGitLog.getState().shownLog === scope)
        useLogChanges.setState({ commits: [], all: [], selected: [] });
    },
    [scope],
  );

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
      toggle("Show Only Affected Changes", logOptions(), "showOnlyAffected"),
      toggle("Show lines added and deleted", logOptions(), "showLineStats"),
      toggle("Show Changes from Parents", logOptions(), "changesFromParents"),
      {
        label: "Diff Preview Location",
        submenu: (["editor", "right", "bottom"] as const).map((location) => ({
          label: location === "editor" ? "Editor" : location === "right" ? "Right" : "Bottom",
          checked: diffLocation === location,
          run: () => updateLogOptions({ diffLocation: location }),
        })),
      },
    ]);

  const onFileMenu = (node: FileTreeNode<LogChange> | null, sel: ReadonlySet<string>, e: ReactMouseEvent) => {
    if (!node) return;
    const target = sel.has(node.key) ? filesUnder(tree, sel) : filesUnder([node]);
    if (!target.length) return;
    e.preventDefault();
    showContextMenu(e, changesMenu(target));
  };

  const details = (
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
              disabled={readOnly || !chosenChanges.length || new Set(chosenChanges.map((c) => c.repo)).size > 1}
            />
            <IconButton icon="eye" title="View Options" size="small" aria-haspopup="menu" onClick={openViewOptions} />
            {!many && fromParents && commit.parents.length > 1 && (
              <button
                type="button"
                className={styles.filterMain}
                onClick={(e) =>
                  menuBelow(e, [
                    { label: tx("All Parents"), checked: parentIndex < 0, run: () => setParentIndex(-1) },
                    ...commit.parents.map((id, index) => ({
                      label: `${tx("Parent")} ${index + 1}: ${id.slice(0, 8)}`,
                      checked: index === parentIndex,
                      run: () => setParentIndex(index),
                    })),
                  ])
                }
              >
                {parentIndex < 0 ? tx("All Parents") : `${tx("Parent")} ${parentIndex + 1}`}
              </button>
            )}
            <span className={styles.detailsCount}>
              {files ? fileCount(changes.length) : ""}
              {many ? " " + tx`in ${chosen.length} commits` : ""}
            </span>
            {lineTotals && <LineStats added={lineTotals.added} removed={lineTotals.removed} />}
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
              handleRef={treeRef}
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
  );
  const embedded = preview && diffLocation !== "editor";
  const selectedChange = chosenChanges.length === 1 ? chosenChanges[0] : undefined;
  return (
    <div className={styles.details}>
      {embedded ? (
        <SplitGroup
          orientation={diffLocation === "right" ? "horizontal" : "vertical"}
          id={`git-log-preview-${diffLocation}`}
        >
          <SplitPanel id="changes" defaultSize="55%" minSize="20%">
            {details}
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="preview" minSize="20%">
            {selectedChange ? (
              selectedChange.mergeParents?.length === 2 && selectedChange.after ? (
                <LogMergePreview
                  input={{
                    kind: "git-merge-diff",
                    key: `git-merge-diff:${selectedChange.repo}:${selectedChange.after}:${selectedChange.path}`,
                    data: {
                      repo: selectedChange.repo,
                      revision: selectedChange.after,
                      path: selectedChange.path,
                      parents: selectedChange.mergeParents,
                    },
                  }}
                />
              ) : (
                <LogDiffPreview key={diffInput(selectedChange.diff).key} input={diffInput(selectedChange.diff)} />
              )
            ) : (
              <EmptyState>
                <T>Select a file to preview its changes</T>
              </EmptyState>
            )}
          </SplitPanel>
        </SplitGroup>
      ) : (
        details
      )}
    </div>
  );
}

/** A commit's message and metadata; `compact` (one of several selected): without the body. */
function CommitMessage({ commit, compact = false }: { commit: Commit; compact?: boolean }) {
  const { details, error } = useCommitDetails(commit, !compact);
  const repo = commitRepo(commit) ?? currentRepo();
  const message = details?.message || commit.message;
  const [subject, ...bodyLines] = message.replace(/\s+$/, "").split("\n");
  const body = compact ? "" : bodyLines.join("\n").replace(/^\n+/, "");
  return (
    <div className={clsx(compact && styles.commitEntry)}>
      <div className={styles.subjectLine}>
        <CommitMessageText text={subject ?? ""} repo={repo} />
      </div>
      {body && (
        <div className={styles.fullMessage}>
          <CommitMessageText text={body} repo={repo} />
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
      {!compact &&
        commit.committer &&
        (commit.committer !== commit.author ||
          commit.committerEmail !== commit.email ||
          commit.commitTimeMs !== commit.timeMs) && (
          <div className={styles.meta}>
            {tx("Committed by")} {commit.committer} &lt;{commit.committerEmail}&gt;{" "}
            {commit.commitTimeMs ? new Date(commit.commitTimeMs).toLocaleString() : ""}
          </div>
        )}
      {commit.parents.length > 0 && (
        <div className={styles.meta}>
          {tx(commit.parents.length > 1 ? "Merge of" : "Parent")}{" "}
          {commit.parents.map((id, i) => (
            <span key={id}>
              {i > 0 ? ", " : ""}
              <button type="button" className={styles.linkButton} onClick={() => void goToRef(id, repo)}>
                {id.slice(0, 8)}
              </button>
            </span>
          ))}
        </div>
      )}
      {details && (
        <>
          <div className={styles.meta}>
            {tx("Containing branches")}:{" "}
            {details.containingBranches.length
              ? details.containingBranches.map((branch, i) => (
                  <span key={branch}>
                    {i > 0 ? ", " : ""}
                    <button type="button" className={styles.linkButton} onClick={() => void goToRef(branch, repo)}>
                      {branch}
                    </button>
                  </span>
                ))
              : tx("None")}
          </div>
          <div
            className={styles.meta}
            title={[details.signer, details.key, details.fingerprint].filter(Boolean).join("\n")}
          >
            {tx("Signature")}: {signatureLabel(details.signature)}
            {details.signer ? ` · ${details.signer}` : ""}
          </div>
        </>
      )}
      {error && (
        <div role="status" className={styles.meta}>
          {tx("Could not load containing branches or signature details")}
        </div>
      )}
      {commit.refs.length > 0 && (
        <div className={styles.meta}>
          <RefLabels refs={commit.refs} />
        </div>
      )}
    </div>
  );
}

function signatureLabel(code: string) {
  return tx(
    (
      {
        G: "Verified",
        U: "Good signature with unknown trust",
        B: "Bad signature",
        E: "Could not verify",
        N: "Unsigned",
        X: "Expired signature",
        Y: "Expired signing key",
        R: "Revoked signing key",
      } as Record<string, string>
    )[code] ?? "Could not verify",
  );
}

function CommitSignature({ commit }: { commit: Commit }) {
  const { details, error } = useCommitDetails(commit);
  return (
    <span title={details ? [details.signer, details.key, details.fingerprint].filter(Boolean).join("\n") : undefined}>
      {details ? signatureLabel(details.signature) : error ? tx("Could not verify") : tx("Loading…")}
    </span>
  );
}

function CommitMessageText({ text, repo }: { text: string; repo: string | null | undefined }) {
  return text.split(/\b([a-fA-F0-9]{7,64})\b/g).map((part, i) =>
    i % 2 ? (
      <button type="button" className={styles.linkButton} key={i} onClick={() => void goToRef(part, repo)}>
        {part}
      </button>
    ) : (
      <IssueText key={i} text={part} />
    ),
  );
}

/** IDEA's changes browser context menu in the Git Log; `changes` = the files it acts on. */
export function changesMenu(changes: LogChange[]): MenuItem[] {
  const one = changes.length === 1 ? changes[0]! : null;
  return [
    { kind: "action", action: "vcs.log.changes.showDiff", arg: changes },
    { kind: "action", action: "vcs.log.changes.compareWithLocal", arg: changes, disabled: !one?.after || one.readOnly },
    {
      kind: "action",
      action: "vcs.log.changes.compareBeforeWithLocal",
      arg: changes,
      disabled: !one?.before || one.readOnly,
    },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.changes.jumpToSource",
      arg: changes,
      disabled: !changes.some((c) => c.after && !c.readOnly),
    },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.changes.revert",
      arg: changes,
      disabled: changes.some((c) => c.readOnly) || new Set(changes.map((c) => c.repo)).size > 1,
    },
    {
      kind: "action",
      action: "vcs.log.changes.getFromRevision",
      arg: changes,
      disabled: changes.some((c) => c.readOnly),
    },
    { kind: "separator" },
    ...(one?.readOnly
      ? [{ label: "Show History for File", run: () => openLogTab("history", absolutePath(one.path, one.repo)) }]
      : [
          {
            kind: "action",
            action: "vcs.showHistory",
            arg: one ? absolutePath(one.path, one.repo) : undefined,
            disabled: !one?.after,
          } satisfies MenuItem,
        ]),
  ];
}

function lineCount(file: ChangedFile | LogChange): { added: number; removed: number } | null {
  if (!("added" in file) || typeof file.added !== "number" || typeof file.removed !== "number") return null;
  return { added: file.added, removed: file.removed };
}

/** Sum of a directory once every file under it has counts; otherwise the row stays without them. */
function nodeLineCount(node: FileTreeNode<ChangedFile | LogChange>): { added: number; removed: number } | null {
  if (node.file) return lineCount(node.file);
  let added = 0;
  let removed = 0;
  for (const child of node.children) {
    const count = nodeLineCount(child);
    if (!count) return null;
    added += count.added;
    removed += count.removed;
  }
  return node.children.length ? { added, removed } : null;
}

function LineStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.lineStats}>
      <span className={styles.lineAdded} aria-label={added === 1 ? tx`${added} line added` : tx`${added} lines added`}>
        +{added}
      </span>
      <span
        className={styles.lineRemoved}
        aria-label={removed === 1 ? tx`${removed} line deleted` : tx`${removed} lines deleted`}
      >
        −{removed}
      </span>
    </span>
  );
}

function ChangedFileRow({ node, flat = false }: { node: FileTreeNode<ChangedFile | LogChange>; flat?: boolean }) {
  const stats = nodeLineCount(node);
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} className={styles.fileIcon} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDir}>{fileCount(node.count)}</span>
        {stats && <LineStats added={stats.added} removed={stats.removed} />}
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
      {stats && <LineStats added={stats.added} removed={stats.removed} />}
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
        tabIndex={0}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
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
