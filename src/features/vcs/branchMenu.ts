/** Branch context menu shared by the Branches popup and the Git Log Branches pane (IDEA's Git.Branch actions). */
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { isFavoriteBranch } from "./branches";
import {
  checkoutAndRebase,
  checkoutBranch,
  checkoutDetached,
  checkoutInRepos,
  deleteBranch,
  deleteInRepos,
  deleteRemoteBranch,
  mergeInRepos,
  newBranchInRepos,
  rebaseInRepos,
  loadFavoriteBranches,
  mergeIntoCurrent,
  newBranch,
  rebaseOnto,
  renameBranch,
  toggleFavoriteBranch,
  updateBranch,
  useFavoriteBranches,
} from "./branchOps";
import { showCompareBranches } from "./CompareBranches";
import { showDiffWithWorkingTree } from "./operations";
import type { CommonBranch } from "./repoBranches";
import { runRemote, saveAll } from "./ops";
import { focusRepo, useVcs } from "./store";
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

export function branchMenu(b: Branch, current: string | null, done: () => void = () => {}): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const cur = current ?? "HEAD";
  loadFavoriteBranches();
  const favorite = isFavoriteBranch(b, useFavoriteBranches.getState().names);
  const favoriteItem: MenuItem = {
    label: favorite ? "Remove from Favorites" : "Add to Favorites",
    icon: "star",
    run: run(() => toggleFavoriteBranch(b)),
  };
  const history: MenuItem = {
    label: "Show History",
    icon: "history",
    run: run(() => executeAction("vcs.showLog", { branch: b.name })),
  };
  if (b.current) {
    return [
      { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch()) },
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => executeAction("vcs.update")) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push")) },
      { kind: "separator" },
      { label: "Rename…", run: run(() => renameBranch(b.name)) },
      favoriteItem,
      history,
    ];
  }
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutBranch(b.name)) },
    { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch(b.name)) },
    ...(current ? [{ label: tx`Checkout and Rebase onto '${cur}'`, run: run(() => checkoutAndRebase(b.name)) }] : []),
    { kind: "separator" },
    { label: tx`Compare with '${cur}'`, icon: "diff", run: run(() => showCompareBranches(b.name)) },
    { label: "Show Diff with Working Tree", run: run(() => showDiffWithWorkingTree(b.name)) },
    history,
    { kind: "separator" },
    { label: tx`Rebase '${cur}' onto '${b.name}'`, run: run(() => rebaseOnto(b.name)) },
    { label: tx`Merge '${b.name}' into '${cur}'`, run: run(() => mergeIntoCurrent(b.name)) },
  ];
  if (b.remote)
    items.push(
      { label: tx`Pull into '${cur}' Using Rebase`, run: run(() => pullInto(b.name, true)) },
      { label: tx`Pull into '${cur}' Using Merge`, run: run(() => pullInto(b.name, false)) },
    );
  if (!b.remote)
    items.push(
      { kind: "separator" },
      { label: "Update", icon: "git-pull", disabled: !b.upstream, run: run(() => updateBranch(b.name)) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { branch: b.name })) },
    );
  items.push(
    { kind: "separator" },
    ...(b.remote ? [] : [{ label: "Rename…", run: run(() => renameBranch(b.name)) }]),
    favoriteItem,
    {
      label: "Delete",
      danger: true,
      icon: "trash",
      run: run(() => (b.remote ? deleteRemoteBranch(b.name) : deleteBranch(b.name))),
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
  ];
}

/** Entries for a branch common to all repositories: each acts in every one of `roots`. */
export function commonBranchMenu(b: CommonBranch, roots: readonly string[], done: () => void = () => {}): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const newFrom: MenuItem = {
    label: tx`New Branch from '${b.name}'…`,
    icon: "branch",
    run: run(() => newBranchInRepos(roots, b.name)),
  };
  if (b.current)
    return [
      newFrom,
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => executeAction("vcs.update")) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push")) },
    ];
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutInRepos(b.name, roots)) },
    newFrom,
    { kind: "separator" },
    { label: tx`Rebase Current onto '${b.name}'`, run: run(() => rebaseInRepos(b.name, roots)) },
    { label: tx`Merge '${b.name}' into Current`, run: run(() => mergeInRepos(b.name, roots)) },
  ];
  if (!b.remote)
    items.push(
      { kind: "separator" },
      { label: "Delete", danger: true, icon: "trash", run: run(() => deleteInRepos(b.name, roots)) },
    );
  return items;
}

/** `items` acting on repository `root`: it is selected (with its branches loaded) before each entry runs. */
export function inRepo(root: string, items: MenuItem[]): MenuItem[] {
  return items.map((item): MenuItem => {
    if (item.kind === "separator" || item.kind === "header") return item;
    if (item.kind === "action")
      return {
        label: item.label ?? item.action,
        icon: item.icon,
        disabled: item.disabled,
        run: () => void focusRepo(root).then(() => executeAction(item.action, item.arg)),
      };
    const run = item.run;
    return {
      ...item,
      run: run && (() => void focusRepo(root).then(run)),
      submenu: item.submenu && inRepo(root, item.submenu),
    };
  });
}
