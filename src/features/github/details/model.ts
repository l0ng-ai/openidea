/**
 * Pure rules of the details tab, ported from IntelliJ: the review flow
 * (`GHPRReviewFlowViewModelImpl`, `GHPRDetailsActionsComponentFactory`), the status
 * section (`GHPRStatusChecksComponentFactory`, `CodeReviewDetailsStatusComponentFactory`,
 * `GHPRReviewerStateUIUtil`), the commit picker (`CodeReviewDetailsCommitsComponentFactory`),
 * the branch widget (`GHPRBranchesViewModel`), the changes tree's progress state
 * (`CodeReviewProgressTreeModel`, `GHPRChangeListViewModel`) and the viewed toggle
 * (`GHPRViewedStateToggleAction`).
 */
import type { BranchInfo } from "@/bindings";
import { buildFileTree, type FileTreeNode } from "@/features/vcs/fileTree";
import type { EffectiveKind } from "@/features/vcs/model";
import { tx } from "@/platform/i18n";
import type {
  CodeReviewCIJob,
  CodeReviewCIJobState,
  GHCommitFile,
  GHPRReviewerState,
  GHPullRequest,
  GHPullRequestFileViewedState,
  GHPullRequestRequestedReviewer,
  GHPullRequestReviewThread,
  GHRepositoryPermissionLevel,
  GHUser,
} from "../api/types";
import { hasPermission, isTeam, reviewerKey, type ReviewerWithState } from "../data/model";
import type { GHRemote } from "../data/repository";

// ---------------------------------------------------------------------------
// Review flow

/** `ReviewRequestState`: a draft is DRAFT whatever its state. */
export type ReviewRequestState = "OPENED" | "CLOSED" | "MERGED" | "DRAFT";
/** `ReviewRole`. */
export type ReviewRole = "AUTHOR" | "REVIEWER" | "GUEST";
/** `ReviewState`: the overall review state. */
export type ReviewState = "ACCEPTED" | "WAIT_FOR_UPDATES" | "NEED_REVIEW";

export function reviewRequestState(pr: Pick<GHPullRequest, "state" | "isDraft">): ReviewRequestState {
  if (pr.isDraft) return "DRAFT";
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.state === "MERGED") return "MERGED";
  return "OPENED";
}

/** AUTHOR when `me` wrote the pull request, REVIEWER when requested or when they reviewed, else GUEST. */
export function reviewRole(
  pr: Pick<GHPullRequest, "author" | "reviewRequests" | "reviews">,
  me: Pick<GHUser, "id">,
): ReviewRole {
  if (pr.author?.id === me.id) return "AUTHOR";
  const requested = pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.id === me.id);
  if (requested || pr.reviews.nodes.some((r) => r.author?.id === me.id)) return "REVIEWER";
  return "GUEST";
}

/**
 * ACCEPTED when the approvals reach the required count (one when none is required),
 * else from GitHub's review decision.
 */
export function overallReviewState(
  pr: Pick<GHPullRequest, "reviewDecision">,
  reviewers: readonly ReviewerWithState[],
  requiredApprovingReviewsCount: number,
): ReviewState {
  const approved = reviewers.filter((r) => r.state === "APPROVED").length;
  const isApproved = requiredApprovingReviewsCount === 0 ? approved > 0 : approved >= requiredApprovingReviewsCount;
  if (isApproved || pr.reviewDecision === "APPROVED") return "ACCEPTED";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "WAIT_FOR_UPDATES";
  return "NEED_REVIEW";
}

/** `GHPRReviewerState.isAwaitingReview`. */
export const isAwaitingReview = (s: GHPRReviewerState | null | undefined) =>
  s === "NEEDS_REVIEW" || s === "RE_REQUESTED";

/** Entries of the More (⋯) menu. */
export type MoreItem = "requestReview" | "mergeGroup" | "close";

/** Which review-flow controls an open pull request shows. */
export interface OpenedActions {
  requestReview: boolean;
  reRequestReview: boolean;
  submitReview: boolean;
  setMyselfAsReviewer: boolean;
  merge: boolean;
  more: MoreItem[];
}

/** The open pull request's buttons and More menu for `role` (`GHPRDetailsActionsComponentFactory`). */
export function openedActions(
  role: ReviewRole,
  state: ReviewState,
  requestedReviewers: number,
  myState: GHPRReviewerState | null,
): OpenedActions {
  const none: OpenedActions = {
    requestReview: false,
    reRequestReview: false,
    submitReview: false,
    setMyselfAsReviewer: false,
    merge: false,
    more: [],
  };
  const accepted = state === "ACCEPTED";
  if (role === "AUTHOR")
    return {
      ...none,
      requestReview: state === "NEED_REVIEW" || (state === "WAIT_FOR_UPDATES" && requestedReviewers > 0),
      reRequestReview: state === "WAIT_FOR_UPDATES" && requestedReviewers === 0,
      merge: accepted,
      more: accepted ? ["requestReview", "close"] : ["mergeGroup", "close"],
    };
  if (role === "REVIEWER")
    return {
      ...none,
      submitReview: myState !== "APPROVED",
      merge: accepted && !isAwaitingReview(myState),
      more: accepted ? ["requestReview", "close"] : ["requestReview", "mergeGroup", "close"],
    };
  return { ...none, setMyselfAsReviewer: true, more: ["requestReview", "mergeGroup", "close"] };
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** The merge split button's main method (the first the repository allows) and the others in its menu. */
export function mergeButtonMethods(repo: { mergeCommitAllowed: boolean; squashMergeAllowed: boolean }): {
  main: MergeMethod;
  others: MergeMethod[];
} {
  const all: MergeMethod[] = ["merge", "squash", "rebase"];
  const main: MergeMethod = repo.mergeCommitAllowed ? "merge" : repo.squashMergeAllowed ? "squash" : "rebase";
  return { main, others: all.filter((m) => m !== main) };
}

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge…",
  squash: "Squash and Merge…",
  rebase: "Rebase",
};

/** Reviewers to add and remove to go from `current` to `chosen` (`CollectionDelta`). */
export function reviewersDelta(
  current: readonly GHPullRequestRequestedReviewer[],
  chosen: readonly GHPullRequestRequestedReviewer[],
): { added: GHPullRequestRequestedReviewer[]; removed: GHPullRequestRequestedReviewer[] } {
  const before = new Set(current.map(reviewerKey));
  const after = new Set(chosen.map(reviewerKey));
  return {
    added: dedupe(chosen).filter((r) => !before.has(reviewerKey(r))),
    removed: dedupe(current).filter((r) => !after.has(reviewerKey(r))),
  };
}

/** Reviewers without repeats (by login / team slug). */
export function dedupe(reviewers: readonly GHPullRequestRequestedReviewer[]): GHPullRequestRequestedReviewer[] {
  const seen = new Set<string>();
  return reviewers.filter((r) => {
    const k = reviewerKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `getPresentableName`: the name, else the login (teams: name, else `org/slug`). */
export function presentableName(r: GHPullRequestRequestedReviewer): string {
  if (isTeam(r)) return r.teamName || r.combinedSlug;
  return r.name || r.login;
}

// ---------------------------------------------------------------------------
// Status section

/** A status row's icon (`CIBuildStatusIcons` / `ReviewDetailsUIUtil`). */
export type StatusIcon = "success" | "failed" | "pending" | "failedInProgress" | "skipped" | "warning" | "error";

export const STATUS_ICON: Record<StatusIcon, string> = {
  success: "success",
  failed: "ci-failed",
  pending: "ci-pending",
  failedInProgress: "ci-failed-in-progress",
  skipped: "ci-skipped",
  warning: "warning",
  error: "error",
};

export const JOB_ICON: Record<CodeReviewCIJobState, StatusIcon> = {
  FAILED: "failed",
  PENDING: "pending",
  SKIPPED: "skipped",
  SUCCESS: "success",
};

/** The CI line (`calcPipelineIcon` / `calcPipelineText`); null without jobs. */
export function ciSummary(jobs: readonly CodeReviewCIJob[]): { icon: StatusIcon; text: string } | null {
  if (!jobs.length) return null;
  const failed = jobs.filter((j) => j.status === "FAILED").length;
  const pending = jobs.filter((j) => j.status === "PENDING").length;
  if (jobs.filter((j) => j.isRequired).every((j) => j.status === "SUCCESS"))
    return { icon: "success", text: "All required checks have passed" };
  if (pending && failed) return { icon: "failedInProgress", text: "Checks in progress, and some already failed…" };
  if (pending) return { icon: "pending", text: "Checks in progress…" };
  return { icon: "failed", text: "Checks failed" };
}

/** The access line (`createAccessDeniedLabel`); null when the user may do everything. */
export function accessDeniedText(
  permission: GHRepositoryPermissionLevel | null | undefined,
  viewerDidAuthor: boolean,
  isDraft: boolean,
  mergeForbidden = false,
): string | null {
  const canMerge = hasPermission(permission, "WRITE");
  const canClose = hasPermission(permission, "TRIAGE") || viewerDidAuthor;
  const canMarkReadyForReview = canMerge || viewerDidAuthor;
  if (!canClose) return "Repository access required to manage pull requests";
  if (!canMarkReadyForReview && isDraft) return "Repository write access required to merge pull requests";
  if (!canMerge && !isDraft) return "Repository write access required to merge pull requests";
  if (mergeForbidden && !isDraft) return "Merging is disabled for this project";
  return null;
}

/** A reviewer row's text (`GHPRReviewerStateUIUtil.getText`). */
export function reviewerStatusText(state: GHPRReviewerState, name: string): string {
  switch (state) {
    case "APPROVED":
      return tx`${name} approved review`;
    case "CHANGES_REQUESTED":
      return tx`${name} is waiting for updates`;
    case "NEEDS_REVIEW":
      return tx`Waiting for review from ${name}`;
    case "RE_REQUESTED":
      return tx`Re-requested review from ${name}`;
    case "COMMENTED":
      return tx`${name} left comments`;
  }
}

/** A reviewer row's status icon: approved, changes requested, awaiting (warning), commented (neutral comment). */
export function reviewerStatusIcon(state: GHPRReviewerState): string {
  if (state === "APPROVED") return "success";
  if (state === "CHANGES_REQUESTED") return "error";
  if (state === "COMMENTED") return "review-comment";
  return "warning";
}

/** Why Resolve cannot run (`GHPRResolveConflictsLocallyError`), or the remotes it merges between. */
export type ResolveConflicts =
  | { error: string }
  | { headRemote: string; baseRemote: string; headRefName: string; baseRefName: string };

/** The local git remote of `nameWithOwner` among the project's GitHub remotes. */
export function remoteOf(remotes: readonly GHRemote[], nameWithOwner: string | null | undefined): GHRemote | null {
  if (!nameWithOwner) return null;
  const key = nameWithOwner.toLowerCase();
  return remotes.find((r) => `${r.owner}/${r.name}`.toLowerCase() === key) ?? null;
}

/** `GHPRResolveConflictsLocallyViewModel.requestOrError`. */
export function resolveConflicts(input: {
  details: GHPullRequest | undefined;
  remotes: readonly GHRemote[];
  /** A merge or rebase is in progress in the repository. */
  mergeInProgress: boolean;
  /** The current branch tracks the head branch and contains the base commit. */
  alreadyResolvedLocally: boolean;
}): ResolveConflicts {
  const { details: pr, remotes } = input;
  if (input.mergeInProgress) return { error: "Merge is already in progress" };
  if (!pr) return { error: "Details have not finished loading" };
  if (!pr.headRepository) return { error: tx`${tx("Source")} repository not found` };
  if (!pr.baseRepository) return { error: tx`${tx("Target")} repository not found` };
  const head = remoteOf(remotes, pr.headRepository.nameWithOwner);
  if (!head) return { error: tx`${tx("Source")} remote not found: ${pr.headRepository.url}` };
  const base = remoteOf(remotes, pr.baseRepository.nameWithOwner);
  if (!base) return { error: tx`${tx("Target")} remote not found: ${pr.baseRepository.url}` };
  if (input.alreadyResolvedLocally) return { error: "Already resolved locally, push your changes to resolve" };
  return { headRemote: head.remote, baseRemote: base.remote, headRefName: pr.headRefName, baseRefName: pr.baseRefName };
}

// ---------------------------------------------------------------------------
// Branches

/** The head branch as the widget shows it: `owner:branch` for forks and when head and base names are equal. */
export function headBranchLabel(pr: Pick<GHPullRequest, "headRefName" | "baseRefName" | "headRepository">): string {
  const repo = pr.headRepository;
  if (repo && (repo.isFork || pr.baseRefName === pr.headRefName)) return `${repo.owner.login}:${pr.headRefName}`;
  return pr.headRefName;
}

/** The GitHub repository of a branch's upstream (`origin/feature` or a fetch URL), with its branch name. */
function upstreamOf(upstream: string, remotes: readonly GHRemote[]): { repo: string | null; branch: string } | null {
  const named = remotes
    .filter((r) => upstream.startsWith(`${r.remote}/`))
    .sort((a, b) => b.remote.length - a.remote.length)[0];
  if (named) return { repo: `${named.owner}/${named.name}`, branch: upstream.slice(named.remote.length + 1) };
  const slash = upstream.indexOf("/");
  return slash > 0 ? { repo: null, branch: upstream.slice(slash + 1) } : null;
}

/**
 * Whether the pull request's head branch is checked out (`testRemoteBranchCheckedOut`): the
 * current branch tracks the head repository's branch, or (gh's fork checkouts, which track
 * a URL) it is named like the head branch and sits on the head commit.
 */
export function isHeadCheckedOut(
  branch: Pick<BranchInfo, "head" | "headCommit" | "upstream"> | null,
  remotes: readonly GHRemote[],
  pr: Pick<GHPullRequest, "headRefName" | "headRefOid" | "headRepository">,
): boolean {
  if (!branch?.head) return false;
  const up = branch.upstream ? upstreamOf(branch.upstream, remotes) : null;
  if (up?.repo && pr.headRepository)
    return up.branch === pr.headRefName && up.repo.toLowerCase() === pr.headRepository.nameWithOwner.toLowerCase();
  const name = branch.head.slice(branch.head.lastIndexOf("/") + 1);
  return (name === pr.headRefName || branch.head === pr.headRefName) && branch.headCommit === pr.headRefOid;
}

// ---------------------------------------------------------------------------
// Commit picker

/** The bold label before the dropdown: "Changes" for one commit, else "Changes from". */
export const commitsTitle = (count: number) => (count === 1 ? "Changes" : "Changes from");

/** Index of the next (1) / previous (-1) commit, or null at either end or with all commits shown. */
export function stepCommit(selected: number, count: number, dir: 1 | -1): number | null {
  if (selected < 0) return null;
  const next = selected + dir;
  return next >= 0 && next < count ? next : null;
}

// ---------------------------------------------------------------------------
// Changes tree

/** `CodeReviewProgressTreeModel`'s node state: read (viewed) and the unresolved discussions. */
export interface ProgressState {
  isRead: boolean;
  discussions: number;
}

/** Unresolved review threads per path (`unresolvedThreadsCountByChange`). */
export function unresolvedThreadsByPath(threads: readonly GHPullRequestReviewThread[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of threads) if (!t.isResolved) out.set(t.path, (out.get(t.path) ?? 0) + 1);
  return out;
}

/** Only VIEWED counts as viewed (DISMISSED: changed since); a path without state counts as read. */
export const isViewed = (state: GHPullRequestFileViewedState | undefined) => state === undefined || state === "VIEWED";

/** A tree node's progress: a file's own, a folder's the sum of its files (read when all are). */
export function progressOf(
  node: FileTreeNode<GHCommitFile>,
  leaf: (file: GHCommitFile) => ProgressState,
): ProgressState {
  if (node.file) return leaf(node.file);
  let isRead = true;
  let discussions = 0;
  for (const c of node.children) {
    const s = progressOf(c, leaf);
    isRead &&= s.isRead;
    discussions += s.discussions;
  }
  return { isRead, discussions };
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The tree's roots: grouped by directory, or a flat list. */
export function changesTree(files: readonly GHCommitFile[], groupByDirectory: boolean): FileTreeNode<GHCommitFile>[] {
  if (groupByDirectory) return buildFileTree(files, (f) => f.filename);
  return [...files]
    .sort((a, b) => fileName(a.filename).localeCompare(fileName(b.filename)) || a.filename.localeCompare(b.filename))
    .map((f) => ({ key: `f:${f.filename}`, name: fileName(f.filename), file: f, children: [], count: 1 }));
}

/** Files of the selected nodes, folders contributing all theirs (`SELECTED_CHANGES`), in tree order. */
export function selectedFiles(roots: readonly FileTreeNode<GHCommitFile>[], keys: ReadonlySet<string>): GHCommitFile[] {
  const out: GHCommitFile[] = [];
  const seen = new Set<string>();
  const add = (n: FileTreeNode<GHCommitFile>) => {
    if (n.file) {
      if (!seen.has(n.file.filename)) out.push(n.file);
      seen.add(n.file.filename);
    } else n.children.forEach(add);
  };
  const walk = (ns: readonly FileTreeNode<GHCommitFile>[]) => {
    for (const n of ns) {
      if (keys.has(n.key)) add(n);
      else walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** The file's VCS status colour kind (`Change.getFileStatus`). */
export function changeKind(f: Pick<GHCommitFile, "status">): EffectiveKind {
  if (f.status === "added" || f.status === "copied") return "added";
  if (f.status === "removed") return "deleted";
  return "modified";
}

/** The viewed toggle's text (`GHPRViewedStateToggleAction`). */
export function viewedToggleText(count: number, allViewed: boolean): string {
  if (count === 1) return allViewed ? "Mark as Not Viewed" : "Mark as Viewed";
  return allViewed ? "Mark All as Not Viewed" : "Mark All as Viewed";
}
