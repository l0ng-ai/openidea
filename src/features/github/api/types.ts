/**
 * Shapes of the GitHub data the documents in `queries.ts` return, named after IntelliJ's
 * DTOs (`GHPullRequestShort`, `GHPullRequest`, …). GraphQL connections keep their
 * `nodes`; `data/model.ts` derives what the UI shows (reviewer states, unread, counters).
 * REST results are mapped to the same shapes (`GHUser`, `GHLabel`) where IntelliJ does.
 */

// ---------------------------------------------------------------------------
// Common

/** `pageInfo` fragment. */
export interface GHPageInfo {
  startCursor: string | null;
  hasPreviousPage: boolean;
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface GHConnection<T> {
  pageInfo: GHPageInfo;
  nodes: T[];
}

export interface GHNodes<T> {
  nodes: T[];
}

/** `actorInfo`: what every actor has. `name` comes with users, organizations and enterprise accounts. */
export interface GHActor {
  __typename: "User" | "Bot" | "Organization" | "EnterpriseUserAccount" | "Mannequin" | (string & {});
  id: string;
  login: string;
  url: string;
  avatarUrl: string;
  name?: string | null;
}

/** `user` fragment. */
export interface GHUser extends GHActor {
  __typename: "User";
  name: string | null;
}

/** `teamInfo` fragment (aliased `teamAvatarUrl`, `teamName`). */
export interface GHTeam {
  __typename: "Team";
  id: string;
  slug: string;
  url: string;
  teamAvatarUrl: string | null;
  teamName: string;
  /** `org/slug`. */
  combinedSlug: string;
}

/** `pullRequestReviewer`: a user, a team or (GitHub Apps) another actor. */
export type GHPullRequestRequestedReviewer = GHUser | GHTeam | GHActor;

/** `labelInfo` fragment. `color` is hex without `#`. */
export interface GHLabel {
  id: string;
  url: string;
  name: string;
  color: string;
}

export type GHReactionContent =
  | "THUMBS_UP"
  | "THUMBS_DOWN"
  | "LAUGH"
  | "HOORAY"
  | "CONFUSED"
  | "HEART"
  | "ROCKET"
  | "EYES";

export interface GHReaction {
  content: GHReactionContent;
  user: GHUser | null;
}

/** `reactions` fragment (first 25). */
export interface GHReactable {
  reactions: GHConnection<GHReaction>;
}

/** `gitActorInfo`: commit author / committer. */
export interface GHGitActor {
  name: string | null;
  email: string | null;
  avatarUrl: string;
  date: string | null;
  user: GHUser | null;
}

/** `commitHash` fragment. */
export interface GHCommitHash {
  id: string;
  oid: string;
  abbreviatedOid: string;
}

/** `commitShort` fragment. */
export interface GHCommitShort extends GHCommitHash {
  url: string;
  messageHeadline: string;
  author: GHGitActor | null;
}

/** `commit` fragment. */
export interface GHCommit extends GHCommitShort {
  committer: GHGitActor | null;
  messageBody: string;
  committedDate: string;
  parents: GHNodes<GHCommitHash>;
}

/** `pullRequestCommits` node. */
export interface GHPullRequestCommit {
  id: string;
  commit: GHCommit;
  url: string;
}

// ---------------------------------------------------------------------------
// Repository

export type GHRepositoryPermissionLevel = "READ" | "TRIAGE" | "WRITE" | "MAINTAIN" | "ADMIN";

/** `repository` fragment. */
export interface GHRepository {
  id: string;
  owner: { __typename: "User" | "Organization" | (string & {}); id: string; login: string };
  nameWithOwner: string;
  viewerPermission: GHRepositoryPermissionLevel | null;
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  defaultBranchRef: { name: string } | null;
  isFork: boolean;
  url: string;
  sshUrl: string;
}

/** Where a request goes: `owner/name` on github.com. */
export interface GHRepositoryCoordinates {
  owner: string;
  name: string;
}

/** REST collaborator (`repos/{o}/{r}/collaborators`) mapped to a user, with its permissions. */
export interface GHCollaborator extends GHUser {
  permissions: { admin: boolean; maintain: boolean; push: boolean; triage: boolean; pull: boolean };
}

/** `pullRequestTemplate` fragment. */
export interface GHRepositoryPullRequestTemplate {
  body: string | null;
}

// ---------------------------------------------------------------------------
// Pull requests

export type GHPullRequestState = "OPEN" | "CLOSED" | "MERGED";
export type GHPullRequestMergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type GHPullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
export type GHPullRequestReviewState = "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
export type GHPullRequestReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES" | "DISMISS";
export type GHPullRequestMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

/** `pullRequestReview` fragment. */
export interface GHPullRequestReview {
  __typename: "PullRequestReview";
  id: string;
  url: string;
  author: GHActor | null;
  body: string;
  state: GHPullRequestReviewState;
  createdAt: string;
  viewerCanUpdate: boolean;
}

/** `pullRequestInfoShort` fragment: a list row (`issueSearch`). */
export interface GHPullRequestShort extends GHReactable {
  id: string;
  url: string;
  number: number;
  title: string;
  state: GHPullRequestState;
  isDraft: boolean;
  author: GHActor | null;
  createdAt: string;
  updatedAt: string;
  isReadByViewer: boolean;
  assignees: GHNodes<GHUser>;
  labels: GHNodes<GHLabel>;
  reviewRequests: GHNodes<{ requestedReviewer: GHPullRequestRequestedReviewer | null }>;
  reviewThreads: GHNodes<{ isResolved: boolean; isOutdated: boolean }>;
  reviews: GHNodes<GHPullRequestReview>;
  mergeable: GHPullRequestMergeableState;
  viewerCanUpdate: boolean;
  viewerCanReact: boolean;
  viewerDidAuthor: boolean;
}

/** `pullRequestInfo` fragment: the details (`findPullRequest`). */
export interface GHPullRequest extends GHPullRequestShort {
  body: string;
  reviewDecision: GHPullRequestReviewDecision | null;
  baseRefName: string;
  baseRefOid: string;
  baseRepository: GHRepository | null;
  /** Null once the head branch is deleted. */
  headRef: { id: string } | null;
  headRefName: string;
  headRefOid: string;
  headRepository: GHRepository | null;
  viewerCanDeleteHeadRef: boolean;
}

/** `pullRequestBranchMatch` fragment. */
export interface GHPullRequestBranchMatch {
  id: string;
  number: number;
  title: string;
  headRefName: string;
}

// ---------------------------------------------------------------------------
// Mergeability (`findPullRequestMergeability`)

/** `refUpdateRule` fragment. */
export interface GHRefUpdateRule {
  allowsDeletions: boolean;
  allowsForcePushes: boolean;
  pattern: string;
  requiredApprovingReviewCount: number | null;
  requiredStatusCheckContexts: Array<string | null>;
  requiresLinearHistory: boolean;
  requiresSignatures: boolean;
  viewerCanPush: boolean;
}

export type GHCommitStatusContextState = "ERROR" | "EXPECTED" | "FAILURE" | "PENDING" | "SUCCESS";
export type GHCommitCheckSuiteConclusion =
  | "ACTION_REQUIRED"
  | "CANCELLED"
  | "FAILURE"
  | "NEUTRAL"
  | "SKIPPED"
  | "STALE"
  | "STARTUP_FAILURE"
  | "SUCCESS"
  | "TIMED_OUT";

/** `commitStatusContext` fragment. */
export interface GHCommitStatusContext {
  context: string;
  state: GHCommitStatusContextState;
  isRequired: boolean;
  targetUrl: string | null;
}

/** `checkRun` fragment. */
export interface GHCheckRun {
  name: string;
  conclusion: GHCommitCheckSuiteConclusion | null;
  isRequired: boolean;
  detailsUrl: string | null;
  url: string;
}

/** `commitWithCheckStatuses` fragment. */
export interface GHCommitWithCheckStatuses extends GHCommitHash {
  status: { contexts: GHCommitStatusContext[] } | null;
  checkSuites: GHConnection<{ checkRuns: GHConnection<GHCheckRun> | null }> | null;
}

/** `pullRequestMergeability` fragment. */
export interface GHPullRequestMergeabilityData {
  mergeable: GHPullRequestMergeableState;
  canBeRebased: boolean;
  mergeStateStatus: GHPullRequestMergeStateStatus;
  baseRef: { refUpdateRule: GHRefUpdateRule | null } | null;
  commits: GHConnection<{ id: string; commit: GHCommitWithCheckStatuses }>;
}

/** `statusCheckRollup` (`getRepositoryCommitStatusContexts`). */
export type GHCommitStatusRollupContext =
  | {
      __typename: "CheckRun";
      checkSuite: { workflowRun: { workflow: { name: string } } | null } | null;
      name: string;
      title: string | null;
      status: string;
      conclusion: GHCommitCheckSuiteConclusion | null;
      url: string;
    }
  | {
      __typename: "StatusContext";
      context: string;
      description: string | null;
      state: GHCommitStatusContextState;
      targetUrl: string | null;
    };

// ---------------------------------------------------------------------------
// Files, reviews, threads

export type GHPullRequestFileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

/** `pullRequestFiles` node. */
export interface GHPullRequestChangedFile {
  path: string;
  viewerViewedState: GHPullRequestFileViewedState;
}

/** REST `pulls/{n}/files` / `commits/{sha}` entry (IntelliJ's `GHCommitFile`), camel-cased. */
export interface GHCommitFile {
  sha: string | null;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for binary and very large files. */
  patch: string | null;
  previousFilename: string | null;
}

/** `pullRequestPendingReview` fragment, flattened like IntelliJ's `GHPullRequestPendingReview`. */
export interface GHPullRequestPendingReview {
  id: string;
  state: GHPullRequestReviewState;
  commentsCount: number;
}

/** `comment` fragment. */
export interface GHComment extends GHReactable {
  id: string;
  author: GHActor | null;
  body: string;
  createdAt: string;
}

export type GHPullRequestReviewCommentState = "PENDING" | "SUBMITTED";

/** `pullRequestReviewComment` fragment. */
export interface GHPullRequestReviewComment extends GHComment {
  url: string;
  state: GHPullRequestReviewCommentState;
  commit: GHCommitHash | null;
  originalCommit: GHCommitHash | null;
  diffHunk: string;
  pullRequestReview: { id: string } | null;
  viewerCanDelete: boolean;
  viewerCanUpdate: boolean;
  viewerCanReact: boolean;
}

export type GHDiffSide = "LEFT" | "RIGHT";

/** `pullRequestReviewThread` fragment. Lines are 1-based; `line` is null when outdated. */
export interface GHPullRequestReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  subjectType: "LINE" | "FILE";
  diffSide: GHDiffSide;
  line: number | null;
  originalLine: number | null;
  startDiffSide: GHDiffSide | null;
  startLine: number | null;
  originalStartLine: number | null;
  comments: GHNodes<GHPullRequestReviewComment>;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
}

/** `DraftPullRequestReviewThread` input of `createReview`. */
export interface GHPullRequestDraftReviewThread {
  body: string;
  path: string;
  line: number;
  side: GHDiffSide;
  startLine?: number | null;
  startSide?: GHDiffSide | null;
}

// ---------------------------------------------------------------------------
// Timeline (`pullRequestTimeline`)

interface GHTimelineEvent {
  actor: GHActor | null;
  createdAt: string;
}

/** `issueCommentInfo`. */
export interface GHIssueComment extends GHComment {
  __typename: "IssueComment";
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  viewerCanReact: boolean;
}

/** `referenceSubject`. */
export type GHReferencedSubject =
  | {
      __typename: "PullRequest";
      title: string;
      number: number;
      prState: GHPullRequestState;
      isDraft: boolean;
      url: string;
    }
  | { __typename: "Issue"; title: string; number: number; issueState: "OPEN" | "CLOSED"; url: string };

export type GHPRTimelineItem =
  | { __typename: "PullRequestCommit"; id: string; commit: GHCommitShort; url: string }
  | GHPullRequestReview
  | GHIssueComment
  | ({ __typename: "RenamedTitleEvent"; previousTitle: string; currentTitle: string } & GHTimelineEvent)
  | ({ __typename: "ClosedEvent" } & GHTimelineEvent)
  | ({ __typename: "ReopenedEvent" } & GHTimelineEvent)
  | ({ __typename: "MergedEvent"; mergedEventCommit: GHCommitShort | null; mergeRefName: string } & GHTimelineEvent)
  | ({ __typename: "AssignedEvent"; user: GHUser | null } & GHTimelineEvent)
  | ({ __typename: "UnassignedEvent"; user: GHUser | null } & GHTimelineEvent)
  | ({ __typename: "LabeledEvent"; label: GHLabel } & GHTimelineEvent)
  | ({ __typename: "UnlabeledEvent"; label: GHLabel } & GHTimelineEvent)
  | ({ __typename: "ReviewRequestedEvent"; requestedReviewer: GHPullRequestRequestedReviewer | null } & GHTimelineEvent)
  | ({
      __typename: "ReviewRequestRemovedEvent";
      requestedReviewer: GHPullRequestRequestedReviewer | null;
    } & GHTimelineEvent)
  | ({
      __typename: "ReviewDismissedEvent";
      dismissalMessageHTML: string | null;
      review: { author: GHActor | null } | null;
    } & GHTimelineEvent)
  | ({ __typename: "ReadyForReviewEvent" } & GHTimelineEvent)
  | ({ __typename: "ConvertToDraftEvent" } & GHTimelineEvent)
  | ({ __typename: "BaseRefChangedEvent" } & GHTimelineEvent)
  | ({ __typename: "BaseRefForcePushedEvent"; ref: { name: string } | null } & GHTimelineEvent)
  | ({
      __typename: "HeadRefForcePushedEvent";
      ref: { name: string } | null;
      beforeCommit: GHCommitHash | null;
      afterCommit: GHCommitHash | null;
    } & GHTimelineEvent)
  | ({ __typename: "HeadRefDeletedEvent"; headRefName: string } & GHTimelineEvent)
  | ({ __typename: "HeadRefRestoredEvent" } & GHTimelineEvent)
  | ({ __typename: "CrossReferencedEvent"; source: GHReferencedSubject } & GHTimelineEvent)
  | ({ __typename: "ConnectedEvent"; subject: GHReferencedSubject } & GHTimelineEvent)
  | ({ __typename: "DisconnectedEvent"; subject: GHReferencedSubject } & GHTimelineEvent)
  /** Types the document does not select fields for (ReferencedEvent, MentionedEvent…). */
  | { __typename: "Unknown"; type: string };

// ---------------------------------------------------------------------------
// Derived state (`data/model.ts`)

/** IntelliJ's `GHPRReviewerState`. */
export type GHPRReviewerState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "NEEDS_REVIEW" | "RE_REQUESTED";

export type CodeReviewCIJobState = "FAILED" | "PENDING" | "SKIPPED" | "SUCCESS";

/** IntelliJ's `CodeReviewCIJob`. */
export interface CodeReviewCIJob {
  name: string;
  status: CodeReviewCIJobState;
  isRequired: boolean;
  detailsUrl: string | null;
}

/** IntelliJ's `GHPRMergeabilityState`, plus the raw GitHub values it was built from. */
export interface GHPRMergeabilityState {
  /** Null while GitHub is still checking (mergeable UNKNOWN). */
  hasConflicts: boolean | null;
  ciJobs: CodeReviewCIJob[];
  canBeMerged: boolean;
  canBeRebased: boolean;
  /** The viewer may not push to the base branch. */
  isRestricted: boolean;
  /** Approvals still required by branch protection (0 when nothing blocks on reviews). */
  requiredApprovingReviewsCount: number;
  /** `BLOCKING_BEHIND` / `BLOCKING_FAILING` when the merge box blocks on them, else null. */
  checksState: "BLOCKING_BEHIND" | "BLOCKING_FAILING" | null;
  mergeable: GHPullRequestMergeableState;
  mergeStateStatus: GHPullRequestMergeStateStatus;
}
