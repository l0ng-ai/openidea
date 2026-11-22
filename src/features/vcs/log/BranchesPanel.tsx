import clsx from "clsx";
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { hasPrimaryModifier } from "@/platform/keymap";
import { IconButton, SearchField, T, Tree, copyText, showContextMenu, type MenuItem } from "@/ui";
import { useContext, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  branchFolderKeys,
  branchGroupKeys,
  buildBranchTree,
  buildMergedBranchTree,
  buildRepositoryBranchTree,
  filterBranchTree,
  isFavoriteBranch,
  type BranchTreeNode,
} from "../branches";
import { branchMenu, inRepo, mergedBranchMenu, showTagContextMenu } from "../branchMenu";
import { canDeleteBranch, loadFavoriteBranches, useFavoriteBranches } from "../branchOps";
import { BranchSync } from "../BranchSync";
import { summarizeBranchSync, type BranchSyncSummary } from "../branchSyncState";
import { FetchButton } from "../FetchButton";
import styles from "../GitLog.module.css";
import { LogIdContext } from "../logContext";
import { canUpdateBranch, useBranchesPane, type BranchTarget } from "../logPaneActions";
import { reloadLog, scopedLogRepositories, setLogBranches, setLogFilters, useGitLog } from "../logStore";
import { branchesByRepo } from "../multiRoot";
import { branchRepositoryRoots, commonBranches } from "../repoBranches";
import { currentRepo, loadBranches, repoName, useVcs } from "../store";
import { useBranchWorktrees } from "../worktrees";
import { useLogRepositories, useReadOnlyLog } from "./logHooks";

// --- branches ---------------------------------------------------------------

/**
 * `total`: the repositories shown; a ref missing from some of them names those that have it,
 * last, so a narrow pane cuts that list off before the branch name or its markers.
 */
function branchDetail(n: BranchTreeNode, total: number, sync: BranchSyncSummary | undefined): ReactNode {
  const repos =
    n.repos && n.repos.length < total ? (
      <span className={styles.branchRepos}>({n.repos.map(repoName).join(", ")})</span>
    ) : null;
  const markers =
    n.branch?.current || (sync && (sync.ahead > 0 || sync.behind > 0 || sync.unfetched)) ? (
      <span className={styles.branchDetail}>
        {n.branch?.current && <span>{tx("current")}</span>}
        {sync && <BranchSync {...sync} />}
      </span>
    ) : null;
  if (!repos && !markers) return undefined;
  return (
    <>
      {markers}
      {repos}
    </>
  );
}

const GROUP_KEY = "openidea.vcs.branchesPane.groupByRepository";

/** A merged ref acts in each repository that has it, with that repository's own branch. */
function expand(n: BranchTreeNode, scopedRepo?: string): BranchTarget[] {
  if (!n.repos) return [{ ref: n.ref!, branch: n.branch, repo: n.repo ?? scopedRepo }];
  return n.repos.map((repo) => ({ ref: n.ref!, repo, branch: n.branchesByRoot?.get(repo) }));
}

function loadGrouped(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) === "true";
  } catch {
    return false;
  }
}

/** The branch the repositories `roots` are all on, else null. */
function sharedHead(roots: readonly string[]): string | null {
  const heads = useVcs.getState().heads;
  const first = heads[roots[0]!]?.head ?? null;
  return first && roots.every((r) => heads[r]?.head === first) ? first : null;
}

export function BranchesPanel() {
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const logGeneration = useGitLog((s) => s.generation);
  const selectedBranches = useVcs((s) => s.branches);
  const observations = useVcs((s) => s.unfetched);
  const logRepositories = useLogRepositories();
  const branchRoots = useVcs((s) => s.branchRoots);
  const availableRepositories = useMemo(
    () => branchRepositoryRoots(logRepositories, branchRoots),
    [logRepositories, branchRoots],
  );
  const filters = useGitLog((s) => s.filters);
  const { path, paths, repositories: repositoryFilter } = filters;
  const repositories = useMemo(
    () =>
      branchRepositoryRoots(
        scopedLogRepositories(logRepositories, { path, paths, repositories: repositoryFilter }, logRepositories),
        branchRoots,
      ),
    [logRepositories, path, paths, repositoryFilter, branchRoots],
  );
  const queriedRepositories = useMemo(
    () => [...new Set([...availableRepositories, ...repositories])],
    [availableRepositories, repositories],
  );
  const readOnly = useReadOnlyLog();
  const worktreeFor = useBranchWorktrees(active && !readOnly);
  const version = useVcs((s) => s.version);
  const [allBranches, setAllBranches] = useState<Record<string, Branch[]>>({});
  const [allTags, setAllTags] = useState<Record<string, string[]>>({});
  const [grouped, setGrouped] = useState(loadGrouped);
  const toggleGrouped = () => {
    setGrouped(!grouped);
    try {
      localStorage.setItem(GROUP_KEY, String(!grouped));
    } catch {
      // The grouping is a view preference.
    }
  };
  const currentRepository = currentRepo();
  const scopedRepo =
    repositories.length === 1 && (logRepositories.length > 1 || repositories[0] !== currentRepository)
      ? repositories[0]
      : undefined;
  const branches = useMemo(
    () =>
      repositories.length === 1 && repositories[0] !== currentRepository
        ? (allBranches[repositories[0]!] ?? [])
        : selectedBranches,
    [repositories, currentRepository, allBranches, selectedBranches],
  );
  const root = useVcs((s) => s.root);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const remoteBusy = useVcs((s) => s.remoteBusy);
  const current = useVcs((s) => s.branch?.head ?? null);
  const favorites = useFavoriteBranches((s) => s.names);
  const filterBranches = filters.branches;
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => loadFavoriteBranches(), [root]);
  // Branches reload when refs move (fetch, new tag…): the tags are re-read with them.
  useEffect(() => {
    let live = true;
    call(commands.vcsTags(availableRepositories[0] ?? currentRepo())).then(
      (t) => live && setTags(t),
      () => live && setTags([]),
    );
    return () => {
      live = false;
    };
  }, [root, selectedBranches, availableRepositories]);
  useEffect(() => {
    let live = true;
    void branchesByRepo(queriedRepositories)
      .then((value) => live && setAllBranches(value))
      .catch(() => undefined);
    void Promise.all(queriedRepositories.map(async (r) => [r, await call(commands.vcsTags(r))] as const))
      .then((value) => live && setAllTags(Object.fromEntries(value)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [queriedRepositories, version, logGeneration]);
  const merged = repositories.length > 1 && !grouped;
  const allRoots = useMemo(() => {
    if (!repositories.length && availableRepositories.length) return [];
    if (repositories.length < 2)
      return buildBranchTree(branches, favorites, scopedRepo ? (allTags[scopedRepo] ?? []) : tags);
    const list = repositories.map((repo) => ({
      root: repo,
      name: repoName(branchRoots[repo] ?? repo),
      branches: allBranches[repo] ?? [],
      tags: allTags[repo] ?? [],
    }));
    return grouped
      ? buildRepositoryBranchTree(list, favorites)
      : buildMergedBranchTree(list, favorites, currentRepository);
  }, [
    repositories,
    availableRepositories,
    branchRoots,
    allBranches,
    allTags,
    branches,
    favorites,
    tags,
    grouped,
    currentRepository,
    scopedRepo,
  ]);
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
        if (repositories.length < 2 || merged) return [`b:${b}`];
        return repositories.map((r) => `${r}:b:${b}`);
      }),
    [filterBranches, repositories, merged],
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
        if (n.ref) for (const t of expand(n, scopedRepo)) out.push({ key: n.key, ...t });
        walk(n.children ?? []);
      }
    };
    walk(allRoots);
    return out;
  }, [allRoots, scopedRepo]);
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
    const names = [...new Set(targets.map((r) => r.ref))];
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
            <IconButton
              icon="plus"
              title="New Branch…"
              size="small"
              action="vcs.log.branches.new"
              actionArg={targets}
            />
            <IconButton
              icon="git-pull"
              size="small"
              title="Update Selected"
              action="vcs.log.branches.update"
              actionArg={targets}
              disabled={!!remoteBusy || !targets.some((t) => canUpdateBranch(t))}
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
            <FetchButton />
          </>
        )}
        {availableRepositories.length > 1 && (
          <IconButton
            icon="module"
            title="Group by Repository"
            size="small"
            pressed={grouped}
            onClick={toggleGrouped}
          />
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
          key={JSON.stringify([root, branchesLoaded, grouped, repositories])}
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
          getDetail={(n) => {
            const sync =
              n.branch && !n.branch.remote
                ? summarizeBranchSync(
                    n.branchesByRoot ?? [[n.repo ?? repositories[0] ?? currentRepository, n.branch]],
                    readOnly ? undefined : observations,
                  )
                : undefined;
            return branchDetail(n, availableRepositories.length, sync);
          }}
          selected={selected}
          onSelectionChange={(sel) => setSelected(sel)}
          onActivate={(n) => {
            // IDEA: double click (or Enter) switches the log to that ref, or to every
            // selected one when it is part of a multi-selection; checking out stays in the context menu.
            if (!n.ref) return;
            if (n.repos) {
              const sel = selected.has(n.key) ? [...new Set(targets.map((r) => r.ref))] : [n.ref];
              setLogFilters({
                branches: sel,
                repositories: n.repos.length < availableRepositories.length ? n.repos : [],
              });
              return;
            }
            const repo = n.repo ?? scopedRepo;
            const sel = selected.has(n.key) ? targets.filter((r) => r.repo === repo).map((r) => r.ref) : [n.ref];
            setLogFilters({ branches: sel, repositories: repo ? [repo] : filters.repositories });
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
            const repo = n?.repo ?? (n?.repos?.length === 1 ? n.repos[0] : scopedRepo);
            if (n?.kind === "tag" && n.ref) {
              e.preventDefault();
              showTagContextMenu(e, n.ref, repo ?? currentRepository);
              return;
            }
            // The menu acts on the whole selection when the right-clicked branch is part of it.
            const picked: BranchTarget[] =
              n && selected.has(n.key)
                ? targets.map((target) => ({ ...target, repo: target.repo ?? repo }))
                : n?.ref
                  ? expand(n, scopedRepo).map((target) => ({ ...target, repo: target.repo ?? repo }))
                  : [];
            // A merged branch in several repositories acts in all of them, like a common branch.
            if (n?.branch && n.repos && n.repos.length > 1) {
              const lists = n.repos.map((r) => allBranches[r] ?? []);
              const group = commonBranches(lists, favorites)[n.branch.remote ? "remote" : "local"];
              const common = group.find((c) => c.name === n.ref);
              if (!common) return;
              const checkedOutInWorktree = !common.remote && n.repos.some((root) => worktreeFor(root, common.name));
              e.preventDefault();
              showContextMenu(
                e,
                mergedBranchMenu(
                  n.branch,
                  common,
                  n.repos,
                  sharedHead(n.repos),
                  picked,
                  undefined,
                  checkedOutInWorktree,
                ),
              );
              return;
            }
            const menu = n?.branch
              ? branchMenu(
                  n.branch,
                  repo && repo !== currentRepository ? (useVcs.getState().heads[repo]?.head ?? null) : current,
                  () => {},
                  {
                    selected: picked,
                    headCommit: repo ? (useVcs.getState().heads[repo]?.headCommit ?? null) : undefined,
                    existingWorktree: worktreeFor(repo ?? currentRepository, n.branch.name),
                    branches: (repo ? allBranches[repo] : undefined) ?? branches,
                  },
                )
              : n?.kind === "remote" || (n?.kind === "group" && n.key.endsWith("g:remote"))
                ? REMOTES_MENU
                : [];
            // Update Selected and Delete scope each selected target themselves and must preserve the original focus.
            const items =
              repo && repo !== currentRepository
                ? menu.flatMap((item) =>
                    n?.branch && "label" in item && (item.label === "Delete" || item.label === "Update Selected")
                      ? [item]
                      : inRepo(repo, [item]),
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
          className={clsx(styles.branchTree, merged && styles.mergedBranchTree)}
        />
      </div>
    </div>
  );
}

/** IDEA: the Remote node and each remote of the Branches pane offer Manage Remotes…. */
const REMOTES_MENU: MenuItem[] = [{ label: "Manage Remotes…", run: () => void executeAction("vcs.manageRemotes") }];
