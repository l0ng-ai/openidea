/**
 * Staging area (Settings › Version Control › Git › Enable staging area): the Commit tool
 * window works on the index instead of inclusion checkboxes and change lists. The commit
 * takes what is staged; with nothing staged, Commit All takes every tracked change.
 */
import type { ChangelistState, FileStatus } from "@/bindings";
import { useWorkflowSettings, workflowSettings } from "@/platform/workflowSettings";
import { groupOf, type CheckState } from "./changes";
import { withListDefaults } from "./changelists";

const enabled = (vcs: { git: { stagingArea: boolean }; commit: { nonModal: boolean } }) =>
  vcs.git.stagingArea && vcs.commit.nonModal;

/** Whether the Commit tool window works on the index (only with the non-modal commit interface). */
export const stagingAreaOn = () => enabled(workflowSettings().vcs);

export const useStagingArea = () => useWorkflowSettings((s) => enabled(s.vcs));

const staged = (f: FileStatus) => !!f.staged && f.staged !== "conflicted";

/** Nothing is staged, but tracked files changed: Commit becomes Commit All. */
export function isCommitAll(status: readonly FileStatus[]): boolean {
  return !status.some(staged) && status.some((f) => groupOf(f) === "changes");
}

/**
 * The inclusion the index means: staged files with their staged content, nothing else;
 * with nothing staged (Commit All), every tracked change with its working-tree content.
 */
export function stagingChecks(status: readonly FileStatus[]): Map<string, CheckState> {
  const all = isCommitAll(status);
  const out = new Map<string, CheckState>();
  for (const f of status) {
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
): Map<string, CheckState> {
  return staging ? stagingChecks(status) : withListDefaults(status, root, lists, checks);
}
