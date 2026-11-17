/**
 * Where committing happens: the Commit tool window (non-modal commit interface) or
 * the Commit dialog with the local changes in the Git tool window (modal one,
 * Settings › Version Control › Commit). Also the push that follows Commit and Push….
 */
import { workflowSettings, type GitSettingsValid } from "@/platform/workflowSettings";
import { toolWindowService } from "@/workbench/contributions";
import { useCommit, type CommitTab } from "./commitStore";
import type { FileStatus } from "@/bindings";
import { groupOf, isPartiallyStaged, type CheckState } from "./changes";
import { stashTabOf } from "./gitTabs";
import { selectGitTab } from "./logStore";
import { isProtectedBranch, pushWithAutoUpdate, showPushDialog } from "./remoteUi";
import { refreshNow, useVcs } from "./store";

export const isModalCommit = () => !workflowSettings().vcs.commit.nonModal;

/** Shows the local changes, Shelf or Stash tab wherever the commit interface puts them. */
export function showLocalChanges(tab: CommitTab = "changes", focus = true) {
  const target = stashTabOf(tab, workflowSettings().vcs.git.combineStashAndShelf);
  if (isModalCommit()) {
    selectGitTab(target);
    toolWindowService().show("git", focus);
    return;
  }
  useCommit.setState((s) => ({ tab: target, focusTick: tab === "changes" ? s.focusTick + 1 : s.focusTick }));
  toolWindowService().show("commit", focus);
}

/** Commit… (⌘K): focuses the commit message of the Commit window, or opens the Commit dialog. */
export function openCommit() {
  if (!isModalCommit()) return showLocalChanges("changes");
  void import("./CommitDialog").then((m) => m.showCommitDialog());
}

/**
 * Commit… (⌘K) as an action: with the modal interface the dialog includes just the files
 * selected in Local Changes when invoked from there, otherwise the default inclusion.
 */
export function commitFromContext() {
  if (isModalCommit()) {
    const fromLocalChanges = !!(document.activeElement as HTMLElement | null)?.closest?.('[data-changes-tree="local"]');
    const selection = fromLocalChanges ? useCommit.getState().selection : [];
    useCommit.setState({ checks: selection.length ? includeOnly(useVcs.getState().status, selection) : new Map() });
  }
  openCommit();
}

/** Inclusion that commits only `paths` of `status` (files elsewhere left out, conflicts as they are). */
export function includeOnly(status: readonly FileStatus[], paths: readonly string[]): Map<string, CheckState> {
  const chosen = new Set(paths);
  const checks = new Map<string, CheckState>();
  for (const fs of status) {
    const group = groupOf(fs);
    if (!group || group === "conflicts") continue;
    checks.set(fs.path, !chosen.has(fs.path) ? "none" : isPartiallyStaged(fs) ? "staged" : "all");
  }
  return checks;
}

/**
 * Commit and Push…: whether the Push dialog comes up after the commit (Settings › Git ›
 * "Show Push dialog for Commit and Push", optionally only for protected branches) or
 * the branch is pushed right away. `target` is the remote branch pushed to (null: none
 * can be told, e.g. a detached HEAD, which always needs the dialog).
 */
export function pushDialogNeeded(
  git: Pick<GitSettingsValid, "showPushDialog" | "pushDialogOnlyProtected" | "protectedBranches">,
  target: string | null,
): boolean {
  if (!target) return true;
  if (!git.showPushDialog) return false;
  return !git.pushDialogOnlyProtected || isProtectedBranch(target, git.protectedBranches);
}

/** After Commit and Push…: the Push dialog, or a push of the current branch. */
export async function pushAfterCommit() {
  await refreshNow();
  const { branch, roots } = useVcs.getState();
  const head = branch?.head ?? null;
  const upstream = branch?.upstream ?? null;
  const target = upstream ? upstream.slice(upstream.indexOf("/") + 1) : head;
  // Several repositories: which of them to push is chosen in the dialog.
  if (roots.length > 1 || pushDialogNeeded(workflowSettings().vcs.git, target)) return showPushDialog();
  await pushWithAutoUpdate(
    { op: "push", force_with_lease: false, set_upstream: !upstream, tags: null },
    upstream ? `${head} → ${upstream}` : `${head} → new remote branch`,
  );
}
