/**
 * Pure rules of the pull request data, ported from IntelliJ: the list search value and
 * its query (`GHPRListSearchValue`, `GHPRSearchQuery`), reviewer states
 * (`GHReviewersUtils`), the unread rule (`GHPRPersistentInteractionState`), the merge box
 * state (`GHPRMergeabilityStateBuilder`), permissions (`GHPRSecurityService`) and the
 * merge commit messages (`GHPRReviewFlowViewModelImpl`).
 */
import type {
  CodeReviewCIJob,
  CodeReviewCIJobState,
  GHActor,
  GHCommitCheckSuiteConclusion,
  GHCommitStatusContextState,
  GHPRMergeabilityState,
  GHPRReviewerState,
  GHPullRequest,
  GHPullRequestMergeabilityData,
  GHPullRequestMergeStateStatus,
  GHPullRequestRequestedReviewer,
  GHPullRequestReview,
  GHPullRequestShort,
  GHPullRequestState,
  GHRepository,
  GHRepositoryCoordinates,
  GHRepositoryPermissionLevel,
  GHTeam,
  GHUser,
} from "../api/types";

// ---------------------------------------------------------------------------
// List search (`GHPRListSearchValue`)

export type PrSearchState = "OPEN" | "CLOSED" | "MERGED";
export type PrSearchReviewState =
  | "NO_REVIEW"
  | "REQUIRED"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEWED_BY_ME"
  | "NOT_REVIEWED_BY_ME"
  | "AWAITING_REVIEW";
export type PrSearchSort =
  | "NEWEST"
  | "OLDEST"
  | "MOST_COMMENTED"
  | "LEAST_COMMENTED"
  | "RECENTLY_UPDATED"
  | "LEAST_RECENTLY_UPDATED";

/** The list filter: free text plus the chips (author / assignee are logins). Unset = absent. */
export interface PrSearchValue {
  searchQuery?: string;
  state?: PrSearchState;
  assignee?: string;
  reviewState?: PrSearchReviewState;
  author?: string;
  label?: string;
  sort?: PrSearchSort;
}

/** `GHPRListSearchValue.DEFAULT`: the Quick Filters' "Open" (`EMPTY` is `{}`). */
export const DEFAULT_SEARCH: PrSearchValue = { state: "OPEN" };

const SEARCH_KEYS = ["searchQuery", "state", "assignee", "reviewState", "author", "label", "sort"] as const;

const STATE_TERMS: Record<PrSearchState, string> = { OPEN: "is:open", CLOSED: "is:closed", MERGED: "is:merged" };
const REVIEW_TERMS: Record<PrSearchReviewState, string> = {
  NO_REVIEW: "review:none",
  REQUIRED: "review:required",
  APPROVED: "review:approved",
  CHANGES_REQUESTED: "review:changes-requested",
  REVIEWED_BY_ME: "reviewed-by:@me",
  NOT_REVIEWED_BY_ME: "-reviewed-by:@me",
  AWAITING_REVIEW: "review-requested:@me",
};
const SORT_TERMS: Record<PrSearchSort, string> = {
  NEWEST: "sort:created-desc",
  OLDEST: "sort:created-asc",
  MOST_COMMENTED: "sort:comments-desc",
  LEAST_COMMENTED: "sort:comments-asc",
  RECENTLY_UPDATED: "sort:updated-desc",
  LEAST_RECENTLY_UPDATED: "sort:updated-asc",
};

/** How many filters are set (the text counts as one), as the Quick Filters badge and "Clear {n} Filters". */
export function filterCount(v: PrSearchValue): number {
  return SEARCH_KEYS.filter((k) => v[k] !== undefined).length;
}

export function sameSearch(a: PrSearchValue, b: PrSearchValue): boolean {
  return SEARCH_KEYS.every((k) => a[k] === b[k]);
}

/** A search value with only known, non-empty fields (from storage or a patch). */
export function normalizeSearch(v: unknown): PrSearchValue | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : undefined);
  const oneOf = <T extends string>(x: unknown, all: Record<T, unknown>) =>
    typeof x === "string" && x in all ? (x as T) : undefined;
  const out: PrSearchValue = {
    searchQuery: str(r.searchQuery),
    state: oneOf(r.state, STATE_TERMS),
    assignee: str(r.assignee),
    reviewState: oneOf(r.reviewState, REVIEW_TERMS),
    author: str(r.author),
    label: str(r.label),
    sort: oneOf(r.sort, SORT_TERMS),
  };
  for (const k of SEARCH_KEYS) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * The filter's search terms (`GHPRListSearchValue.toQuery`), or null when nothing is set.
 * The typed text is grouped in parentheses: GitHub's advanced search gives `OR` the lowest
 * precedence, so `a OR b` would otherwise escape the repository and the other filters.
 */
export function searchTerms(v: PrSearchValue): string | null {
  const terms: string[] = [];
  const text = v.searchQuery?.trim();
  if (text) terms.push(`(${text})`);
  if (v.state) terms.push(STATE_TERMS[v.state]);
  if (v.assignee !== undefined) terms.push(`assignee:${v.assignee}`);
  if (v.reviewState) terms.push(REVIEW_TERMS[v.reviewState]);
  if (v.author !== undefined) terms.push(`author:${v.author}`);
  if (v.label !== undefined) terms.push(`label:"${v.label}"`);
  if (v.sort) terms.push(SORT_TERMS[v.sort]);
  return terms.length ? terms.join(" ") : null;
}

/** The `issueSearch` query of the list: `type:pr repo:owner/name` and the filter's terms. */
export function listSearchQuery(repo: GHRepositoryCoordinates, v: PrSearchValue): string {
  const terms = searchTerms(v);
  return [`type:pr repo:${repo.owner}/${repo.name}`, terms].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Reviewers (`GHReviewersUtils`)

export interface ReviewerWithState {
  reviewer: GHPullRequestRequestedReviewer;
  state: GHPRReviewerState;
}

export const isTeam = (r: GHPullRequestRequestedReviewer | GHActor | null | undefined): r is GHTeam =>
  r?.__typename === "Team";

/** Login of a user / actor, `org/slug` of a team. */
export function reviewerKey(r: GHPullRequestRequestedReviewer): string {
  return isTeam(r) ? r.combinedSlug : r.login;
}

/** A reviewer's effective state from their reviews, newest first; null for no submitted review. */
export function reviewerStateOf(reviews: readonly GHPullRequestReview[]): GHPRReviewerState | null {
  let commented = false;
  const newestFirst = [...reviews].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const review of newestFirst) {
    switch (review.state) {
      case "APPROVED":
        return "APPROVED";
      case "CHANGES_REQUESTED":
        return "CHANGES_REQUESTED";
      case "DISMISSED":
        return "COMMENTED";
      case "COMMENTED":
        commented = true;
        break;
      case "PENDING":
        break;
    }
  }
  return commented ? "COMMENTED" : null;
}

/** Placeholder author of reviews whose user was deleted (IntelliJ's ghost user). */
export const GHOST_USER: GHUser = {
  __typename: "User",
  id: "",
  login: "ghost",
  url: "https://github.com/ghost",
  avatarUrl: "https://avatars.githubusercontent.com/u/10137?v=4",
  name: "Deleted user",
};

/**
 * Every reviewer of `pr` with their state, as GitHub shows them: reviewers by their
 * reviews (the author's own excluded), then the pending requests, which make a reviewer
 * who already reviewed RE_REQUESTED and one who did not NEEDS_REVIEW.
 */
export function reviewersStates(
  pr: Pick<GHPullRequestShort, "author" | "reviews" | "reviewRequests">,
): ReviewerWithState[] {
  const result = new Map<string, ReviewerWithState>();
  const byReviewer = new Map<string, { reviewer: GHPullRequestRequestedReviewer; reviews: GHPullRequestReview[] }>();
  for (const review of pr.reviews.nodes) {
    const reviewer = review.author ?? GHOST_USER;
    const key = reviewerKey(reviewer);
    const group = byReviewer.get(key) ?? { reviewer, reviews: [] };
    group.reviews.push(review);
    byReviewer.set(key, group);
  }
  const authorKey = pr.author ? pr.author.login : null;
  for (const [key, { reviewer, reviews }] of byReviewer) {
    if (key === authorKey) continue;
    const state = reviewerStateOf(reviews);
    if (state) result.set(key, { reviewer, state });
  }
  for (const { requestedReviewer } of pr.reviewRequests.nodes) {
    if (!requestedReviewer) continue;
    const key = reviewerKey(requestedReviewer);
    result.set(key, { reviewer: requestedReviewer, state: result.has(key) ? "RE_REQUESTED" : "NEEDS_REVIEW" });
  }
  return [...result.values()];
}

const REVIEWER_ORDER: Record<GHPRReviewerState, number> = {
  APPROVED: 0,
  CHANGES_REQUESTED: 1,
  COMMENTED: 2,
  RE_REQUESTED: 3,
  NEEDS_REVIEW: 4,
};

/** `reviewersStates` ordered like the list row's avatars: approved → changes requested → commented → re-requested → needs review. */
export function sortedReviewersStates(pr: Pick<GHPullRequestShort, "author" | "reviews" | "reviewRequests">) {
  return reviewersStates(pr).sort((a, b) => REVIEWER_ORDER[a.state] - REVIEWER_ORDER[b.state]);
}

/** Review threads that are neither resolved nor outdated (the list row's comment counter). */
export function unresolvedThreadsCount(pr: Pick<GHPullRequestShort, "reviewThreads">): number {
  return pr.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated).length;
}

// ---------------------------------------------------------------------------
// Unread (`GHPRPersistentInteractionState`)

/** Registry `github.last.seen.state.margin.millis`. */
export const LAST_SEEN_MARGIN_MS = 5000;
/** Registry `github.clear.last.seen.state.days`. */
export const CLEAR_LAST_SEEN_AFTER_DAYS = 14;

/**
 * Whether `pr` counts as seen by `user`: always, unless the user wrote it or their review
 * is requested; then when it was last seen (ms, stored locally) no earlier than its update.
 */
export function isSeen(
  pr: Pick<GHPullRequestShort, "author" | "reviewRequests" | "updatedAt">,
  user: Pick<GHUser, "id">,
  lastSeen: number | null | undefined,
): boolean {
  const involved =
    pr.author?.id === user.id || pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.id === user.id);
  if (!involved) return true;
  return lastSeen != null && lastSeen + LAST_SEEN_MARGIN_MS >= Date.parse(pr.updatedAt);
}

// ---------------------------------------------------------------------------
// Pull request state

/** `GHUIUtil.getPullRequestStateIcon`. */
export function pullRequestStateIcon(state: GHPullRequestState, isDraft: boolean): string {
  if (state === "MERGED") return "github-pr-merged";
  if (state === "CLOSED") return "github-pr-closed";
  return isDraft ? "github-pr-draft" : "github-pr-open";
}

/** The state tag's text, or null for an open pull request (draft wins over open). */
export function stateTagText(state: GHPullRequestState, isDraft: boolean): "DRAFT" | "CLOSED" | "MERGED" | null {
  if (state === "MERGED") return "MERGED";
  if (state === "CLOSED") return "CLOSED";
  return isDraft ? "DRAFT" : null;
}

// ---------------------------------------------------------------------------
// Mergeability (`GHPRMergeabilityStateBuilder`)

const CAN_MERGE: ReadonlySet<GHPullRequestMergeStateStatus> = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const ADMIN_CAN_MERGE: ReadonlySet<GHPullRequestMergeStateStatus> = new Set(["BLOCKED", "BEHIND"]);

function contextJobState(s: GHCommitStatusContextState): CodeReviewCIJobState {
  if (s === "PENDING") return "PENDING";
  if (s === "SUCCESS") return "SUCCESS";
  return "FAILED";
}

function checkRunJobState(c: GHCommitCheckSuiteConclusion | null): CodeReviewCIJobState {
  if (c === null) return "PENDING";
  if (c === "SKIPPED") return "SKIPPED";
  if (c === "SUCCESS") return "SUCCESS";
  return "FAILED";
}

export function buildMergeabilityState(
  data: GHPullRequestMergeabilityData,
  currentUserIsAdmin: boolean,
): GHPRMergeabilityState {
  const rule = data.baseRef?.refUpdateRule ?? null;
  const canOverrideAsAdmin = rule ? currentUserIsAdmin : false;
  const requiredContexts = rule ? rule.requiredStatusCheckContexts.filter((c): c is string => c !== null) : [];
  const isRestricted = rule ? !rule.viewerCanPush : false;
  const requiredReviews = rule?.requiredApprovingReviewCount ?? 0;

  const hasConflicts = data.mergeable === "MERGEABLE" ? false : data.mergeable === "CONFLICTING" ? true : null;
  const lastCommit = data.commits.nodes.at(-1)?.commit;
  const contexts = lastCommit?.status?.contexts ?? [];
  const ciJobs: CodeReviewCIJob[] = [
    ...contexts.map((c) => ({
      name: c.context,
      status: contextJobState(c.state),
      isRequired: c.isRequired,
      detailsUrl: c.targetUrl,
    })),
    ...(lastCommit?.checkSuites?.nodes ?? [])
      .flatMap((s) => s.checkRuns?.nodes ?? [])
      .map((r) => ({
        name: r.name,
        status: checkRunJobState(r.conclusion),
        isRequired: r.isRequired,
        detailsUrl: r.detailsUrl ?? r.url,
      })),
  ];
  const status = data.mergeStateStatus;
  const canBeMerged = CAN_MERGE.has(status) || (ADMIN_CAN_MERGE.has(status) && canOverrideAsAdmin);
  let checksState: GHPRMergeabilityState["checksState"] = null;
  if (status === "BEHIND") checksState = "BLOCKING_BEHIND";
  else if (status === "BLOCKED") {
    const passed = new Set(contexts.filter((c) => c.state === "SUCCESS").map((c) => c.context));
    if (requiredContexts.length && !requiredContexts.every((c) => passed.has(c))) checksState = "BLOCKING_FAILING";
  }
  const requiredApprovingReviewsCount =
    status === "BLOCKED" && !isRestricted && checksState !== "BLOCKING_FAILING" ? requiredReviews : 0;
  return {
    hasConflicts,
    ciJobs,
    canBeMerged,
    canBeRebased: data.canBeRebased,
    isRestricted,
    requiredApprovingReviewsCount,
    checksState,
    mergeable: data.mergeable,
    mergeStateStatus: status,
  };
}

// ---------------------------------------------------------------------------
// Permissions (`GHPRSecurityService`)

const PERMISSION_ORDER: GHRepositoryPermissionLevel[] = ["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"];

/** Whether `permission` is at least `level` (an unknown permission has none). */
export function hasPermission(
  permission: GHRepositoryPermissionLevel | null | undefined,
  level: GHRepositoryPermissionLevel,
): boolean {
  return (permission ? PERMISSION_ORDER.indexOf(permission) : -1) >= PERMISSION_ORDER.indexOf(level);
}

/**
 * Which pull request actions the user may run (IntelliJ's review flow enablement): managing
 * (request reviewers, close, reopen, post a draft) needs triage access or authorship; merging
 * needs write access, a method the repository allows, a mergeable state and an unrestricted
 * base branch, and `mergeForbidden` (the project setting) off.
 */
export function pullRequestPermissions(
  pr: Pick<GHPullRequest, "viewerDidAuthor" | "state">,
  repo: Pick<GHRepository, "viewerPermission" | "mergeCommitAllowed" | "squashMergeAllowed" | "rebaseMergeAllowed">,
  mergeability: GHPRMergeabilityState | null,
  mergeForbidden = false,
) {
  const canManage = hasPermission(repo.viewerPermission, "TRIAGE") || pr.viewerDidAuthor;
  const canWrite = hasPermission(repo.viewerPermission, "WRITE") && !mergeForbidden;
  const open = pr.state === "OPEN";
  const mergeable = open && canWrite && !!mergeability && !mergeability.isRestricted;
  return {
    canManage,
    canMerge: mergeable && repo.mergeCommitAllowed && mergeability!.canBeMerged,
    canSquashMerge: mergeable && repo.squashMergeAllowed && mergeability!.canBeMerged,
    canRebaseMerge: mergeable && repo.rebaseMergeAllowed && mergeability!.canBeRebased,
  };
}

// ---------------------------------------------------------------------------
// Merge commit messages

/** The merge dialog's message: subject `Merge pull request #n`, body the title, or `* headline` per commit when squashing. */
export function mergeCommitMessage(
  pr: Pick<GHPullRequest, "number" | "title">,
  squashCommitHeadlines?: readonly string[],
): string {
  const subject = `Merge pull request #${pr.number}`;
  const body = squashCommitHeadlines ? `* ${squashCommitHeadlines.join("\n\n* ")}` : pr.title;
  return `${subject}\n\n${body}`;
}

/** Splits a commit message into its subject (first line) and body (`splitCommitMessage`). */
export function splitCommitMessage(message: string): { title: string; body: string } {
  const i = message.indexOf("\n");
  if (i < 0) return { title: message.trim(), body: "" };
  return { title: message.slice(0, i).trim(), body: message.slice(i + 1).trim() };
}

// ---------------------------------------------------------------------------
// Repositories

/** `GHUIUtil.getRepositoryDisplayName`: `name`, or `owner/name` when the owners differ (or always). */
export function repositoryDisplayName(
  all: readonly GHRepositoryCoordinates[],
  repo: GHRepositoryCoordinates,
  alwaysShowOwner = false,
): string {
  const showOwner = alwaysShowOwner || (all.length > 1 && all.some((r) => r.owner !== all[0]!.owner));
  return showOwner ? `${repo.owner}/${repo.name}` : repo.name;
}

/** `owner/name` of a github.com remote URL (https, ssh or scp-like), else null. */
export function parseGitHubRemote(url: string): GHRepositoryCoordinates | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|(?:[^@/]+@)?)(?:www\.)?github\.com(?::\d+(?=\/))?[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? { owner: m[1]!, name: m[2]! } : null;
}
