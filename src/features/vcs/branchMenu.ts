/** Branch context menu shared by the Branches popup and the Git Log Branches pane (IDEA's Git.Branch actions). */
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { isFavoriteBranch } from "./branches";
import {
  branchRef,
  checkoutAndRebase,
  checkoutBranch,
  checkoutDetached,
  checkoutAndRebaseInRepos,
  checkoutInRepos,
  deleteBranch,
  deleteBranches,
  deleteInRepos,
  deleteRemoteBranch,
  deleteTag,
  knownRemotes,
  pushTag,
  mergeInRepos,
  newBranchInRepos,
  rebaseInRepos,
  renameInRepos,
  loadFavoriteBranches,
  mergeIntoCurrent,
  newBranch,
  rebaseOnto,
  renameBranch,
  toggleFavoriteBranch,
  updateBranches,
  useFavoriteBranches,
} from "./branchOps";
import { showCompareBranches } from "./CompareBranches";
import { showDiffWithWorkingTree } from "./operations";
import type { CommonBranch } from "./repoBranches";
import { runRemote, saveAll } from "./ops";
import { currentRepo, focusRepo, useVcs } from "./store";
import { tx } from "@/platform/i18n";

/** `git pull <remote> <branch>` into the current branch (`origin/feat/x` → origin, feat/x). */
async function pullInto(remoteBranch: string, rebase: boolean) {
  const i = remoteBranch.indexOf("/");
  if (i <= 0) return;
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runRemote(
    { op: "pullFrom", remote: remoteBranch.slice(0, i), branches: [remoteBranch.slice(i + 1)], rebase, options: {} },
    `${current} ← ${remoteBranch}`,
  );
}

type Run = (fn: () => unknown) => () => void;

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

function worktreeMenuItem(branch: Pick<Branch, "name" | "remote" | "current">, run: Run, repo?: string): MenuItem {
  return {
    label: tx`New Worktree from '${branch.name}'…`,
    run: run(() => executeAction("vcs.newWorktree", { repo: repo ?? currentRepo(), branch })),
  };
}

/** The Branches pane's context menu: `selected` carries the multi-selection, which Update Selected and Delete act on as a whole. */
export function branchMenu(
  b: Branch,
  current: string | null,
  done: () => void = () => {},
  selected: readonly { repo?: string; branch?: Branch }[] = [],
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const cur = current ?? "HEAD";
  const favoriteItem = favoriteMenuItem(b, run);
  // Update Selected acts on every selected local branch, each in its own repository.
  const update: MenuItem =
    selected.filter((t) => t.branch && !t.branch.remote).length > 1
      ? { label: "Update Selected", icon: "git-pull", run: run(() => updateBranches(selected)) }
      : {
          label: "Update",
          icon: "git-pull",
          disabled: !b.current && !b.upstream,
          run: run(() => updateBranches([{ branch: b }])),
        };
  const history = historyMenuItem(b.name, run);
  if (b.current) {
    return [
      { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch()) },
      worktreeMenuItem(b, run),
      { kind: "separator" },
      update,
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { repo: currentRepo() })) },
      { kind: "separator" },
      { label: "Rename…", run: run(() => renameBranch(b)) },
      favoriteItem,
      history,
    ];
  }
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutBranch(b.name)) },
    { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch(b.name)) },
    worktreeMenuItem(b, run),
    ...(current ? [{ label: tx`Checkout and Rebase onto '${cur}'`, run: run(() => checkoutAndRebase(b.name)) }] : []),
    { kind: "separator" },
    { label: tx`Compare with '${cur}'`, icon: "diff", run: run(() => showCompareBranches(b.name)) },
    { label: "Show Diff with Working Tree", run: run(() => showDiffWithWorkingTree(b.name)) },
    history,
    { kind: "separator" },
    { label: tx`Rebase '${cur}' onto '${b.name}'`, run: run(() => rebaseOnto(b.name, branchRef(b.name, b.remote))) },
    {
      label: tx`Merge '${b.name}' into '${cur}'`,
      run: run(() => mergeIntoCurrent(b.name, undefined, branchRef(b.name, b.remote))),
    },
  ];
  if (b.remote)
    items.push(
      { label: tx`Pull into '${cur}' Using Rebase`, run: run(() => pullInto(b.name, true)) },
      { label: tx`Pull into '${cur}' Using Merge`, run: run(() => pullInto(b.name, false)) },
    );
  if (!b.remote)
    items.push({ kind: "separator" }, update, {
      label: "Push…",
      icon: "git-push",
      run: run(() => executeAction("vcs.push", { branch: b.name })),
    });
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
export function tagMenu(tag: string, done: () => void = () => {}): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  return [
    { label: "Checkout", run: run(() => checkoutDetached(tag, tag)) },
    { label: tx`New Branch from '${tag}'…`, icon: "branch", run: run(() => newBranch(tag)) },
    { kind: "separator" },
    { label: "Compare with Current", icon: "diff", run: run(() => showCompareBranches(tag)) },
    { label: "Show Diff with Working Tree", run: run(() => showDiffWithWorkingTree(tag)) },
    { label: "Show History", icon: "history", run: run(() => executeAction("vcs.showLog", { branch: tag })) },
    ...knownRemotes().flatMap((remote, i): MenuItem[] => [
      ...(i === 0 ? [{ kind: "separator" } as const] : []),
      { label: tx`Push to ${remote}`, icon: "git-push", run: run(() => pushTag(tag, remote)) },
    ]),
    { kind: "separator" },
    { label: "Delete", danger: true, icon: "trash", run: run(() => deleteTag(tag)) },
  ];
}

/**
 * Entries for a branch common to all repositories: each acts in every one of `roots`.
 * `current`: the branch they are all on (null when they are on different branches).
 */
export function commonBranchMenu(
  b: CommonBranch,
  roots: readonly string[],
  current: string | null,
  done: () => void = () => {},
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const newFrom: MenuItem = {
    label: tx`New Branch from '${b.name}'…`,
    icon: "branch",
    run: run(() => newBranchInRepos(roots, b.name)),
  };
  const rename: MenuItem = { label: "Rename…", run: run(() => renameInRepos(b.name, roots, b.upstream)) };
  const currentRoot = currentRepo();
  const worktree = worktreeMenuItem(b, run, roots.find((root) => root === currentRoot) ?? roots[0]);
  if (b.current)
    return [
      newFrom,
      worktree,
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => executeAction("vcs.update")) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push")) },
      { kind: "separator" },
      rename,
    ];
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutInRepos(b.name, roots)) },
    newFrom,
    worktree,
    ...(current
      ? [
          {
            label: tx`Checkout and Rebase onto '${current}'`,
            run: run(() => checkoutAndRebaseInRepos(b.name, current, roots)),
          },
        ]
      : []),
    { kind: "separator" },
    { label: tx`Rebase Current onto '${b.name}'`, run: run(() => rebaseInRepos(b.name, roots)) },
    { label: tx`Merge '${b.name}' into Current`, run: run(() => mergeInRepos(b.name, roots)) },
  ];
  if (!b.remote)
    items.push(
      { kind: "separator" },
      {
        label: "Update",
        icon: "git-pull",
        run: run(() => updateBranches(roots.map((repo) => ({ repo, branch: b })))),
      },
      { kind: "separator" },
      rename,
      { label: "Delete", danger: true, icon: "trash", run: run(() => deleteInRepos(b.name, roots)) },
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
        icon: item.icon,
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
): MenuItem[] {
  const run: Run = (fn) => () => {
    done();
    void fn();
  };
  const several = new Set(selected.map((t) => t.branch?.name)).size > 1;
  const own = commonBranchMenu(common, roots, current, done).filter(
    (item) => !several || !("label" in item) || (item.label !== "Update" && item.label !== "Delete"),
  );
  const selection: MenuItem[] = several
    ? [
        ...(selected.filter((t) => t.branch && !t.branch.remote).length > 1
          ? [{ label: "Update Selected", icon: "git-pull" as const, run: run(() => updateBranches(selected)) }]
          : []),
        { label: "Delete", danger: true, icon: "trash", run: run(() => deleteBranches(selected)) },
      ]
    : b.remote
      ? [{ label: "Delete", danger: true, icon: "trash", run: run(() => deleteBranches(selected)) }]
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
