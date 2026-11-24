/**
 * Where committing happens: the Commit tool window (non-modal commit interface) or
 * the Commit dialog with the local changes in the Git tool window (modal one,
 * Settings › Version Control › Commit). Also the push that follows Commit and Push….
 */
import type { ActionContext } from "@/platform/actions";
import { workflowSettings, type GitSettingsValid } from "@/platform/workflowSettings";
import { call, commands } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import { useCommit, type CommitTab } from "./commitStore";
import type { FileStatus } from "@/bindings";
import { commitsStagedPart, groupOf, type CheckState } from "./changes";
import { stashTabOf } from "./gitTabs";
import { selectGitTab } from "./logStore";
import { isProtectedBranch } from "./branches";
import { stripSlash } from "./model";
import { pushTargets, showPushDialog } from "./remoteUi";
import { inspectPushTargets, selectedPushOperation } from "./pushInspection";
import { runRemoteRound } from "./ops";
import type { CommittedRepository } from "./changeOps";
import { repoName, useVcs } from "./store";

export const isModalCommit = () => !workflowSettings().vcs.commit.nonModal;

/** Shows the local changes, Shelf or Stash tab wherever the commit interface puts them. */
export function showLocalChanges(tab: CommitTab = "changes", focus = true) {
  const target = stashTabOf(tab, workflowSettings().vcs.git.combineStashAndShelf);
  if (isModalCommit()) {
    selectGitTab(target);
    toolWindowService().show("git", focus);
    return;
  }
  useCommit.setState({ tab: target });
  toolWindowService().show("commit", focus);
}

/** Commit… (⌘K): focuses the commit message of the Commit window, or opens the Commit dialog. */
export function openCommit() {
  if (!isModalCommit()) return showLocalChanges("changes");
  void import("./CommitDialog").then((m) => m.showCommitDialog());
}

/**
 * Commit… (⌘K) as an action. An explicit path from the Project view scopes the inclusion
 * for either commit interface; otherwise the modal dialog keeps its Local Changes rule.
 */
export function commitFromContext({ arg }: Pick<ActionContext, "arg"> = {}) {
  const explicit = pathArgs(arg);
  const fromLocalChanges = !!(document.activeElement as HTMLElement | null)?.closest?.('[data-changes-tree="local"]');
  const selection = explicit.length ? explicit : fromLocalChanges ? useCommit.getState().selection : [];
  if (explicit.length || isModalCommit())
    useCommit.setState({ checks: selection.length ? includeOnly(useVcs.getState().status, selection) : new Map() });
  openCommit();
}

/** Explicit Project view paths; keyboard and toolbar invocations have no scope of their own. */
function pathArgs(arg: unknown): string[] {
  return (Array.isArray(arg) ? arg : [arg]).filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
}

/** Inclusion that commits only changes at or below `paths`; conflicts are left out. */
export function includeOnly(status: readonly FileStatus[], paths: readonly string[]): Map<string, CheckState> {
  const chosen = [...new Set(paths.map(stripSlash))];
  const atOrBelow = (path: string) => {
    const p = stripSlash(path);
    return chosen.some((root) => p === root || p.startsWith(`${root}/`));
  };
  const checks = new Map<string, CheckState>();
  for (const fs of status) {
    const group = groupOf(fs);
    if (!group || group === "conflicts") continue;
    checks.set(fs.path, !atOrBelow(fs.path) ? "none" : commitsStagedPart(fs) ? "staged" : "all");
  }
  return checks;
}

/**
 * Commit and Push…: whether the Push dialog comes up after the commit (Settings › Git ›
 * "Show Push dialog for Commit and Push", optionally only for protected branches) or
 * the branch is pushed right away. `target` is the remote branch to push to, if known.
 */
export function pushDialogNeeded(
  git: Pick<GitSettingsValid, "showPushDialog" | "pushDialogOnlyProtected" | "protectedBranches">,
  target: string | null,
): boolean {
  if (!target) return true;
  if (!git.showPushDialog) return false;
  return !git.pushDialogOnlyProtected || isProtectedBranch(target, git.protectedBranches);
}

/** Commit and Push checks the selected histories before skipping the Push dialog. */
export async function pushAfterCommit(committed: readonly CommittedRepository[]) {
  if (!committed.length) return;
  const git = workflowSettings().vcs.git;
  const review = () => showPushDialog({ selected: committed.map(({ repo }) => repo) });
  if (git.showPushDialog && !git.pushDialogOnlyProtected) return review();

  const planned = (
    await Promise.all(
      committed.map(async ({ repo, id }) => {
        const target = await call(commands.vcsDefaultPushTarget(repo, null)).catch(() => null);
        return target ? { repo, id, ...target } : null;
      }),
    )
  ).filter((target) => target !== null);
  if (planned.length !== committed.length || planned.some(({ selection }) => pushDialogNeeded(git, selection.target)))
    return review();

  let inspected = await inspectPushTargets(planned);
  if (!inspected || inspected.some((result, i) => !result.remoteChecked || result.localTip !== planned[i]!.id))
    return review();
  const missing = planned.filter((_, i) => inspected![i]!.state === "fetchRequired");
  if (missing.length) {
    const failures = await runRemoteRound(
      missing.map(({ repo, selection }) => ({
        repo,
        op: { op: "fetchPushTarget" as const, selection },
      })),
    );
    if (!failures || failures.length) return review();
    inspected = await inspectPushTargets(planned);
  }
  if (
    !inspected ||
    inspected.some((result, i) => {
      const { id, selection } = planned[i]!;
      return (
        !result.remoteChecked ||
        result.state !== "ready" ||
        result.localTip !== id ||
        (selection.branch === null && result.remoteTip !== "")
      );
    })
  )
    return review();

  await pushTargets(
    planned.map(({ repo, selection, setUpstream }, i) => ({
      repo,
      detail: `${repo ? `${repoName(repo)}: ` : ""}${selection.branch ?? selection.revision?.slice(0, 8)} → ${selection.remote}/${selection.target}`,
      op: selectedPushOperation(
        { repo, selection },
        {
          setUpstream: setUpstream && inspected![i]!.remoteTip === "",
          forceWithLease: false,
          tags: null,
          noVerify: false,
        },
        inspected![i],
      ),
    })),
  );
}
