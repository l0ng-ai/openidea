/**
 * The details tab's operations (`GHPRReviewFlowViewModelImpl`, `GHPRBranchesViewModel`,
 * `GHPRResolveConflictsLocallyViewModel`): one review-flow action runs at a time per pull
 * request (`isBusy` disables the others), mutations go through `data/operations.ts`, local
 * git through `data/local.ts` and the vcs feature. Failures are reported as notifications.
 */
import { create } from "zustand";
import type { DiffData } from "@/features/vcs/diffInput";
import { mergeIntoCurrent } from "@/features/vcs/branchOps";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { errorMessage } from "../api/client";
import type { GHCommitFile, GHPullRequest, GHPullRequestRequestedReviewer } from "../api/types";
import { mergeCommitMessage, splitCommitMessage, type ReviewerWithState } from "../data/model";
import { checkoutPullRequest, fileDiffData, prepareDiff } from "../data/local";
import * as ops from "../data/operations";
import { loadPullRequestData } from "../data/pullRequest";
import { mergeCommitMessageDialog } from "../ui/dialogs";
import { reviewersDelta, type MergeMethod } from "./model";

/** Per pull request: the running review-flow action's progress text (empty string: no text). */
export const useFlowBusy = create<{ busy: Record<number, string> }>(() => ({ busy: {} }));

function setBusy(number: number, text: string | null) {
  useFlowBusy.setState((s) => {
    const busy = { ...s.busy };
    if (text === null) delete busy[number];
    else busy[number] = text;
    return { busy };
  });
}

export const isFlowBusy = (number: number) => useFlowBusy.getState().busy[number] !== undefined;

function reportError(title: string, e: unknown) {
  notifications().notify({ group: "vcs", level: "error", title, body: errorMessage(e), key: "github-details" });
}

/** `SingleCoroutineLauncher`: runs `action` unless another one of the pull request runs. */
export async function runFlow(number: number, action: () => Promise<unknown>, progress = ""): Promise<void> {
  if (isFlowBusy(number)) return;
  setBusy(number, progress);
  try {
    await action();
  } catch (e) {
    reportError(tx("Pull request action failed"), e);
  } finally {
    setBusy(number, null);
  }
}

/** `adjustReviewers` with IntelliJ's progress text. */
export function adjustReviewers(
  number: number,
  current: readonly GHPullRequestRequestedReviewer[],
  chosen: readonly GHPullRequestRequestedReviewer[],
) {
  const d = reviewersDelta(current, chosen);
  if (!d.added.length && !d.removed.length) return Promise.resolve();
  return runFlow(number, () => ops.adjustReviewers(number, d), tx("Adjusting reviewers…"));
}

/** "Re-request Review…": requests everyone who reviewed again. */
export function reRequestReview(
  number: number,
  requested: readonly GHPullRequestRequestedReviewer[],
  reviewers: readonly ReviewerWithState[],
) {
  return adjustReviewers(number, requested, [...requested, ...reviewers.map((r) => r.reviewer)]);
}

/** Merge… / Squash and Merge… (after the commit message dialog) / Rebase. */
export function merge(number: number, method: MergeMethod) {
  return runFlow(number, async () => {
    const pr = await loadPullRequestData(number, "details");
    if (method === "rebase") return ops.mergePullRequest(number, "rebase", pr.headRefOid);
    const headlines =
      method === "squash"
        ? (await loadPullRequestData(number, "commits")).map((c) => c.commit.messageHeadline)
        : undefined;
    const message = await mergeCommitMessageDialog({
      title: method === "squash" ? "Squash and Merge Review" : "Merge Review",
      message: mergeCommitMessage(pr, headlines),
    });
    if (message === null) return;
    await ops.mergePullRequest(number, method, pr.headRefOid, splitCommitMessage(message));
  });
}

// ---------------------------------------------------------------------------
// Branches

/** "Show in Git Log": fetches the pull request, then shows its head in a log tab of its own. */
export async function showInGitLog(pr: GHPullRequest, headRemote: string | null) {
  const revs = await prepareDiff(pr);
  if (!revs) return;
  const tracked = headRemote ? `${headRemote}/${pr.headRefName}` : null;
  const branches = tracked ? await call(commands.vcsBranches(null)).catch(() => []) : [];
  const ref = tracked && branches.some((b) => b.remote && b.name === tracked) ? tracked : revs.head;
  await executeAction("vcs.showLog", { branch: ref });
}

/** "Copy Branch Name". */
export async function copyBranchName(name: string) {
  await navigator.clipboard?.writeText(name);
}

/**
 * "Resolve": checks the head branch out (fetching what it needs) and merges the base
 * branch into it, which stops on the conflicts for the user to resolve and push.
 */
export function resolveConflictsLocally(
  number: number,
  target: { baseRemote: string; baseRefName: string },
  isCheckedOut: boolean,
) {
  return runFlow(number, async () => {
    const pr = await loadPullRequestData(number, "details");
    // Fetches the base branch as well (updating `<remote>/<base>`).
    if (!(await prepareDiff(pr))) return;
    if (!isCheckedOut && !(await checkoutPullRequest(number))) return;
    await mergeIntoCurrent(`${target.baseRemote}/${target.baseRefName}`);
  });
}

/** Whether `oid` is in the history of HEAD (`isInCurrentHistory`); false when unknown. */
export async function isInCurrentHistory(oid: string): Promise<boolean> {
  try {
    const commits = await call(
      commands.vcsLog(null, {
        branch: null,
        path: null,
        author: null,
        text: null,
        range: `HEAD..${oid}`,
        skip: 0,
        limit: 1,
      }),
    );
    return commits.length === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Diffs of a single commit

/** Opens a file of commit `sha` (its parent ↔ it) in the diff viewer. */
export async function openCommitFileDiff(number: number, sha: string, file: GHCommitFile) {
  const pr = await loadPullRequestData(number, "details");
  const revs = await prepareDiff(pr);
  if (!revs) return;
  const data: DiffData = fileDiffData(pr, file, { ...revs, base: `${sha}^`, head: sha, files: [] });
  const short = sha.slice(0, 8);
  data.left = data.left.type === "rev" ? { ...data.left, label: `${short}^` } : data.left;
  data.right = data.right.type === "rev" ? { ...data.right, label: short } : data.right;
  data.annotations = [];
  await executeAction("vcs.openDiff", data);
}
