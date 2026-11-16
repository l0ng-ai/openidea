import type { Branch, ChangedFile, Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { hasPrimaryModifier } from "@/platform/keymap";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import {
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tabs,
  Tree,
  copyText,
  fileIconName,
  lazyComponent,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";
import clsx from "clsx";
import {
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
import {
  branchFolderKeys,
  branchGroupKeys,
  buildBranchTree,
  buildRepositoryBranchTree,
  filterBranchTree,
  isFavoriteBranch,
  type BranchTreeNode,
} from "./branches";
import { branchMenu, inRepo, tagMenu } from "./branchMenu";
import { canDeleteBranch, loadFavoriteBranches, useFavoriteBranches } from "./branchOps";
import { BranchSync } from "./BranchSync";
import { LocalChangesView, StashContent, tabItems, useStashTabCounts } from "./CommitView";
import { DIFF_KIND, diffInput, vcsDiffInFront } from "./diffInput";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import styles from "./GitLog.module.css";
import { WorktreesPanel } from "./gitMenuDialogs";
import { gitTabs, shownTab } from "./gitTabs";
import { CommitList } from "./log/CommitList";
import { CommitMessage } from "./log/CommitMessage";
import { FilterBar } from "./log/FilterBar";
import { useDropdownMenu, useLogRepositories, useReadOnlyLog } from "./log/logHooks";
import { toggle } from "./log/shared";
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
import { LogIdContext } from "./logContext";
import { invalidateLogDetails } from "./logDetails";
import { logOptions, useLogOptions } from "./logOptions";
import { canUpdateBranch, useBranchesPane, type BranchTarget } from "./logPaneActions";
import { LogScope } from "./LogScope";
import {
  closeLogTab,
  initLogBranchFilter,
  logState,
  openLogTab,
  refsSignature,
  reloadLog,
  selectGitTab,
  setLogBranches,
  setLogFilters,
  updateLogOptions,
  useGitLog,
} from "./logStore";
import { KIND_COLOR, dirName, fileCount, renameFrom, type EffectiveKind } from "./model";
import { branchesByRepo, commitKey, commitRepo } from "./multiRoot";
import { clearConsole, useVcsConsole } from "./ops";
import { currentRepo, loadBranches, repoName, useVcs } from "./store";

const LogMergePreview = lazyComponent(() => import("./GitMergeDiff").then((m) => m.GitMergeDiff));

const LogDiffPreview = lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor));

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
  const mounted = useRef(false);
  useEffect(() => {
    lastRefs.current = null;
    allRefs.current = null;
    const state = logState(scope ?? undefined);
    if (mounted.current || !state.loading) void reloadLog({ preserve: state.commits.length > 0 }, scope ?? undefined);
    mounted.current = true;
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
      storageKey={`openidea.vcs.logSplit.${showBranches ? "branches" : "noBranches"}.${showDetails ? "details" : "noDetails"}`}
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

function branchDetail(n: BranchTreeNode): ReactNode {
  const b = n.branch;
  if (!b) return undefined;
  if (!b.current && b.behind <= 0 && b.ahead <= 0) return undefined;
  return (
    <span className={styles.branchDetail}>
      {b.current && <span>{tx("current")}</span>}
      <BranchSync behind={b.behind} ahead={b.ahead} />
    </span>
  );
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
              actionArg={targets}
              disabled={!targets.some((t) => canDeleteBranch(t))}
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
          onContextMenu={(n, _sel, e) => {
            if (readOnly) {
              if (!n?.ref) return;
              e.preventDefault();
              showContextMenu(e, [
                { label: "Show in Git Log", run: () => setLogBranches([n.ref!]) },
                { label: "Copy", run: () => void copyText(n.ref!) },
              ]);
              return;
            }
            // The menu acts on the whole selection when the right-clicked branch is part of it.
            const picked: BranchTarget[] =
              n && selected.has(n.key) ? targets : n?.ref ? [{ ref: n.ref, branch: n.branch, repo: n.repo }] : [];
            const menu = n?.branch
              ? branchMenu(
                  n.branch,
                  n.repo ? (useVcs.getState().heads[n.repo]?.head ?? null) : current,
                  () => {},
                  picked,
                )
              : n?.kind === "tag"
                ? tagMenu(n.ref!)
                : n?.kind === "remote" || (n?.kind === "group" && n.key.endsWith("g:remote"))
                  ? REMOTES_MENU
                  : [];
            // Delete scopes each selected target itself and must preserve the original focus.
            const items = n?.repo
              ? menu.flatMap((item) =>
                  n.branch && "label" in item && item.label === "Delete" ? [item] : inRepo(n.repo!, [item]),
                )
              : menu;
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

/**
 * The selected commits' changes: one commit's files against its first parent, or, for several
 * (IDEA), their combined changes with every selected commit listed below.
 */
export function CommitDetails({ commits }: { commits: Commit[] }) {
  const scope = useContext(LogIdContext);
  const [menuBelow, dropdown] = useDropdownMenu();
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
  const savedLocation = useLogOptions((s) => s.diffLocation);
  // The modal commit interface keeps diffs out of editor tabs (#1863): the "Editor"
  // preview shows beside the changes instead.
  const modal = useWorkflowSettings((s) => !s.vcs.commit.nonModal);
  const diffLocation = modal && savedLocation === "editor" ? "right" : savedLocation;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, fromParents, parentIndex, commitRoot, filesKey, many, readOnly, showLineStats]);

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
    if (syncingDiff.current || sel.size !== 1) return;
    // While the editor shows one of this pane's diffs, the selection walks it along (a click or
    // arrow key), as in the Commit window.
    const shown = maybeEditorService()?.activeInput?.();
    const following = shown?.kind === DIFF_KIND && ordered.some((c) => diffInput(c.diff).key === shown.key);
    if (!following && (!logOptions().diffPreview || logOptions().diffLocation !== "editor" || vcsDiffInFront())) return;
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
  useEffect(() => () => setContext("vcsLogChangesFocus", false), []);

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
          checked: savedLocation === location,
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
    <SplitGroup orientation="vertical" id="git-log-details" storageKey="openidea.vcs.logDetailsSplit">
      <SplitPanel id="files" defaultSize="60%" minSize="60px">
        <div
          className={styles.filesPane}
          onFocusCapture={() => setContext("vcsLogChangesFocus", true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("vcsLogChangesFocus", false);
          }}
        >
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
              onJumpToSource={(n, sel) => {
                const files = sel.has(n.key) ? filesUnder(tree, sel) : filesUnder([n]);
                void executeAction("vcs.log.changes.jumpToSource", files);
              }}
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
      {dropdown}
      {embedded ? (
        <SplitGroup
          orientation={diffLocation === "right" ? "horizontal" : "vertical"}
          id={`git-log-preview-${diffLocation}`}
          storageKey={`openidea.vcs.logPreviewSplit.${diffLocation}`}
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
      {f.oldPath && <span className={styles.fileDir}>{renameFrom(f.path, f.oldPath)}</span>}
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
