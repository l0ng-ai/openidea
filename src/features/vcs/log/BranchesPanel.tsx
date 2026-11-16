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
  buildRepositoryBranchTree,
  filterBranchTree,
  isFavoriteBranch,
  type BranchTreeNode,
} from "../branches";
import { branchMenu, inRepo, tagMenu } from "../branchMenu";
import { canDeleteBranch, loadFavoriteBranches, useFavoriteBranches } from "../branchOps";
import { BranchSync } from "../BranchSync";
import styles from "../GitLog.module.css";
import { LogIdContext } from "../logContext";
import { canUpdateBranch, useBranchesPane, type BranchTarget } from "../logPaneActions";
import { reloadLog, setLogBranches, setLogFilters, useGitLog } from "../logStore";
import { branchesByRepo } from "../multiRoot";
import { currentRepo, loadBranches, repoName, useVcs } from "../store";
import { useLogRepositories, useReadOnlyLog } from "./logHooks";

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
