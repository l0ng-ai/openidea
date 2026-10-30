/**
 * Pull request changes (IntelliJ's `GHPRDetailsDataProvider`, `GHPRReviewDataProvider`,
 * `GHPRViewedStateDataProvider`, `GHPRCommentsDataProvider` mutations). Each sends the
 * request, then refreshes what it changed — details, mergeability, timeline, threads,
 * pending review, the list row — so every view of the pull request follows. Errors
 * propagate to the caller, which shows them where IntelliJ does.
 */
import * as api from "../api/requests";
import type {
  GHDiffSide,
  GHPullRequestDraftReviewThread,
  GHPullRequestPendingReview,
  GHPullRequestRequestedReviewer,
  GHPullRequestReviewEvent,
  GHPullRequestReviewThread,
  GHPullRequestShort,
  GHReactionContent,
} from "../api/types";
import { reloadList, updateListItem } from "./list";
import { isTeam } from "./model";
import {
  loadPullRequestData,
  pullRequestId,
  reloadPullRequestData,
  reloadTimeline,
  setPullRequestData,
  updateTimeline,
} from "./pullRequest";
import { requireConnection } from "./repository";

const settle = (ps: Array<Promise<unknown>>) => Promise.allSettled(ps).then(() => undefined);

/** After a change of the pull request itself: details, mergeability and new timeline items. */
function refreshState(number: number) {
  return settle([
    reloadPullRequestData(number, "details"),
    reloadPullRequestData(number, "mergeability"),
    updateTimeline(number),
  ]);
}

/** After a review change: pending review, threads, details (reviews) and the timeline. */
function refreshReview(number: number) {
  return settle([
    reloadPullRequestData(number, "pendingReview"),
    reloadPullRequestData(number, "threads"),
    reloadPullRequestData(number, "details"),
    reloadTimeline(number),
  ]);
}

// ---------------------------------------------------------------------------
// Details

/**
 * Edits the title and / or description.
 * @public
 */
export async function updateDetails(number: number, patch: { title?: string; body?: string }) {
  const pr = await api.updatePullRequest(await pullRequestId(number), patch);
  setPullRequestData(number, "details", () => pr);
  updateListItem(pr);
  await updateTimeline(number);
  return pr;
}

/** Adds / removes requested reviewers (users and teams), as the reviewer picker's delta. */
export async function adjustReviewers(
  number: number,
  delta: { added: GHPullRequestRequestedReviewer[]; removed: GHPullRequestRequestedReviewer[] },
) {
  const split = (rs: GHPullRequestRequestedReviewer[]) => ({
    logins: rs.filter((r) => !isTeam(r)).map((r) => (r as { login: string }).login),
    teamSlugs: rs.filter(isTeam).map((t) => t.slug),
  });
  if (delta.removed.length) await api.changeRequestedReviewers(number, "DELETE", split(delta.removed));
  if (delta.added.length) await api.changeRequestedReviewers(number, "POST", split(delta.added));
  await refreshState(number);
}

/** "Close Pull Request". */
export async function closePullRequest(number: number) {
  await api.updatePullRequestState(number, "closed");
  await refreshState(number);
}

/** "Reopen Pull Request". */
export async function reopenPullRequest(number: number) {
  await api.updatePullRequestState(number, "open");
  await refreshState(number);
}

/** "Post Pull Request": marks a draft ready for review. */
export async function markReadyForReview(number: number) {
  await api.markPullRequestReadyForReview(await pullRequestId(number));
  await refreshState(number);
}

/** Merge… / Squash and Merge… (with the dialog's message) / Rebase, at head `headRefOid`. */
export async function mergePullRequest(
  number: number,
  method: "merge" | "squash" | "rebase",
  headRefOid: string,
  message?: { title: string; body: string },
) {
  await api.mergePullRequest(number, method, headRefOid, method === "rebase" ? undefined : message);
  await refreshState(number);
}

/** Deletes the merged head branch (the timeline's merged banner). */
export async function deleteMergedBranch(number: number, refId: string) {
  await api.deleteRef(refId);
  await settle([reloadPullRequestData(number, "details"), updateTimeline(number)]);
}

/**
 * Replaces the assignees (logins).
 * @public
 */
export async function setAssignees(number: number, logins: string[]) {
  await api.updateAssignees(number, logins);
  await settle([reloadPullRequestData(number, "details"), updateTimeline(number)]);
}

/**
 * Replaces the labels (names).
 * @public
 */
export async function setLabels(number: number, names: string[]) {
  await api.replaceLabels(number, names);
  await settle([reloadPullRequestData(number, "details"), updateTimeline(number)]);
}

// ---------------------------------------------------------------------------
// Viewed state

/**
 * Marks `paths` viewed / not viewed: the cache changes at once, one request per path runs
 * in parallel, and the state is reloaded when any fails.
 */
export async function setViewed(number: number, paths: readonly string[], viewed: boolean) {
  setPullRequestData(number, "viewedState", (v) => {
    const next = { ...v };
    for (const p of paths) next[p] = viewed ? "VIEWED" : "UNVIEWED";
    return next;
  });
  const id = await pullRequestId(number);
  const results = await Promise.allSettled(
    paths.map((p) => (viewed ? api.markFileAsViewed(id, p) : api.unmarkFileAsViewed(id, p))),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    await reloadPullRequestData(number, "viewedState").catch(() => undefined);
    throw failed.reason;
  }
}

// ---------------------------------------------------------------------------
// Reviews

/**
 * `createReview`: a pending review (no `event`), or a submitted one; `threads` are the
 * new comments ("Start Review" / "Add Single Comment" with `event: "COMMENT"`).
 */
export async function createReview(
  number: number,
  input: {
    event?: GHPullRequestReviewEvent;
    body?: string;
    commitOid?: string;
    threads?: GHPullRequestDraftReviewThread[];
  } = {},
): Promise<GHPullRequestPendingReview> {
  const review = await api.createReview({ pullRequestId: await pullRequestId(number), ...input });
  await refreshReview(number);
  return review;
}

/** Submits the pending review `reviewId`. */
export async function submitReview(number: number, reviewId: string, event: GHPullRequestReviewEvent, body?: string) {
  await api.submitReview(reviewId, event, body || null);
  await refreshReview(number);
  await reloadPullRequestData(number, "mergeability").catch(() => undefined);
}

/** Submit Review popup: submits the pending review, or creates a submitted one. */
export async function submitOrCreateReview(number: number, event: GHPullRequestReviewEvent, body: string) {
  const pending = await loadPullRequestData(number, "pendingReview");
  if (pending) await submitReview(number, pending.id, event, body);
  else await createReview(number, { event, body: body || undefined });
}

/** Discards a pending review with its comments. */
export async function deleteReview(number: number, reviewId: string) {
  await api.deleteReview(reviewId);
  await refreshReview(number);
}

/**
 * Edits a review's body; resolves with the new body.
 * @public
 */
export async function updateReviewBody(number: number, reviewId: string, body: string) {
  const review = await api.updateReview(reviewId, body);
  await reloadTimeline(number);
  return review.body;
}

/** Replaces one thread in the cache (resolve / unresolve / new thread) and refreshes the list counter. */
function putThread(number: number, thread: GHPullRequestReviewThread) {
  setPullRequestData(number, "threads", (ts) => {
    const list = ts ?? [];
    return list.some((t) => t.id === thread.id)
      ? list.map((t) => (t.id === thread.id ? thread : t))
      : [...list, thread];
  });
}

/**
 * A new thread in the pending review `reviewId` (lines are 1-based, both ends on one side).
 * @public
 */
export async function createThread(
  number: number,
  input: {
    reviewId: string;
    body: string;
    path: string;
    line: number;
    side: GHDiffSide;
    startLine?: number;
    startSide?: GHDiffSide;
  },
) {
  const thread = await api.addReviewThread({
    pullRequestReviewId: input.reviewId,
    body: input.body,
    path: input.path,
    line: input.line,
    side: input.side,
    startLine: input.startLine ?? null,
    startSide: input.startSide ?? null,
  });
  putThread(number, thread);
  await settle([reloadPullRequestData(number, "pendingReview"), reloadTimeline(number)]);
  return thread;
}

/**
 * A comment on a single commit's diff (`position` in its patch) in the pending review `reviewId`.
 * @public
 */
export async function addCommitComment(
  number: number,
  input: { reviewId: string; body: string; commitSha: string; path: string; position: number },
) {
  const comment = await api.addReviewComment({
    reviewId: input.reviewId,
    body: input.body,
    commit: input.commitSha,
    file: input.path,
    position: input.position,
  });
  await refreshReview(number);
  return comment;
}

/**
 * Replies to the review comment `replyToCommentId` (in the pending review, else a new one).
 * @public
 */
export async function replyToComment(number: number, replyToCommentId: string, body: string) {
  const pending = await loadPullRequestData(number, "pendingReview");
  const reviewId = pending?.id ?? (await api.createReview({ pullRequestId: await pullRequestId(number) })).id;
  const comment = await api.addReviewComment({ reviewId, body, inReplyTo: replyToCommentId });
  // A reply outside a review is posted at once, like GitHub's "Reply".
  if (!pending) await api.submitReview(reviewId, "COMMENT", null);
  await refreshReview(number);
  return comment;
}

/**
 * Edits a review comment.
 * @public
 */
export async function updateReviewComment(number: number, commentId: string, body: string) {
  const comment = await api.updateReviewComment(commentId, body);
  await settle([reloadPullRequestData(number, "threads"), reloadTimeline(number)]);
  return comment;
}

/**
 * Deletes a review comment (its thread goes with its last comment).
 * @public
 */
export async function deleteReviewComment(number: number, commentId: string) {
  await api.deleteReviewComment(commentId);
  await refreshReview(number);
}

/**
 * Resolve: marks a review thread resolved.
 * @public
 */
export async function resolveThread(number: number, threadId: string) {
  const thread = await api.resolveReviewThread(threadId);
  putThread(number, thread);
  await settle([reloadPullRequestData(number, "details"), reloadTimeline(number)]);
  return thread;
}

/**
 * Unresolve: reopens a review thread.
 * @public
 */
export async function unresolveThread(number: number, threadId: string) {
  const thread = await api.unresolveReviewThread(threadId);
  putThread(number, thread);
  await settle([reloadPullRequestData(number, "details"), reloadTimeline(number)]);
  return thread;
}

// ---------------------------------------------------------------------------
// Conversation comments and reactions

/**
 * Adds a conversation comment (the timeline's composer).
 * @public
 */
export async function addIssueComment(number: number, body: string) {
  await api.createIssueComment(number, body);
  await updateTimeline(number);
}

/**
 * Edits a conversation comment.
 * @public
 */
export async function updateIssueComment(number: number, commentId: string, body: string) {
  const comment = await api.updateIssueComment(commentId, body);
  await reloadTimeline(number);
  return comment;
}

/**
 * Deletes a conversation comment.
 * @public
 */
export async function deleteIssueComment(number: number, commentId: string) {
  await api.deleteIssueComment(commentId);
  await reloadTimeline(number);
}

/**
 * Adds or removes the viewer's reaction on `subjectId` (the description, a comment, a
 * review comment); `on` says which data holds the subject, to refresh it.
 * @public
 */
export async function toggleReaction(
  number: number,
  subjectId: string,
  reaction: GHReactionContent,
  add: boolean,
  on: "details" | "timeline" | "threads",
) {
  if (add) await api.addReaction(subjectId, reaction);
  else await api.removeReaction(subjectId, reaction);
  if (on === "timeline") await reloadTimeline(number);
  else await reloadPullRequestData(number, on);
}

// ---------------------------------------------------------------------------
// New pull requests

/**
 * Creates a pull request in the connected repository (`GHPRCreationService`): `head` is
 * the branch (`owner:branch` for a fork's). A blank title falls back to the branch name,
 * a blank body is sent as null. Reviewers, assignees and labels are set afterwards.
 * @public
 */
export async function createPullRequest(input: {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  reviewers?: GHPullRequestRequestedReviewer[];
  assignees?: string[];
  labels?: string[];
}): Promise<GHPullRequestShort> {
  const { repository } = requireConnection();
  const branch = input.head.slice(input.head.indexOf(":") + 1);
  const pr = await api.createPullRequest({
    repositoryId: repository.id,
    baseRefName: input.base,
    headRefName: input.head,
    title: input.title.trim() || branch,
    body: input.body.trim() ? input.body : null,
    draft: input.draft,
  });
  const n = pr.number;
  await settle([
    ...(input.reviewers?.length ? [adjustReviewers(n, { added: input.reviewers, removed: [] })] : []),
    ...(input.assignees?.length ? [api.updateAssignees(n, input.assignees)] : []),
    ...(input.labels?.length ? [api.replaceLabels(n, input.labels)] : []),
  ]);
  void reloadList();
  return pr;
}
