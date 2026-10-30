import { beforeEach, describe, expect, it } from "vitest";
import type {
  GHActor,
  GHPullRequestMergeabilityData,
  GHPullRequestReview,
  GHPullRequestShort,
  GHTeam,
  GHUser,
} from "../api/types";
import { createBatchesLoader, mergeBatches } from "./batches";
import {
  buildMergeabilityState,
  filterCount,
  hasPermission,
  isSeen,
  listSearchQuery,
  mergeCommitMessage,
  normalizeSearch,
  parseGitHubRemote,
  pullRequestPermissions,
  pullRequestStateIcon,
  repositoryDisplayName,
  reviewersStates,
  reviewerStateOf,
  searchTerms,
  sortedReviewersStates,
  splitCommitMessage,
  stateTagText,
  unresolvedThreadsCount,
} from "./model";
import { githubRemotes } from "./repository";
import { withSearch } from "./searchHistory";

const user = (login: string): GHUser => ({
  __typename: "User",
  id: `id-${login}`,
  login,
  url: `https://github.com/${login}`,
  avatarUrl: "",
  name: null,
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
let reviewSeq = 0;
const review = (author: GHActor | null, state: GHPullRequestReview["state"], minute: number): GHPullRequestReview => ({
  __typename: "PullRequestReview",
  id: `R${++reviewSeq}`,
  url: "",
  author,
  body: "",
  state,
  createdAt: `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`,
  viewerCanUpdate: false,
});

function pr(over: Partial<GHPullRequestShort> = {}): GHPullRequestShort {
  return {
    id: "PR1",
    url: "https://github.com/o/r/pull/1",
    number: 1,
    title: "Fix",
    state: "OPEN",
    isDraft: false,
    author: user("ann"),
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    isReadByViewer: false,
    assignees: { nodes: [] },
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    reactions: {
      pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
      nodes: [],
    },
    mergeable: "MERGEABLE",
    viewerCanUpdate: false,
    viewerCanReact: true,
    viewerDidAuthor: false,
    ...over,
  };
}

describe("list search", () => {
  it("builds IntelliJ's terms in order", () => {
    expect(
      searchTerms({
        searchQuery: "foo bar",
        state: "MERGED",
        assignee: "me",
        reviewState: "NOT_REVIEWED_BY_ME",
        author: "ann",
        label: "good first issue",
        sort: "LEAST_RECENTLY_UPDATED",
      }),
    ).toBe('(foo bar) is:merged assignee:me -reviewed-by:@me author:ann label:"good first issue" sort:updated-asc');
    expect(searchTerms({ reviewState: "AWAITING_REVIEW" })).toBe("review-requested:@me");
    expect(searchTerms({})).toBeNull();
  });

  it("prefixes the repository for issueSearch", () => {
    expect(listSearchQuery({ owner: "o", name: "r" }, { state: "OPEN" })).toBe("type:pr repo:o/r is:open");
    expect(listSearchQuery({ owner: "o", name: "r" }, {})).toBe("type:pr repo:o/r");
  });

  it("keeps GitHub's boolean syntax inside the repository", () => {
    const q = "is:pr is:open (review-requested:ann OR assignee:@ann)";
    expect(listSearchQuery({ owner: "o", name: "r" }, { searchQuery: q })).toBe(`type:pr repo:o/r (${q})`);
    expect(searchTerms({ searchQuery: "   " })).toBeNull();
  });

  it("counts filters and normalizes stored values", () => {
    expect(filterCount({ searchQuery: "x", state: "OPEN", sort: "NEWEST" })).toBe(3);
    expect(normalizeSearch({ state: "OPEN", sort: "SIDEWAYS", label: "", author: "ann", extra: 1 })).toEqual({
      state: "OPEN",
      author: "ann",
    });
    expect(normalizeSearch("nope")).toBeNull();
  });

  it("keeps searches with filters in the history, newest first, at most 10", () => {
    let h = withSearch([], { state: "OPEN" });
    expect(h).toEqual([]); // the default
    h = withSearch(h, {});
    expect(h).toEqual([]); // no filters
    h = withSearch(h, { author: "a" });
    h = withSearch(h, { author: "b" });
    h = withSearch(h, { author: "a" });
    expect(h).toEqual([{ author: "a" }, { author: "b" }]);
    for (let i = 0; i < 12; i++) h = withSearch(h, { label: `l${i}` });
    expect(h).toHaveLength(10);
    expect(h[0]).toEqual({ label: "l11" });
  });
});

describe("reviewer states", () => {
  it("lets the newest opinionated review win over later comments", () => {
    expect(reviewerStateOf([review(user("bo"), "APPROVED", 1), review(user("bo"), "COMMENTED", 2)])).toBe("APPROVED");
    expect(reviewerStateOf([review(user("bo"), "APPROVED", 1), review(user("bo"), "CHANGES_REQUESTED", 2)])).toBe(
      "CHANGES_REQUESTED",
    );
  });

  it("surfaces a dismissed latest review as a comment", () => {
    expect(reviewerStateOf([review(user("bo"), "APPROVED", 1), review(user("bo"), "DISMISSED", 2)])).toBe("COMMENTED");
  });

  it("skips reviewers with only pending reviews", () => {
    expect(reviewerStateOf([review(user("bo"), "PENDING", 1)])).toBeNull();
    expect(reviewerStateOf([review(user("bo"), "PENDING", 2), review(user("bo"), "COMMENTED", 1)])).toBe("COMMENTED");
  });

  it("excludes the author and marks requests as re-requested or needing review", () => {
    const states = reviewersStates(
      pr({
        reviews: {
          nodes: [
            review(user("ann"), "COMMENTED", 1),
            review(user("bo"), "APPROVED", 2),
            review(user("cy"), "COMMENTED", 3),
          ],
        },
        reviewRequests: {
          nodes: [{ requestedReviewer: user("cy") }, { requestedReviewer: team }, { requestedReviewer: null }],
        },
      }),
    );
    expect(
      states.map((s) => [s.reviewer.__typename === "Team" ? "team" : (s.reviewer as GHUser).login, s.state]),
    ).toEqual([
      ["bo", "APPROVED"],
      ["cy", "RE_REQUESTED"],
      ["team", "NEEDS_REVIEW"],
    ]);
  });

  it("counts reviews of deleted users under the ghost user", () => {
    const states = reviewersStates(pr({ reviews: { nodes: [review(null, "APPROVED", 1)] } }));
    expect(states).toHaveLength(1);
    expect((states[0]!.reviewer as GHUser).login).toBe("ghost");
  });

  it("orders the row's avatars approved → changes → commented → re-requested → needs review", () => {
    const states = sortedReviewersStates(
      pr({
        reviews: {
          nodes: [
            review(user("c"), "COMMENTED", 1),
            review(user("x"), "CHANGES_REQUESTED", 2),
            review(user("a"), "APPROVED", 3),
          ],
        },
        reviewRequests: { nodes: [{ requestedReviewer: user("n") }] },
      }),
    );
    expect(states.map((s) => s.state)).toEqual(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "NEEDS_REVIEW"]);
  });

  it("counts unresolved, current threads", () => {
    expect(
      unresolvedThreadsCount(
        pr({
          reviewThreads: {
            nodes: [
              { isResolved: false, isOutdated: false },
              { isResolved: true, isOutdated: false },
              { isResolved: false, isOutdated: true },
            ],
          },
        }),
      ),
    ).toBe(1);
  });
});

describe("unread", () => {
  const me = { id: "id-me" };
  const updated = Date.parse("2026-10-01T12:00:00Z");

  it("only applies to pull requests the user wrote or is asked to review", () => {
    expect(isSeen(pr(), me, null)).toBe(true);
    expect(isSeen(pr({ author: user("me") }), me, null)).toBe(false);
    expect(isSeen(pr({ reviewRequests: { nodes: [{ requestedReviewer: user("me") }] } }), me, null)).toBe(false);
  });

  it("compares the last seen time, with a 5 s margin, with the update", () => {
    const mine = pr({ author: user("me") });
    expect(isSeen(mine, me, updated - 4000)).toBe(true);
    expect(isSeen(mine, me, updated - 6000)).toBe(false);
    expect(isSeen(mine, me, updated + 1)).toBe(true);
  });
});

describe("mergeability", () => {
  const data = (over: Partial<GHPullRequestMergeabilityData> = {}): GHPullRequestMergeabilityData => ({
    mergeable: "MERGEABLE",
    canBeRebased: true,
    mergeStateStatus: "CLEAN",
    baseRef: null,
    commits: {
      pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
      nodes: [
        {
          id: "c",
          commit: {
            id: "c",
            oid: "abc",
            abbreviatedOid: "abc",
            status: {
              contexts: [
                { context: "ci/a", state: "SUCCESS", isRequired: true, targetUrl: "u1" },
                { context: "ci/b", state: "ERROR", isRequired: false, targetUrl: null },
              ],
            },
            checkSuites: {
              pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
              nodes: [
                {
                  checkRuns: {
                    pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
                    nodes: [
                      { name: "build", conclusion: null, isRequired: false, detailsUrl: null, url: "run" },
                      { name: "lint", conclusion: "SKIPPED", isRequired: false, detailsUrl: "d", url: "run2" },
                      { name: "test", conclusion: "TIMED_OUT", isRequired: true, detailsUrl: null, url: "run3" },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    },
    ...over,
  });
  const rule = {
    allowsDeletions: false,
    allowsForcePushes: false,
    pattern: "main",
    requiredApprovingReviewCount: 2,
    requiredStatusCheckContexts: ["ci/a"],
    requiresLinearHistory: false,
    requiresSignatures: false,
    viewerCanPush: true,
  };

  it("maps statuses and check runs to CI jobs", () => {
    const s = buildMergeabilityState(data(), false);
    expect(s.ciJobs.map((j) => [j.name, j.status, j.detailsUrl])).toEqual([
      ["ci/a", "SUCCESS", "u1"],
      ["ci/b", "FAILED", null],
      ["build", "PENDING", "run"],
      ["lint", "SKIPPED", "d"],
      ["test", "FAILED", "run3"],
    ]);
    expect(s).toMatchObject({
      hasConflicts: false,
      canBeMerged: true,
      checksState: null,
      requiredApprovingReviewsCount: 0,
    });
  });

  it("follows the merge state and branch protection", () => {
    expect(buildMergeabilityState(data({ mergeable: "UNKNOWN" }), false).hasConflicts).toBeNull();
    expect(buildMergeabilityState(data({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), false)).toMatchObject({
      hasConflicts: true,
      canBeMerged: false,
    });
    const blocked = data({ mergeStateStatus: "BLOCKED", baseRef: { refUpdateRule: rule } });
    expect(buildMergeabilityState(blocked, false)).toMatchObject({
      canBeMerged: false,
      checksState: null,
      requiredApprovingReviewsCount: 2,
    });
    expect(buildMergeabilityState(blocked, true).canBeMerged).toBe(true);
    const failing = data({
      mergeStateStatus: "BLOCKED",
      baseRef: { refUpdateRule: { ...rule, requiredStatusCheckContexts: ["ci/b"] } },
    });
    expect(buildMergeabilityState(failing, false)).toMatchObject({
      checksState: "BLOCKING_FAILING",
      requiredApprovingReviewsCount: 0,
    });
    expect(buildMergeabilityState(data({ mergeStateStatus: "BEHIND" }), false).checksState).toBe("BLOCKING_BEHIND");
    const restricted = data({
      mergeStateStatus: "BLOCKED",
      baseRef: { refUpdateRule: { ...rule, viewerCanPush: false } },
    });
    expect(buildMergeabilityState(restricted, false)).toMatchObject({
      isRestricted: true,
      requiredApprovingReviewsCount: 0,
    });
  });

  it("decides the merge actions from permission, settings and state", () => {
    const repo = {
      viewerPermission: "WRITE" as const,
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
    };
    const state = buildMergeabilityState(data(), false);
    expect(pullRequestPermissions({ viewerDidAuthor: false, state: "OPEN" }, repo, state)).toEqual({
      canManage: true,
      canMerge: true,
      canSquashMerge: false,
      canRebaseMerge: true,
    });
    expect(pullRequestPermissions({ viewerDidAuthor: false, state: "OPEN" }, repo, state, true).canMerge).toBe(false);
    const reader = { ...repo, viewerPermission: "READ" as const };
    expect(pullRequestPermissions({ viewerDidAuthor: true, state: "OPEN" }, reader, state)).toMatchObject({
      canManage: true,
      canMerge: false,
    });
    expect(pullRequestPermissions({ viewerDidAuthor: false, state: "OPEN" }, reader, state).canManage).toBe(false);
    expect(hasPermission("MAINTAIN", "WRITE")).toBe(true);
    expect(hasPermission(null, "READ")).toBe(false);
  });
});

describe("pull request helpers", () => {
  it("names states like IntelliJ", () => {
    expect(stateTagText("OPEN", false)).toBeNull();
    expect(stateTagText("OPEN", true)).toBe("DRAFT");
    expect(stateTagText("MERGED", true)).toBe("MERGED");
    expect(pullRequestStateIcon("OPEN", true)).toBe("github-pr-draft");
    expect(pullRequestStateIcon("CLOSED", false)).toBe("github-pr-closed");
  });

  it("prefills and splits merge commit messages", () => {
    expect(mergeCommitMessage({ number: 7, title: "Fix it" })).toBe("Merge pull request #7\n\nFix it");
    expect(mergeCommitMessage({ number: 7, title: "x" }, ["a", "b"])).toBe("Merge pull request #7\n\n* a\n\n* b");
    expect(splitCommitMessage("Subject\n\nBody\nmore")).toEqual({ title: "Subject", body: "Body\nmore" });
    expect(splitCommitMessage("Only")).toEqual({ title: "Only", body: "" });
  });

  it("shows the owner only when owners differ", () => {
    const a = { owner: "me", name: "app" };
    const b = { owner: "org", name: "app" };
    expect(repositoryDisplayName([a], a)).toBe("app");
    expect(repositoryDisplayName([a, b], a)).toBe("me/app");
    expect(repositoryDisplayName([a, { owner: "me", name: "lib" }], a)).toBe("app");
    expect(repositoryDisplayName([a], a, true)).toBe("me/app");
  });

  it("recognizes github.com remotes", () => {
    for (const url of [
      "https://github.com/o/r.git",
      "https://user@github.com/o/r",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git",
      "ssh://git@github.com:22/o/r.git",
      "git://github.com/o/r",
    ])
      expect(parseGitHubRemote(url), url).toEqual({ owner: "o", name: "r" });
    expect(parseGitHubRemote("https://gitlab.com/o/r.git")).toBeNull();
    expect(parseGitHubRemote("/local/repo")).toBeNull();
    expect(
      githubRemotes([
        { name: "origin", url: "git@github.com:me/r.git" },
        { name: "upstream", url: "https://github.com/org/r.git" },
        { name: "dup", url: "https://github.com/ORG/r" },
        { name: "other", url: "https://example.com/x/y" },
      ]).map((r) => `${r.remote}=${r.owner}/${r.name}`),
    ).toEqual(["origin=me/r", "upstream=org/r"]);
  });
});

describe("batches", () => {
  let pages: Array<{ items: number[]; next: number | null }>;
  beforeEach(() => {
    pages = [
      { items: [1, 2], next: 1 },
      { items: [3], next: null },
    ];
  });

  it("appends pages as they arrive and loads once", async () => {
    let calls = 0;
    const loader = createBatchesLoader<number, number>(0, async (p) => {
      calls++;
      return pages[p]!;
    });
    const all = await loader.load();
    expect(all).toEqual([1, 2, 3]);
    expect(loader.store.getState()).toMatchObject({ items: [1, 2, 3], loading: false, done: true });
    await loader.load();
    expect(calls).toBe(2);
    loader.reset();
    expect(loader.store.getState().items).toEqual([]);
  });

  it("keeps what loaded before a failure and retries on the next load", async () => {
    let fail = true;
    const loader = createBatchesLoader<number, number>(0, async (p) => {
      if (p === 1 && fail) throw new Error("boom");
      return pages[p]!;
    });
    await expect(loader.load()).rejects.toThrow("boom");
    expect(loader.store.getState()).toMatchObject({ items: [1, 2], loading: false, done: false, error: "boom" });
    fail = false;
    expect(await loader.load()).toEqual([1, 2, 3]);
    expect(
      mergeBatches([
        { items: [1], loading: false, done: true, error: null },
        { items: [2], loading: true, done: false, error: null },
      ]),
    ).toEqual({ items: [1, 2], loading: true, done: false, error: null });
  });
});
