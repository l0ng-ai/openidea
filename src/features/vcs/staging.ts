/**
 * Staging area (Settings › Version Control › Git › Enable staging area): the Commit tool
 * window works on the index instead of inclusion checkboxes and change lists. The commit
 * takes what is staged; with nothing staged, Commit All takes every tracked change.
 */
import type { ChangelistState, FileStatus } from "@/bindings";
import { useMemo } from "react";
import { onWorkflowSettingsChange, useWorkflowSettings, workflowSettings } from "@/platform/workflowSettings";
import { addedThenDeleted, filesOf, groupOf, renamedFromPath, type ChangeNode, type CheckState } from "./changes";
import { withListDefaults } from "./changelists";
import { rootOf, stripSlash } from "./model";
import { useCommit } from "./commitStore";
import { useVcs } from "./store";

export const STAGE_WITHOUT_CONTENT = "vcs.stageWithoutContent";
export const STAGE_ALL_TRACKED = "vcs.stageAllTracked";
export const STASH_SILENTLY = "vcs.stashSilently";
export const TOGGLE_STAGED_REPOSITORIES = "vcs.toggleStagedRepositories";
export const ROLLBACK_UNSTAGED = "vcs.rollbackUnstaged";

const enabled = (vcs: { git: { stagingArea: boolean }; commit: { nonModal: boolean } }) =>
  vcs.git.stagingArea && vcs.commit.nonModal;

/** Whether the Commit tool window works on the index (only with the non-modal commit interface). */
export const stagingAreaOn = () => enabled(workflowSettings().vcs);

export const useStagingArea = () => useWorkflowSettings((s) => enabled(s.vcs));
export const onStagingAreaChange = (listener: () => void) => onWorkflowSettingsChange((s) => enabled(s.vcs), listener);

export const isIntentToAdd = (file: FileStatus) => file.staged === null && file.unstaged === "added";

export function canRestoreUnstaged(file: FileStatus): boolean {
  return (
    !isIntentToAdd(file) &&
    !["deleted", "conflicted", "ignored"].includes(file.staged ?? "") &&
    !!file.unstaged &&
    !["untracked", "conflicted", "ignored"].includes(file.unstaged)
  );
}

export function unstagedSelection(nodes: readonly ChangeNode[]): FileStatus[] {
  return filesOf(nodes.filter((node) => node.group === "unstaged")).filter(canRestoreUnstaged);
}

export function unstagingPaths(files: readonly FileStatus[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) => {
        const from = file.staged === "renamed" ? renamedFromPath(file) : null;
        return from ? [stripSlash(file.path), from] : [stripSlash(file.path)];
      }),
    ),
  ];
}

export function bulkStagePaths(status: readonly FileStatus[], includeUntracked: boolean): string[] {
  const paths = new Set<string>();
  for (const file of status) {
    if (!file.unstaged || file.unstaged === "ignored" || groupOf(file) === "conflicts") continue;
    if (!includeUntracked && file.unstaged === "untracked") continue;
    paths.add(stripSlash(file.path));
    const from = file.unstaged === "renamed" ? renamedFromPath(file) : null;
    if (from) paths.add(from);
  }
  return [...paths];
}

export function stashableRoots(status: readonly FileStatus[], roots: readonly string[]): string[] {
  const changed = new Set<string>();
  // `git stash` refuses a repository with unmerged paths.
  const conflicted = new Set<string>();
  for (const file of status) {
    const kinds = [file.staged, file.unstaged];
    const root = rootOf(file.path, roots);
    if (!root) continue;
    if (kinds.includes("conflicted")) conflicted.add(root);
    else if (kinds.some((kind) => kind && kind !== "untracked" && kind !== "ignored")) changed.add(root);
  }
  return roots.filter((root) => changed.has(root) && !conflicted.has(root));
}

const staged = (f: FileStatus) => !!f.staged && f.staged !== "conflicted";

export function stagedRepositories(status: readonly FileStatus[], roots: readonly string[]): ReadonlySet<string> {
  const repositories = new Set<string>();
  for (const file of status) {
    if (!staged(file) || (groupOf(file) !== "changes" && !addedThenDeleted(file))) continue;
    const repo = rootOf(file.path, roots);
    if (repo) repositories.add(repo);
  }
  return repositories;
}

/** Repository inclusion is available when the staging tree shows more than one staged repository. */
export function stagedRepositoryScope(status: readonly FileStatus[], roots: readonly string[], groupByRepo: boolean) {
  if (!groupByRepo || roots.length < 2) return null;
  const staged = stagedRepositories(status, roots);
  return staged.size > 1 ? staged : null;
}

export function useStagedRepositoryScope() {
  const staging = useStagingArea();
  const status = useVcs((s) => s.status);
  const roots = useVcs((s) => s.roots);
  const groupByRepo = useCommit((s) => s.groupByRepo);
  return useMemo(
    () => stagedRepositoryScope(status, roots, staging && groupByRepo),
    [status, roots, staging, groupByRepo],
  );
}

/** An unchecked repository's index stays outside the commit plan. */
export function statusForCommit(
  status: readonly FileStatus[],
  roots: readonly string[],
  scope: ReadonlySet<string> | null,
  excluded: ReadonlySet<string>,
): readonly FileStatus[] {
  if (!scope) return status;
  return status.filter((file) => {
    const repo = rootOf(file.path, roots);
    return repo !== null && scope.has(repo) && !excluded.has(repo);
  });
}

/** Nothing is staged, but tracked files changed: Commit becomes Commit All. */
export function isCommitAll(status: readonly FileStatus[]): boolean {
  return !status.some(staged) && status.some((f) => groupOf(f) === "changes");
}

/**
 * The inclusion the index means: staged files with their staged content, nothing else;
 * with nothing staged (Commit All), every tracked change with its working-tree content.
 */
export function stagingChecks(status: readonly FileStatus[], allowCommitAll = true): Map<string, CheckState> {
  const all = allowCommitAll && isCommitAll(status);
  const out = new Map<string, CheckState>();
  for (const f of status) {
    // A staged addition deleted from disk is committed as staged (nothing against HEAD for Commit All).
    if (addedThenDeleted(f) && !all) out.set(f.path, "staged");
    if (groupOf(f) !== "changes") continue;
    out.set(f.path, all ? "all" : staged(f) ? "staged" : "none");
  }
  return out;
}

/** What the commit includes: the index in staging mode, else the checkboxes over the change list defaults. */
export function inclusionChecks(
  status: readonly FileStatus[],
  root: string,
  lists: ChangelistState,
  checks: ReadonlyMap<string, CheckState>,
  staging = stagingAreaOn(),
  allowCommitAll = workflowSettings().vcs.commit.commitAllWhenNothingStaged,
): Map<string, CheckState> {
  return staging ? stagingChecks(status, allowCommitAll) : withListDefaults(status, root, lists, checks);
}
