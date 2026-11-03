import { describe, expect, it } from "vitest";
import type {
  CodeReviewCIJob,
  GHCommitFile,
  GHPullRequest,
  GHPullRequestReviewThread,
  GHRepository,
  GHTeam,
  GHUser,
} from "../api/types";
import type { GHRemote } from "../data/repository";
import {
  accessDeniedText,
  changeKind,
  changesTree,
  ciSummary,
  commitsTitle,
  headBranchLabel,
  isHeadCheckedOut,
  isViewed,
  mergeButtonMethods,
  openedActions,
  overallReviewState,
  presentableName,
  progressOf,
  resolveConflicts,
  reviewersDelta,
  reviewerStatusIcon,
  reviewerStatusText,
  reviewRequestState,
  reviewRole,
  selectedFiles,
  stepCommit,
  unresolvedThreadsByPath,
  viewedToggleText,
} from "./model";

const user = (login: string, name: string | null = null): GHUser => ({
  __typename: "User",
  id: `id-${login}`,
  login,
  url: `https://github.com/${login}`,
  avatarUrl: "",
  name,
});
const team: GHTeam = {
  __typename: "Team",
  id: "T1",
  slug: "core",
  url: "",
  teamAvatarUrl: null,
  teamName: "Core",
  combinedSlug: "org/core",
};
const repo = (nameWithOwner: string, isFork = false): GHRepository => ({
  id: nameWithOwner,
  owner: { __typename: "User", id: "o", login: nameWithOwner.split("/")[0]! },
  nameWithOwner,
  viewerPermission: "WRITE",
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  defaultBranchRef: { name: "main" },
  isFork,
  url: `https://github.com/${nameWithOwner}`,
  sshUrl: "",
});
const file = (filename: string, status: GHCommitFile["status"] = "modified"): GHCommitFile => ({
  sha: null,
  filename,
  status,
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: null,
  previousFilename: null,
});
const thread = (path: string, isResolved = false) => ({ path, isResolved }) as GHPullRequestReviewThread;
const remote = (owner: string, name: string, r: string): GHRemote => ({ owner, name, remote: r, url: "" });

function pr(patch: Partial<GHPullRequest> = {}): GHPullRequest {
  return {
    id: "PR1",
    url: "https://github.com/o/r/pull/7",
    number: 7,
    title: "Title",
    state: "OPEN",
    isDraft: false,
    author: user("alice"),
    createdAt: "",
    updatedAt: "",
    isReadByViewer: true,
    assignees: { nodes: [] },
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    mergeable: "MERGEABLE",
    viewerCanUpdate: true,
    viewerCanReact: true,
    viewerDidAuthor: false,
    reactions: {
      pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
      nodes: [],
    },
    body: "",
    reviewDecision: null,
    baseRefName: "main",
    baseRefOid: "base",
    baseRepository: repo("o/r"),
    headRef: { id: "ref" },
    headRefName: "feature",
    headRefOid: "head",
    headRepository: repo("o/r"),
    viewerCanDeleteHeadRef: false,
    ...patch,
  };
}

describe("review flow", () => {
  it("derives the request state, a draft first", () => {
    expect(reviewRequestState(pr())).toBe("OPENED");
    expect(reviewRequestState(pr({ state: "MERGED" }))).toBe("MERGED");
    expect(reviewRequestState(pr({ state: "CLOSED" }))).toBe("CLOSED");
    expect(reviewRequestState(pr({ state: "CLOSED", isDraft: true }))).toBe("DRAFT");
  });

  it("decides the role from authorship, requests and reviews", () => {
    const bob = user("bob");
    expect(reviewRole(pr(), user("alice"))).toBe("AUTHOR");
    expect(reviewRole(pr({ reviewRequests: { nodes: [{ requestedReviewer: bob }] } }), bob)).toBe("REVIEWER");
    const reviewed = pr({ reviews: { nodes: [{ author: bob } as GHPullRequest["reviews"]["nodes"][0]] } });
    expect(reviewRole(reviewed, bob)).toBe("REVIEWER");
    expect(reviewRole(pr(), bob)).toBe("GUEST");
  });

  it("accepts on enough approvals, else follows the review decision", () => {
    const approved = [{ reviewer: user("b"), state: "APPROVED" as const }];
    expect(overallReviewState(pr(), approved, 0)).toBe("ACCEPTED");
    expect(overallReviewState(pr(), approved, 2)).toBe("NEED_REVIEW");
    expect(overallReviewState(pr({ reviewDecision: "APPROVED" }), [], 2)).toBe("ACCEPTED");
    expect(overallReviewState(pr({ reviewDecision: "CHANGES_REQUESTED" }), [], 0)).toBe("WAIT_FOR_UPDATES");
    expect(overallReviewState(pr({ reviewDecision: "REVIEW_REQUIRED" }), [], 0)).toBe("NEED_REVIEW");
  });

  it("shows the author's buttons per review state", () => {
    expect(openedActions("AUTHOR", "NEED_REVIEW", 0, null)).toMatchObject({
      requestReview: true,
      reRequestReview: false,
      merge: false,
      more: ["mergeGroup", "close"],
    });
    expect(openedActions("AUTHOR", "WAIT_FOR_UPDATES", 1, null)).toMatchObject({
      requestReview: true,
      reRequestReview: false,
    });
    expect(openedActions("AUTHOR", "WAIT_FOR_UPDATES", 0, null)).toMatchObject({
      requestReview: false,
      reRequestReview: true,
    });
    expect(openedActions("AUTHOR", "ACCEPTED", 0, null)).toMatchObject({
      requestReview: false,
      merge: true,
      more: ["requestReview", "close"],
    });
  });

  it("shows the reviewer's and the guest's buttons", () => {
    expect(openedActions("REVIEWER", "NEED_REVIEW", 1, "NEEDS_REVIEW")).toMatchObject({
      submitReview: true,
      merge: false,
      more: ["requestReview", "mergeGroup", "close"],
    });
    expect(openedActions("REVIEWER", "ACCEPTED", 0, "APPROVED")).toMatchObject({ submitReview: false, merge: true });
    expect(openedActions("REVIEWER", "ACCEPTED", 1, "RE_REQUESTED").merge).toBe(false);
    expect(openedActions("GUEST", "ACCEPTED", 0, null)).toMatchObject({
      setMyselfAsReviewer: true,
      merge: false,
      more: ["requestReview", "mergeGroup", "close"],
    });
  });

  it("picks the merge button's main method from the repository settings", () => {
    expect(mergeButtonMethods({ mergeCommitAllowed: true, squashMergeAllowed: true })).toEqual({
      main: "merge",
      others: ["squash", "rebase"],
    });
    expect(mergeButtonMethods({ mergeCommitAllowed: false, squashMergeAllowed: true }).main).toBe("squash");
    expect(mergeButtonMethods({ mergeCommitAllowed: false, squashMergeAllowed: false })).toEqual({
      main: "rebase",
      others: ["merge", "squash"],
    });
  });

  it("computes the reviewer delta by login and team slug", () => {
    const a = user("a");
    const b = user("b");
    expect(reviewersDelta([a, team], [b, { ...team }, b])).toEqual({ added: [b], removed: [a] });
  });

  it("presents reviewers by name, else login or slug", () => {
    expect(presentableName(user("a", "Ann"))).toBe("Ann");
    expect(presentableName(user("a"))).toBe("a");
    expect(presentableName(team)).toBe("Core");
    expect(presentableName({ ...team, teamName: "" })).toBe("org/core");
  });
});

describe("status section", () => {
  const job = (status: CodeReviewCIJob["status"], isRequired = false): CodeReviewCIJob => ({
    name: status,
    status,
    isRequired,
    detailsUrl: null,
  });

  it("summarises the CI jobs", () => {
    expect(ciSummary([])).toBeNull();
    expect(ciSummary([job("SUCCESS", true), job("FAILED")])).toEqual({
      icon: "success",
      text: "All required checks have passed",
    });
    expect(ciSummary([job("PENDING", true), job("FAILED", true)])?.icon).toBe("failedInProgress");
    expect(ciSummary([job("PENDING", true)])).toEqual({ icon: "pending", text: "Checks in progress…" });
    expect(ciSummary([job("FAILED", true), job("SKIPPED")])).toEqual({ icon: "failed", text: "Checks failed" });
  });

  it("explains missing access", () => {
    expect(accessDeniedText("READ", false, false)).toBe("Repository access required to manage pull requests");
    expect(accessDeniedText("READ", true, false)).toBe("Repository write access required to merge pull requests");
    expect(accessDeniedText("READ", true, true)).toBeNull();
    expect(accessDeniedText("TRIAGE", false, true)).toBe("Repository write access required to merge pull requests");
    expect(accessDeniedText("WRITE", false, false)).toBeNull();
    expect(accessDeniedText("WRITE", false, false, true)).toBe("Merging is disabled for this project");
  });

  it("words and marks reviewer states like GitHub", () => {
    expect(reviewerStatusText("APPROVED", "Ann")).toBe("Ann approved review");
    expect(reviewerStatusText("CHANGES_REQUESTED", "Ann")).toBe("Ann is waiting for updates");
    expect(reviewerStatusText("NEEDS_REVIEW", "Ann")).toBe("Waiting for review from Ann");
    expect(reviewerStatusText("RE_REQUESTED", "Ann")).toBe("Re-requested review from Ann");
    expect(reviewerStatusText("COMMENTED", "Ann")).toBe("Ann left comments");
    expect(reviewerStatusIcon("APPROVED")).toBe("success");
    expect(reviewerStatusIcon("CHANGES_REQUESTED")).toBe("error");
    expect(reviewerStatusIcon("RE_REQUESTED")).toBe("warning");
    expect(reviewerStatusIcon("COMMENTED")).toBe("review-comment");
  });

  it("decides whether Resolve can run", () => {
    const remotes = [remote("o", "r", "origin")];
    const base = { remotes, mergeInProgress: false, alreadyResolvedLocally: false };
    expect(resolveConflicts({ ...base, details: pr() })).toEqual({
      headRemote: "origin",
      baseRemote: "origin",
      headRefName: "feature",
      baseRefName: "main",
    });
    expect(resolveConflicts({ ...base, details: undefined })).toEqual({ error: "Details have not finished loading" });
    expect(resolveConflicts({ ...base, details: pr(), mergeInProgress: true })).toEqual({
      error: "Merge is already in progress",
    });
    expect(resolveConflicts({ ...base, details: pr({ headRepository: null }) })).toEqual({
      error: "Source repository not found",
    });
    expect(resolveConflicts({ ...base, details: pr({ headRepository: repo("fork/r", true) }) })).toEqual({
      error: "Source remote not found: https://github.com/fork/r",
    });
    expect(resolveConflicts({ ...base, details: pr(), alreadyResolvedLocally: true })).toEqual({
      error: "Already resolved locally, push your changes to resolve",
    });
  });
});

describe("branches", () => {
  it("shows owner:branch for forks and equal names", () => {
    expect(headBranchLabel(pr())).toBe("feature");
    expect(headBranchLabel(pr({ headRepository: repo("fork/r", true) }))).toBe("fork:feature");
    expect(headBranchLabel(pr({ headRefName: "main" }))).toBe("o:main");
  });

  it("knows when the head branch is checked out", () => {
    const remotes = [remote("o", "r", "origin"), remote("fork", "r", "fork")];
    const head = (h: string | null, upstream: string | null, headCommit = "x") => ({ head: h, headCommit, upstream });
    expect(isHeadCheckedOut(head("feature", "origin/feature"), remotes, pr())).toBe(true);
    expect(isHeadCheckedOut(head("feature", "fork/feature"), remotes, pr())).toBe(false);
    expect(isHeadCheckedOut(head("other", "origin/other"), remotes, pr())).toBe(false);
    expect(isHeadCheckedOut(head(null, null), remotes, pr())).toBe(false);
    // gh's fork checkouts track a URL: the name and the head commit decide.
    const fork = pr({ headRepository: repo("someone/r", true) });
    expect(isHeadCheckedOut(head("someone/feature", null, "head"), remotes, fork)).toBe(true);
    expect(isHeadCheckedOut(head("feature", null, "older"), remotes, fork)).toBe(false);
  });
});

describe("commit picker", () => {
  it("labels and steps through the commits", () => {
    expect(commitsTitle(1)).toBe("Changes");
    expect(commitsTitle(3)).toBe("Changes from");
    expect(stepCommit(-1, 3, 1)).toBeNull();
    expect(stepCommit(0, 3, 1)).toBe(1);
    expect(stepCommit(2, 3, 1)).toBeNull();
    expect(stepCommit(0, 3, -1)).toBeNull();
    expect(stepCommit(2, 3, -1)).toBe(1);
  });
});

describe("changes tree", () => {
  const files = [file("src/a.ts"), file("src/b.ts", "added"), file("README.md", "removed")];

  it("groups by directory or lists flat", () => {
    expect(changesTree(files, true).map((n) => n.name)).toEqual(["src", "README.md"]);
    expect(changesTree(files, false).map((n) => n.name)).toEqual(["a.ts", "b.ts", "README.md"]);
  });

  it("counts unresolved threads and the viewed state, folders summing their files", () => {
    const threads = unresolvedThreadsByPath([thread("src/a.ts"), thread("src/a.ts"), thread("src/b.ts", true)]);
    expect([...threads]).toEqual([["src/a.ts", 2]]);
    const viewed = { "src/a.ts": "VIEWED", "src/b.ts": "DISMISSED" } as const;
    const leaf = (f: GHCommitFile) => ({
      isRead: isViewed(viewed[f.filename as keyof typeof viewed]),
      discussions: threads.get(f.filename) ?? 0,
    });
    const [src, readme] = changesTree(files, true);
    expect(progressOf(src!, leaf)).toEqual({ isRead: false, discussions: 2 });
    expect(progressOf(src!.children[0]!, leaf)).toEqual({ isRead: true, discussions: 2 });
    expect(progressOf(readme!, leaf)).toEqual({ isRead: true, discussions: 0 });
  });

  it("collects the files under the selection", () => {
    const roots = changesTree(files, true);
    expect(selectedFiles(roots, new Set(["d:src", "f:src/a.ts"])).map((f) => f.filename)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(selectedFiles(roots, new Set(["f:README.md"])).map((f) => f.filename)).toEqual(["README.md"]);
  });

  it("colours by VCS status and words the viewed toggle", () => {
    expect(changeKind(file("a", "added"))).toBe("added");
    expect(changeKind(file("a", "removed"))).toBe("deleted");
    expect(changeKind(file("a", "renamed"))).toBe("modified");
    expect(viewedToggleText(1, false)).toBe("Mark as Viewed");
    expect(viewedToggleText(1, true)).toBe("Mark as Not Viewed");
    expect(viewedToggleText(2, false)).toBe("Mark All as Viewed");
    expect(viewedToggleText(2, true)).toBe("Mark All as Not Viewed");
  });
});
