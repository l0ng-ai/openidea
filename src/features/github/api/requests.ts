/**
 * Typed GitHub requests, one per IntelliJ `GHGQLRequests` / `GithubApiRequests` call the
 * plugin makes. Everything addresses the connected repository (`client.ts`) unless a
 * repository is passed. Mutations only send; `data/operations.ts` refreshes what they
 * change.
 */
import { graphql, repoPath, repoVariables, rest } from "./client";
import * as Q from "./queries";
import type {
  GHCollaborator,
  GHCommitFile,
  GHCommitStatusRollupContext,
  GHConnection,
  GHDiffSide,
  GHComment,
  GHLabel,
  GHPRTimelineItem,
  GHPullRequest,
  GHPullRequestBranchMatch,
  GHPullRequestChangedFile,
  GHPullRequestCommit,
  GHPullRequestDraftReviewThread,
  GHPullRequestMergeabilityData,
  GHPullRequestPendingReview,
  GHPullRequestReview,
  GHPullRequestReviewComment,
  GHPullRequestReviewEvent,
  GHPullRequestReviewThread,
  GHPullRequestShort,
  GHReaction,
  GHReactionContent,
  GHRepository,
  GHRepositoryCoordinates,
  GHRepositoryPullRequestTemplate,
  GHTeam,
  GHUser,
} from "./types";

/** IntelliJ's `PR_PAGE_SIZE`: list rows per `issueSearch` page. */
export const PR_PAGE_SIZE = 50;

type Pr = { repository: { pullRequest: Record<string, unknown> | null } | null };

/** `repository.pullRequest.<field>` of a pull request document, or null when the PR is gone. */
async function prField<T>(doc: string, number: number, field: string, vars: Record<string, unknown> = {}) {
  const data = await graphql<Pr>(doc, { ...repoVariables(), number, ...vars });
  return (data.repository?.pullRequest?.[field] as T | undefined) ?? null;
}

/** Every page of a cursor-paged connection, in order. */
export async function allPages<T>(page: (cursor: string | null) => Promise<GHConnection<T> | null>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const c: GHConnection<T> | null = await page(cursor);
    if (!c) return out;
    out.push(...c.nodes);
    if (!c.pageInfo.hasNextPage || !c.pageInfo.endCursor) return out;
    cursor = c.pageInfo.endCursor;
  }
}

// ---------------------------------------------------------------------------
// Repository and users

export async function findRepository(repo: GHRepositoryCoordinates): Promise<GHRepository | null> {
  const data = await graphql<{ repository: GHRepository | null }>(Q.findRepository, repoVariables(repo));
  return data.repository;
}

/**
 * A user by login (`findUser`).
 * @public
 */
export async function findUser(login: string): Promise<GHUser | null> {
  return (await graphql<{ user: GHUser | null }>(Q.findUser, { login })).user;
}

interface RestUser {
  login: string;
  node_id: string;
  avatar_url: string;
  html_url: string;
  name?: string | null;
  type?: string;
}

/** A REST user as the GraphQL `user` fragment shape. */
export function restUser(u: RestUser): GHUser {
  return {
    __typename: "User",
    id: u.node_id,
    login: u.login,
    url: u.html_url,
    avatarUrl: u.avatar_url,
    name: u.name ?? null,
  };
}

/** The signed-in user (REST `user`, IntelliJ's `CurrentUser.get`). */
export async function currentUser(): Promise<GHUser> {
  return restUser(await rest<RestUser>("GET", "user"));
}

/** Page `page` (1-based) of a REST list; `next` is null on the last page. */
async function restPage<T, R>(endpoint: string, page: number, map: (r: R) => T) {
  const sep = endpoint.includes("?") ? "&" : "?";
  const items = (await rest<R[] | null>("GET", `${endpoint}${sep}per_page=100&page=${page}`)) ?? [];
  return { items: items.map(map), next: items.length === 100 ? page + 1 : null };
}

export function collaboratorsPage(page: number) {
  return restPage<GHCollaborator, RestUser & { permissions?: GHCollaborator["permissions"] }>(
    `${repoPath()}/collaborators`,
    page,
    (u) => ({
      ...restUser(u),
      permissions: u.permissions ?? { admin: false, maintain: false, push: false, triage: false, pull: true },
    }),
  );
}

export function contributorsPage(page: number) {
  return restPage<GHUser, RestUser>(`${repoPath()}/contributors`, page, restUser);
}

/** Users issues and pull requests can be assigned to. */
export function assigneesPage(page: number) {
  return restPage<GHUser, RestUser>(`${repoPath()}/assignees`, page, restUser);
}

interface RestLabel {
  node_id: string;
  url: string;
  name: string;
  color: string;
}

const restLabel = (l: RestLabel): GHLabel => ({ id: l.node_id, url: l.url, name: l.name, color: l.color });

export function labelsPage(page: number) {
  return restPage<GHLabel, RestLabel>(`${repoPath()}/labels`, page, restLabel);
}

export async function mentionableUsersPage(cursor: string | null): Promise<GHConnection<GHUser> | null> {
  const data = await graphql<{ repository: { mentionableUsers: GHConnection<GHUser> } | null }>(
    Q.findMentionableUsers,
    { ...repoVariables(), cursor },
  );
  return data.repository?.mentionableUsers ?? null;
}

export async function organizationTeamsPage(organization: string, cursor: string | null) {
  const data = await graphql<{ organization: { teams: GHConnection<GHTeam> } | null }>(Q.findOrganizationTeams, {
    organization,
    cursor,
  });
  return data.organization?.teams ?? null;
}

/**
 * A page of the branch protection rules (`getProtectionRules`).
 * @public
 */
export async function protectionRulesPage(cursor: string | null) {
  const data = await graphql<{
    repository: { branchProtectionRules: GHConnection<{ id: string; pattern: string }> } | null;
  }>(Q.getProtectionRules, { ...repoVariables(), cursor });
  return data.repository?.branchProtectionRules ?? null;
}

export async function pullRequestTemplates(): Promise<GHRepositoryPullRequestTemplate[]> {
  const data = await graphql<{ repository: { pullRequestTemplates: GHRepositoryPullRequestTemplate[] | null } | null }>(
    Q.getPullRequestTemplates,
    repoVariables(),
  );
  return data.repository?.pullRequestTemplates ?? [];
}

/**
 * A page of the commit's status check rollup (`getRepositoryCommitStatusContexts`).
 * @public
 */
export async function commitStatusContextsPage(oid: string, cursor: string | null, pageSize = 100) {
  const data = await graphql<{
    repository: {
      object: { statusCheckRollup: { contexts: GHConnection<GHCommitStatusRollupContext> } | null } | null;
    };
  }>(Q.getRepositoryCommitStatusContexts, { ...repoVariables(), oid, pageSize, cursor });
  return data.repository.object?.statusCheckRollup?.contexts ?? null;
}

/**
 * The commit's overall status check state (`getRepositoryCommitStatusShort`).
 * @public
 */
export async function commitStatusShort(oid: string): Promise<string | null> {
  const data = await graphql<{ repository: { object: { statusCheckRollup: { state: string } | null } | null } }>(
    Q.getRepositoryCommitStatusShort,
    { ...repoVariables(), oid },
  );
  return data.repository.object?.statusCheckRollup?.state ?? null;
}

/**
 * The counts of IntelliJ's usage metrics, by query (each a full search string).
 * @public
 */
export async function metrics(queries: {
  allPRCountQuery: string;
  openPRCountQuery: string;
  openAuthoredPRCountQuery: string;
  openAssigneePRCountQuery: string;
  openReviewedPRCountQuery: string;
  openReviewAssignedPRCountQuery: string;
}): Promise<Record<string, number>> {
  const data = await graphql<Record<string, { issueCount: number }>>(Q.metrics, queries);
  return Object.fromEntries(
    Object.entries(data)
      .filter(([k]) => k !== "rateLimit")
      .map(([k, v]) => [k, v.issueCount]),
  );
}

// ---------------------------------------------------------------------------
// Pull request queries

/** One `issueSearch` page: `query` is the full search string (`type:pr repo:o/r …`). */
export async function searchPullRequests(query: string, cursor: string | null, pageSize = PR_PAGE_SIZE) {
  const data = await graphql<{ search: GHConnection<GHPullRequestShort | Record<string, never>> }>(Q.issueSearch, {
    query,
    pageSize,
    cursor,
  });
  // `type: ISSUE` may return issues (no fields selected for them: empty objects).
  const nodes = data.search.nodes.filter((n): n is GHPullRequestShort => "number" in n);
  return { pageInfo: data.search.pageInfo, nodes };
}

/**
 * Open pull requests whose head matches the `head:` terms of `query` (`findPullRequestsByHeadBranch`).
 * @public
 */
export async function searchPullRequestsByHeadBranches(query: string, pageSize = 100) {
  const data = await graphql<{ search: GHConnection<GHPullRequestBranchMatch> }>(Q.findPullRequestsByHeadBranch, {
    query,
    pageSize,
  });
  return data.search.nodes.filter((n) => "number" in n);
}

export async function findPullRequest(number: number): Promise<GHPullRequest | null> {
  const data = await graphql<{ repository: { pullRequest: GHPullRequest | null } | null }>(Q.findPullRequest, {
    ...repoVariables(),
    number,
  });
  return data.repository?.pullRequest ?? null;
}

export async function findPullRequestId(number: number): Promise<string | null> {
  return prField<string>(Q.findPullRequestId, number, "id");
}

export async function findPullRequestMergeability(number: number): Promise<GHPullRequestMergeabilityData | null> {
  const data = await graphql<{ repository: { pullRequest: GHPullRequestMergeabilityData | null } | null }>(
    Q.findPullRequestMergeability,
    { ...repoVariables(), number },
  );
  return data.repository?.pullRequest ?? null;
}

export function pullRequestCommitsPage(number: number, cursor: string | null) {
  return prField<GHConnection<GHPullRequestCommit>>(Q.pullRequestCommits, number, "commits", { cursor });
}

export function pullRequestFilesPage(number: number, cursor: string | null) {
  return prField<GHConnection<GHPullRequestChangedFile>>(Q.pullRequestFiles, number, "files", { cursor });
}

export function pullRequestParticipantsPage(number: number, cursor: string | null) {
  return prField<GHConnection<GHUser>>(Q.pullRequestParticipants, number, "participants", { cursor });
}

export function pullRequestReviewThreadsPage(number: number, cursor: string | null) {
  return prField<GHConnection<GHPullRequestReviewThread>>(Q.pullRequestReviewThreads, number, "reviewThreads", {
    cursor,
  });
}

/** Timeline item types IntelliJ drops (`GHPRTimelineItem.IGNORED_TYPES`). */
const IGNORED_TIMELINE_TYPES = new Set([
  "ReferencedEvent",
  "MentionedEvent",
  "CommentDeletedEvent",
  "LockedEvent",
  "UnlockedEvent",
  "SubscribedEvent",
  "UnsubscribedEvent",
]);

/** Item types the timeline document selects fields for. */
const TIMELINE_TYPES = new Set([
  "PullRequestCommit",
  "PullRequestReview",
  "IssueComment",
  "RenamedTitleEvent",
  "ClosedEvent",
  "ReopenedEvent",
  "MergedEvent",
  "AssignedEvent",
  "UnassignedEvent",
  "LabeledEvent",
  "UnlabeledEvent",
  "ReviewRequestedEvent",
  "ReviewRequestRemovedEvent",
  "ReviewDismissedEvent",
  "ReadyForReviewEvent",
  "ConvertToDraftEvent",
  "BaseRefChangedEvent",
  "BaseRefForcePushedEvent",
  "HeadRefForcePushedEvent",
  "HeadRefDeletedEvent",
  "HeadRefRestoredEvent",
  "CrossReferencedEvent",
  "ConnectedEvent",
  "DisconnectedEvent",
]);

/** Timeline nodes as items: ignored types dropped, others IntelliJ can't show marked `Unknown`. */
export function timelineItems(nodes: ReadonlyArray<{ __typename: string }>): GHPRTimelineItem[] {
  return nodes.flatMap((n): GHPRTimelineItem[] => {
    if (IGNORED_TIMELINE_TYPES.has(n.__typename)) return [];
    if (TIMELINE_TYPES.has(n.__typename)) return [n as GHPRTimelineItem];
    return [{ __typename: "Unknown", type: n.__typename }];
  });
}

/** One page (100) of timeline items, after `cursor`. */
export async function pullRequestTimelinePage(number: number, cursor: string | null, since?: string) {
  const c = await prField<GHConnection<{ __typename: string }>>(Q.pullRequestTimeline, number, "timelineItems", {
    cursor,
    since,
  });
  return c && { pageInfo: c.pageInfo, nodes: timelineItems(c.nodes) };
}

interface PendingReviewNode {
  id: string;
  state: GHPullRequestPendingReview["state"];
  comments: { totalCount: number };
}

const pendingReview = (r: PendingReviewNode): GHPullRequestPendingReview => ({
  id: r.id,
  state: r.state,
  commentsCount: r.comments.totalCount,
});

/** The viewer's pending (not yet submitted) review of the pull request with node id `pullRequestId`. */
export async function findPendingReview(pullRequestId: string): Promise<GHPullRequestPendingReview | null> {
  const data = await graphql<{ node: { reviews?: { nodes: PendingReviewNode[] } } | null }>(Q.findPendingReview, {
    pullRequestId,
  });
  const r = data.node?.reviews?.nodes[0];
  return r ? pendingReview(r) : null;
}

interface RestCommitFile {
  sha: string | null;
  filename: string;
  status: GHCommitFile["status"];
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

const commitFile = (f: RestCommitFile): GHCommitFile => ({
  sha: f.sha,
  filename: f.filename,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  changes: f.changes,
  patch: f.patch ?? null,
  previousFilename: f.previous_filename ?? null,
});

/** The pull request's changed files (REST `pulls/{n}/files`, every page). */
export async function pullRequestChangedFiles(number: number): Promise<GHCommitFile[]> {
  const files = await rest<RestCommitFile[]>("GET", `${repoPath()}/pulls/${number}/files?per_page=100`, undefined, {
    paginate: true,
  });
  return (files ?? []).map(commitFile);
}

/**
 * The files a commit changes (REST `commits/{sha}`).
 * @public
 */
export async function commitChangedFiles(sha: string): Promise<GHCommitFile[]> {
  const commit = await rest<{ files?: RestCommitFile[] }>("GET", `${repoPath()}/commits/${sha}`);
  return (commit?.files ?? []).map(commitFile);
}

/**
 * Open pull requests from `head` (`owner:branch`) into `base`, REST `Repos.PullRequests.find`.
 */
export async function findOpenPullRequestsByHead(
  head: string,
  base?: string,
): Promise<Array<{ number: number; html_url: string }>> {
  const q = new URLSearchParams({ state: "open", head, ...(base ? { base } : {}), per_page: "1" });
  return (await rest<Array<{ number: number; html_url: string }>>("GET", `${repoPath()}/pulls?${q}`)) ?? [];
}

// ---------------------------------------------------------------------------
// Pull request mutations (GraphQL)

export async function createPullRequest(input: {
  repositoryId: string;
  baseRefName: string;
  /** `owner:branch` for a branch of a fork. */
  headRefName: string;
  title: string;
  body: string | null;
  draft: boolean;
}): Promise<GHPullRequestShort> {
  const data = await graphql<{ createPullRequest: { pullRequest: GHPullRequestShort } }>(Q.createPullRequest, input);
  return data.createPullRequest.pullRequest;
}

export async function updatePullRequest(pullRequestId: string, patch: { title?: string; body?: string }) {
  const data = await graphql<{ updatePullRequest: { pullRequest: GHPullRequest } }>(Q.updatePullRequest, {
    pullRequestId,
    ...patch,
  });
  return data.updatePullRequest.pullRequest;
}

export async function markPullRequestReadyForReview(pullRequestId: string): Promise<void> {
  await graphql(Q.markPullRequestReadyForReview, { pullRequestId });
}

export async function markFileAsViewed(pullRequestId: string, path: string): Promise<void> {
  await graphql(Q.markFileAsViewed, { pullRequestId, path });
}

export async function unmarkFileAsViewed(pullRequestId: string, path: string): Promise<void> {
  await graphql(Q.unmarkFileAsViewed, { pullRequestId, path });
}

export async function deleteRef(refId: string): Promise<void> {
  await graphql(Q.deleteRef, { refId });
}

/** `addPullRequestReview`: a pending review without `event`, else a submitted one. */
export async function createReview(input: {
  pullRequestId: string;
  event?: GHPullRequestReviewEvent | null;
  body?: string | null;
  commitOid?: string | null;
  threads?: GHPullRequestDraftReviewThread[] | null;
}): Promise<GHPullRequestPendingReview> {
  const data = await graphql<{ addPullRequestReview: { pullRequestReview: PendingReviewNode } }>(Q.createReview, input);
  return pendingReview(data.addPullRequestReview.pullRequestReview);
}

export async function submitReview(reviewId: string, event: GHPullRequestReviewEvent, body?: string | null) {
  await graphql(Q.submitReview, { reviewId, event, body });
}

export async function deleteReview(reviewId: string): Promise<void> {
  await graphql(Q.deleteReview, { reviewId });
}

export async function updateReview(reviewId: string, body: string): Promise<GHPullRequestReview> {
  const data = await graphql<{ updatePullRequestReview: { pullRequestReview: GHPullRequestReview } }>(Q.updateReview, {
    reviewId,
    body,
  });
  return data.updatePullRequestReview.pullRequestReview;
}

/** `addPullRequestReviewComment`: a reply (`inReplyTo`), or a comment on a commit position. */
export async function addReviewComment(input: {
  reviewId: string;
  body: string;
  commit?: string | null;
  file?: string | null;
  position?: number | null;
  inReplyTo?: string | null;
}): Promise<GHPullRequestReviewComment> {
  const data = await graphql<{ addPullRequestReviewComment: { comment: GHPullRequestReviewComment } }>(
    Q.addReviewComment,
    input,
  );
  return data.addPullRequestReviewComment.comment;
}

export async function updateReviewComment(id: string, body: string): Promise<GHPullRequestReviewComment> {
  const data = await graphql<{
    updatePullRequestReviewComment: { pullRequestReviewComment: GHPullRequestReviewComment };
  }>(Q.updateReviewComment, { id, body });
  return data.updatePullRequestReviewComment.pullRequestReviewComment;
}

/** Deletes a review comment; returns its (pending) review, when it still exists. */
export async function deleteReviewComment(id: string): Promise<GHPullRequestPendingReview | null> {
  const data = await graphql<{ deletePullRequestReviewComment: { pullRequestReview: PendingReviewNode | null } }>(
    Q.deleteReviewComment,
    { id },
  );
  const r = data.deletePullRequestReviewComment.pullRequestReview;
  return r ? pendingReview(r) : null;
}

export async function addReviewThread(input: {
  pullRequestReviewId: string;
  body: string;
  path: string;
  line: number;
  side: GHDiffSide;
  startLine?: number | null;
  startSide?: GHDiffSide | null;
}): Promise<GHPullRequestReviewThread> {
  const data = await graphql<{ addPullRequestReviewThread: { thread: GHPullRequestReviewThread } }>(
    Q.addPullRequestReviewThread,
    input,
  );
  return data.addPullRequestReviewThread.thread;
}

export async function resolveReviewThread(threadId: string): Promise<GHPullRequestReviewThread> {
  const data = await graphql<{ resolveReviewThread: { thread: GHPullRequestReviewThread } }>(Q.resolveReviewThread, {
    threadId,
  });
  return data.resolveReviewThread.thread;
}

export async function unresolveReviewThread(threadId: string): Promise<GHPullRequestReviewThread> {
  const data = await graphql<{ unresolveReviewThread: { thread: GHPullRequestReviewThread } }>(
    Q.unresolveReviewThread,
    { threadId },
  );
  return data.unresolveReviewThread.thread;
}

export async function updateIssueComment(id: string, body: string): Promise<GHComment> {
  const data = await graphql<{ updateIssueComment: { issueComment: GHComment } }>(Q.updateIssueComment, { id, body });
  return data.updateIssueComment.issueComment;
}

export async function deleteIssueComment(id: string): Promise<void> {
  await graphql(Q.deleteIssueComment, { id });
}

export async function addReaction(id: string, reaction: GHReactionContent): Promise<GHReaction> {
  const data = await graphql<{ addReaction: { reaction: GHReaction } }>(Q.addReaction, { id, reaction });
  return data.addReaction.reaction;
}

export async function removeReaction(id: string, reaction: GHReactionContent): Promise<GHReaction> {
  const data = await graphql<{ removeReaction: { reaction: GHReaction } }>(Q.removeReaction, { id, reaction });
  return data.removeReaction.reaction;
}

// ---------------------------------------------------------------------------
// Pull request mutations (REST)

/** Adds (`POST`) or removes (`DELETE`) requested reviewers: user logins and team slugs. */
export async function changeRequestedReviewers(
  number: number,
  method: "POST" | "DELETE",
  reviewers: { logins: string[]; teamSlugs: string[] },
): Promise<void> {
  await rest(method, `${repoPath()}/pulls/${number}/requested_reviewers`, {
    reviewers: reviewers.logins,
    team_reviewers: reviewers.teamSlugs,
  });
}

/** Closes or reopens (`PullRequests.update(state)`). */
export async function updatePullRequestState(number: number, state: "open" | "closed"): Promise<void> {
  await rest("PATCH", `${repoPath()}/pulls/${number}`, { state });
}

/** `PUT pulls/{n}/merge` at head `sha` (rebase takes no message). */
export async function mergePullRequest(
  number: number,
  method: "merge" | "squash" | "rebase",
  sha: string,
  message?: { title: string; body: string },
): Promise<void> {
  await rest("PUT", `${repoPath()}/pulls/${number}/merge`, {
    merge_method: method,
    sha,
    ...(message ? { commit_title: message.title, commit_message: message.body } : {}),
  });
}

/** Adds a conversation comment (`Issues.Comments.create`). */
export async function createIssueComment(number: number, body: string): Promise<void> {
  await rest("POST", `${repoPath()}/issues/${number}/comments`, { body });
}

/** Replaces the assignees (`Issues.updateAssignees`). */
export async function updateAssignees(number: number, logins: string[]): Promise<void> {
  await rest("PATCH", `${repoPath()}/issues/${number}`, { assignees: logins });
}

/** Replaces the labels (`Issues.Labels.replace`). */
export async function replaceLabels(number: number, names: string[]): Promise<void> {
  await rest("PUT", `${repoPath()}/issues/${number}/labels`, { labels: names });
}
