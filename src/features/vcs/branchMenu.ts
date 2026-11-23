/** Branch context menu shared by the Branches popup and the Git Log Branches pane (IDEA's Git.Branch actions). */
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { showContextMenu, useContextMenuStore, type MenuItem } from "@/ui";
import { isFavoriteBranch } from "./branches";
import {
  branchRef,
  checkoutBranch,
  checkoutDetached,
  checkoutInRepos,
  deleteBranch,
  deleteBranches,
  deleteInRepos,
  deleteRemoteBranch,
  mergeInRepos,
  newBranchInRepos,
  renameInRepos,
  loadFavoriteBranches,
  mergeIntoCurrent,
  newBranch,
  renameBranch,
  toggleFavoriteBranch,
  configuredRemoteNames,
  type BranchUpdateTarget,
  useFavoriteBranches,
} from "./branchOps";
import { branchRebaseProblem } from "./branchRebase";
import type { CommonBranch } from "./repoBranches";
import { currentRepo, currentRepoRoot, focusRepo, useVcs } from "./store";
import { openWorktree } from "./openWorktree";
import { tx } from "@/platform/i18n";

type Run = (fn: () => unknown) => () => void;

function pullBranchItems(branch: string, cur: string | null, run: Run, repositories?: readonly string[]): MenuItem[] {
  return [
    {
      label: cur ? tx`Pull into '${cur}' Using Rebase` : tx("Pull into Current Branch Using Rebase"),
      run: run(() => executeAction("vcs.pullRemoteBranch", { branch, rebase: true, repositories })),
    },
    {
      label: cur ? tx`Pull into '${cur}' Using Merge` : tx("Pull into Current Branch Using Merge"),
      run: run(() => executeAction("vcs.pullRemoteBranch", { branch, rebase: false, repositories })),
    },
  ];
}

function pushBranchItem(branch: string, run: Run, repositories?: readonly string[]): MenuItem {
  return {
    label: "Push…",
    icon: "git-push",
    run: run(() =>
      executeAction("vcs.push", repositories ? { branch, repositories } : { branch, repo: currentRepoRoot() }),
    ),
  };
}

function updateSelection(targets: readonly BranchUpdateTarget[]) {
  return executeAction(
    "vcs.log.branches.update",
    targets.flatMap((target) => (target.branch ? [{ ...target, ref: target.branch.name }] : [])),
  );
}

function favoriteMenuItem(b: Branch, run: Run): MenuItem {
  loadFavoriteBranches();
  const favorite = isFavoriteBranch(b, useFavoriteBranches.getState().names);
  return {
    label: favorite ? "Remove from Favorites" : "Add to Favorites",
    icon: "star",
    run: run(() => toggleFavoriteBranch(b)),
  };
}

function historyMenuItem(name: string, run: Run): MenuItem {
  return { label: "Show History", icon: "history", run: run(() => executeAction("vcs.showLog", { branch: name })) };
}

function worktreeDiffItem(rev: string, label: string, run: Run, repositories?: readonly string[]): MenuItem {
  return {
    label: "Show Diff with Working Tree",
    run: run(() => executeAction("vcs.diffWithWorkingTree", { rev, label, repositories })),
  };
}

function worktreeMenuItem(branch: Pick<Branch, "name" | "remote" | "current">, run: Run, repo?: string): MenuItem {
  return {
    label: tx`New Worktree from '${branch.name}'…`,
    icon: "folder",
    run: run(() =>
      executeAction("vcs.newWorktree", { repo: repo ?? currentRepo(), source: branchRef(branch.name, branch.remote) }),
    ),
  };
}

/** The Branches pane's context menu: `selected` carries the multi-selection, which Update Selected and Delete act on as a whole. */
export function branchMenu(
  b: Branch,
  current: string | null,
  done: () => void = () => {},
  {
    selected = [],
    existingWorktree,
    branches = useVcs.getState().branches,
    headCommit = useVcs.getState().branch?.headCommit,
  }: {
    selected?: readonly { repo?: string; branch?: Branch }[];
    existingWorktree?: string;
    branches?: readonly Branch[];
    headCommit?: string | null;
  } = {},
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const cur = current ?? "HEAD";
  const rebaseBase = current ?? headCommit?.slice(0, 8);
  const favoriteItem = favoriteMenuItem(b, run);
  const newWorktree = worktreeMenuItem(b, run);
  // Update Selected acts on every selected local branch, each in its own repository.
  const updating = !!useVcs.getState().remoteBusy;
  const update: MenuItem =
    selected.filter((t) => t.branch && !t.branch.remote).length > 1
      ? {
          label: "Update Selected",
          icon: "git-pull",
          disabled: updating || !selected.some((target) => !target.branch?.remote && target.branch?.upstream),
          run: run(() => updateSelection(selected)),
        }
      : {
          label: "Update",
          icon: "git-pull",
          disabled: updating || !b.upstream,
          run: run(() => updateSelection([{ repo: currentRepoRoot() ?? undefined, branch: b }])),
        };
  const history = historyMenuItem(b.name, run);
  const worktreeDiff = worktreeDiffItem(branchRef(b.name, b.remote), b.name, run);
  const upstream = !b.remote && b.upstream ? branches.find((ref) => ref.remote && ref.name === b.upstream) : undefined;
  const trackedActions: MenuItem[] = upstream
    ? [{ label: tx`Tracked Branch '${upstream.name}'`, submenu: branchMenu(upstream, current, done, { branches }) }]
    : [];
  if (b.current) {
    return [
      { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch(b)) },
      newWorktree,
      { kind: "separator" },
      worktreeDiff,
      { kind: "separator" },
      update,
      pushBranchItem(b.name, run),
      ...trackedActions,
      { kind: "separator" },
      { label: "Rename…", run: run(() => renameBranch(b)) },
      favoriteItem,
      history,
    ];
  }
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutBranch(b)) },
    ...(existingWorktree && !b.remote
      ? [{ label: "Open Existing Worktree", icon: "folder", run: run(() => openWorktree(existingWorktree, true)) }]
      : []),
    { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch(b)) },
    newWorktree,
    ...(rebaseBase
      ? [
          {
            label: tx`Checkout and Rebase onto '${rebaseBase}'`,
            disabled: !!existingWorktree && !b.remote,
            run: run(() => executeAction("vcs.checkoutAndRebase", { branch: b, repos: [currentRepo()] })),
          },
        ]
      : []),
    { kind: "separator" },
    {
      label: tx`Compare with '${cur}'`,
      icon: "diff",
      run: run(() => executeAction("vcs.log.compareBranches", { name: b.name, rev: branchRef(b.name, b.remote) })),
    },
    worktreeDiff,
    history,
    { kind: "separator" },
    {
      label: tx`Rebase '${cur}' onto '${b.name}'`,
      disabled: !!branchRebaseProblem(b, current),
      hint: branchRebaseProblem(b, current) ?? undefined,
      run: run(() => executeAction("vcs.rebaseOntoBranch", { branch: b, repos: [currentRepoRoot()] })),
    },
    {
      label: tx`Merge '${b.name}' into '${cur}'`,
      run: run(() => mergeIntoCurrent(b.name, undefined, branchRef(b.name, b.remote))),
    },
  ];
  if (b.remote) items.push(...pullBranchItems(b.name, rebaseBase ?? null, run));
  if (!b.remote) items.push({ kind: "separator" }, update, pushBranchItem(b.name, run), ...trackedActions);
  items.push(
    { kind: "separator" },
    ...(b.remote ? [] : [{ label: "Rename…", run: run(() => renameBranch(b)) }]),
    favoriteItem,
    {
      label: "Delete",
      danger: true,
      icon: "trash",
      run: run(() =>
        selected.length ? deleteBranches(selected) : b.remote ? deleteRemoteBranch(b.name) : deleteBranch(b.name),
      ),
    },
  );
  return items;
}

/** Tag entries of the Branches popup. */
export function tagMenu(
  tag: string,
  done: () => void = () => {},
  { repo = currentRepoRoot(), remotes }: { repo?: string | null; remotes?: readonly string[] } = {},
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const ref = `refs/tags/${tag}`;
  const pushItems: MenuItem[] = (remotes ?? []).map((remote) => ({
    label: tx`Push to ${remote}`,
    icon: "git-push",
    run: run(() => executeAction("vcs.pushTag", { tag, remote, repo })),
  }));
  const pushes: MenuItem[] =
    remotes === undefined
      ? [{ label: "Loading…", disabled: true }]
      : pushItems.length >= 6
        ? [{ label: "Push Tag", icon: "git-push", submenu: pushItems }]
        : pushItems;
  return [
    { label: "Checkout", run: run(() => checkoutDetached(ref, tag, repo)) },
    { label: tx`New Branch from '${tag}'…`, icon: "branch", run: run(() => newBranch({ tag }, repo)) },
    {
      label: tx`New Worktree from '${tag}'…`,
      icon: "folder",
      run: run(() => executeAction("vcs.newWorktree", { repo, source: ref })),
    },
    { kind: "separator" },
    {
      label: "Compare with Current",
      icon: "diff",
      run: run(() =>
        executeAction("vcs.log.compareBranches", { name: tag, rev: ref, repositories: repo ? [repo] : undefined }),
      ),
    },
    worktreeDiffItem(ref, tag, run, repo ? [repo] : undefined),
    { label: "Show History", icon: "history", run: run(() => executeAction("vcs.showLog", { branch: tag })) },
    {
      label: tx`Merge '${tag}' into Current`,
      run: run(() => executeAction("vcs.mergeTag", { tag, repo })),
    },
    { kind: "separator" },
    { label: "Delete", danger: true, icon: "trash", run: run(() => executeAction("vcs.deleteTag", { tag, repo })) },
    // Remote items arrive asynchronously. Keep the local actions at stable positions.
    ...(pushes.length ? [{ kind: "separator" } as const, ...pushes] : []),
  ];
}

/** Update only the menu that requested these remotes. */
export function showTagContextMenu(at: { clientX: number; clientY: number }, tag: string, repo: string | null) {
  const items = (remotes?: string[]) => {
    const menu = tagMenu(tag, undefined, { repo, remotes });
    return repo ? inRepo(repo, menu) : menu;
  };
  showContextMenu(at, items());
  const id = useContextMenuStore.getState().menu?.id;
  void configuredRemoteNames(repo).then((remotes) =>
    useContextMenuStore.setState((s) =>
      s.menu && s.menu.id === id ? { menu: { ...s.menu, items: items(remotes) } } : s,
    ),
  );
}

/**
 * Entries for a branch common to all repositories: each acts in every one of `roots`.
 * `current`: the branch they are all on (null when they are on different branches).
 */
export function commonBranchMenu(
  b: CommonBranch,
  roots: readonly string[],
  current: string | null = null,
  done: () => void = () => {},
  checkedOutInWorktree = false,
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const newFrom: MenuItem = {
    label: tx`New Branch from '${b.name}'…`,
    icon: "branch",
    run: run(() => newBranchInRepos(roots, b)),
  };
  const rename: MenuItem = { label: "Rename…", run: run(() => renameInRepos(b.name, roots, b.upstream)) };
  const worktreeDiff = worktreeDiffItem(branchRef(b.name, b.remote), b.name, run, roots);
  const update: MenuItem = {
    label: "Update",
    icon: "git-pull",
    disabled: !b.upstream || !!useVcs.getState().remoteBusy,
    run: run(() => updateSelection(roots.map((repo) => ({ repo, branch: b })))),
  };
  const currentRoot = currentRepo();
  const worktree = worktreeMenuItem(b, run, roots.find((root) => root === currentRoot) ?? roots[0]);
  if (b.current)
    return [
      newFrom,
      worktree,
      { kind: "separator" },
      worktreeDiff,
      { kind: "separator" },
      update,
      pushBranchItem(b.name, run, roots),
      { kind: "separator" },
      rename,
    ];
  const { heads } = useVcs.getState();
  const selectedHeads = roots.map((root) => heads[root]);
  const rebaseProblem = selectedHeads
    .flatMap((info) => (info ? [branchRebaseProblem(b, info.head)] : []))
    .find(Boolean);
  const bases = selectedHeads.map((info) => info?.head ?? info?.headCommit?.slice(0, 8) ?? current);
  const base = bases[0];
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutInRepos(b, roots)) },
    newFrom,
    worktree,
    ...(bases.every(Boolean)
      ? [
          {
            label:
              base && bases.every((name) => name === base)
                ? tx`Checkout and Rebase onto '${base}'`
                : tx("Checkout and Rebase onto Current"),
            disabled: !b.remote && (checkedOutInWorktree || selectedHeads.some((info) => info?.head === b.name)),
            run: run(() => executeAction("vcs.checkoutAndRebase", { branch: b, repos: roots })),
          },
        ]
      : []),
    { kind: "separator" },
    {
      label: base && bases.every((name) => name === base) ? tx`Compare with '${base}'` : "Compare with Current",
      icon: "diff",
      disabled: !b.remote && selectedHeads.some((info) => info?.head === b.name),
      run: run(() =>
        executeAction("vcs.log.compareBranches", {
          name: b.name,
          rev: branchRef(b.name, b.remote),
          repositories: roots,
        }),
      ),
    },
    ...(current || roots.length === 1 ? [worktreeDiff] : []),
    {
      label: tx`Rebase Current onto '${b.name}'`,
      disabled: !!rebaseProblem,
      hint: rebaseProblem ?? undefined,
      run: run(() => executeAction("vcs.rebaseOntoBranch", { branch: b, repos: roots })),
    },
    {
      label: tx`Merge '${b.name}' into Current`,
      run: run(() => mergeInRepos(b.name, roots, branchRef(b.name, b.remote))),
    },
  ];
  if (!b.remote)
    items.push({ kind: "separator" }, update, pushBranchItem(b.name, run, roots), { kind: "separator" }, rename, {
      label: "Delete",
      danger: true,
      icon: "trash",
      run: run(() => deleteInRepos(b.name, roots)),
    });
  else
    items.push(
      { kind: "separator" },
      ...pullBranchItems(b.name, current, run, roots),
      { kind: "separator" },
      {
        label: "Delete",
        danger: true,
        icon: "trash",
        run: run(() => deleteBranches(roots.map((repo) => ({ repo, branch: b })))),
      },
    );
  return items;
}

/** `items` acting on repository `root`: it is selected (with its branches loaded) before each entry runs. */
export function inRepo(root: string, items: MenuItem[]): MenuItem[] {
  const runInRepo = (run: () => unknown) => () =>
    void focusRepo(root).then(() => {
      if (currentRepo() === root) return run();
    });
  return items.map((item): MenuItem => {
    if (item.kind === "separator" || item.kind === "header") return item;
    if (item.kind === "action")
      return {
        label: item.label ?? item.action,
        icon: item.icon ?? undefined,
        disabled: item.disabled,
        run: runInRepo(() => executeAction(item.action, item.arg)),
      };
    const run = item.run;
    return {
      ...item,
      run: run && runInRepo(run),
      submenu: item.submenu && inRepo(root, item.submenu),
    };
  });
}

/**
 * The Branches pane's menu for branch `b`, which the repositories `roots` all have: its
 * actions act in each of them, like a common branch. `selected` holds one target per
 * repository and selected branch; with several branches selected, Update and Delete act on
 * the whole selection.
 */
export function mergedBranchMenu(
  b: Branch,
  common: CommonBranch,
  roots: readonly string[],
  current: string | null,
  selected: readonly { repo?: string; branch?: Branch }[],
  done: () => void = () => {},
  checkedOutInWorktree = false,
): MenuItem[] {
  const run: Run = (fn) => () => {
    done();
    void fn();
  };
  const several = new Set(selected.map((t) => t.branch?.name)).size > 1;
  const own = commonBranchMenu(common, roots, current, done, checkedOutInWorktree).filter(
    (item) => !several || !("label" in item) || (item.label !== "Update" && item.label !== "Delete"),
  );
  const selection: MenuItem[] = several
    ? [
        ...(selected.filter((t) => t.branch && !t.branch.remote).length > 1
          ? [
              {
                label: "Update Selected",
                icon: "git-pull" as const,
                disabled:
                  !!useVcs.getState().remoteBusy ||
                  !selected.some((target) => !target.branch?.remote && target.branch?.upstream),
                run: run(() => updateSelection(selected)),
              },
            ]
          : []),
        { label: "Delete", danger: true, icon: "trash", run: run(() => deleteBranches(selected)) },
      ]
    : [];
  return tidySeparators([
    ...own,
    { kind: "separator" },
    favoriteMenuItem(b, run),
    historyMenuItem(b.name, run),
    { kind: "separator" },
    ...selection,
  ]);
}

/** Drops leading, trailing and repeated separators. */
function tidySeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    const sep = "kind" in item && item.kind === "separator";
    if (sep && (!out.length || ("kind" in out.at(-1)! && out.at(-1)!.kind === "separator"))) continue;
    out.push(item);
  }
  while (out.length && "kind" in out.at(-1)! && out.at(-1)!.kind === "separator") out.pop();
  return out;
}
