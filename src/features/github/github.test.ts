import { describe, expect, it } from "vitest";
import type { GhRepo, PrCheck, PrListQuery, PrReviewComment, PullRequestDetails } from "@/platform/ipc";
import {
  checksSummary,
  checksText,
  diffNotes,
  fileDiffData,
  mergeMessage,
  prActions,
  relativeTime,
  reviewThreads,
  stateLabel,
  statusLines,
} from "./model";
import {
  loadLastSearch,
  loadSearchHistory,
  queryText,
  rememberSearch,
  saveLastSearch,
  withQuery,
} from "./searchHistory";

const comment = (
  id: number,
  path: string,
  line: number | null,
  inReplyTo: number | null = null,
  side = "RIGHT",
): PrReviewComment => ({
  id,
  inReplyTo,
  path,
  line,
  originalLine: line ?? 3,
  side,
  body: `c${id}`,
  author: "ann",
  createdAt: "2026-10-21T10:00:00Z",
  url: "",
  diffHunk: "",
});

const summary = {
  number: 7,
  title: "Fix",
  author: "ann",
  state: "open" as const,
  isDraft: false,
  headRef: "fix",
  baseRef: "main",
  createdAt: "",
  updatedAt: "",
  labels: [],
  reviewDecision: null,
  url: "https://github.com/o/r/pull/7",
  additions: 1,
  deletions: 1,
};

describe("pull request model", () => {
  it("labels states", () => {
    expect(stateLabel(summary)).toBe("Open");
    expect(stateLabel({ ...summary, isDraft: true })).toBe("Draft");
    expect(stateLabel({ ...summary, state: "merged" })).toBe("Merged");
  });

  it("summarises checks", () => {
    const c = (status: PrCheck["status"]): PrCheck => ({ name: status, workflow: null, status, url: null });
    const s = checksSummary([c("failure"), c("success"), c("success"), c("pending"), c("skipped")]);
    expect(s).toEqual({ failed: 1, pending: 1, passed: 2, other: 1 });
    expect(checksText(s)).toBe("1 failing, 1 pending, 2 passed, 1 skipped");
    expect(checksText(checksSummary([]))).toBe("No checks");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(relativeTime("2026-10-21T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-21T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-10-20T12:00:00Z", now)).toBe("1 day ago");
    expect(relativeTime("nonsense", now)).toBe("");
  });

  it("threads replies under their root, ordered by file and line", () => {
    const threads = reviewThreads([
      comment(1, "b.ts", 9),
      comment(2, "a.ts", 5),
      comment(3, "b.ts", 9, 1),
      comment(4, "b.ts", 9, 3),
    ]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      [2, []],
      [1, [3, 4]],
    ]);
  });

  it("turns current comments into diff notes", () => {
    const notes = diffNotes("a.ts", [
      comment(1, "a.ts", 5),
      comment(2, "a.ts", null),
      comment(3, "a.ts", 2, null, "LEFT"),
      comment(4, "b.ts", 1),
    ]);
    expect(notes.map((n) => [n.side, n.line])).toEqual([
      ["right", 4],
      ["left", 1],
    ]);
  });

  it("builds diff data for renamed and added files", () => {
    const pr = { summary, files: [] } as unknown as PullRequestDetails;
    const revs = {
      base: "b".repeat(40),
      head: "h".repeat(40),
      root: "/repo",
      files: [{ path: "src/new.ts", kind: "renamed" as const, oldPath: "src/old.ts" }],
    };
    const renamed = fileDiffData(
      pr,
      { path: "src/new.ts", additions: 1, deletions: 0, changeType: "RENAMED" },
      revs,
      [],
    );
    expect(renamed.path).toBe("/repo/src/new.ts");
    expect(renamed.left).toMatchObject({ type: "rev", rev: revs.base, path: "/repo/src/old.ts" });
    expect(renamed.right).toMatchObject({ type: "rev", rev: revs.head });
    expect(renamed.title).toBe("#7: new.ts");
    const added = fileDiffData(pr, { path: "x.md", additions: 1, deletions: 0, changeType: "ADDED" }, revs, []);
    expect(added.left).toMatchObject({ type: "text", text: "" });
  });
});

const details = (patch: Partial<PullRequestDetails> = {}): PullRequestDetails => ({
  summary,
  body: "",
  headOid: "h".repeat(40),
  baseOid: "b".repeat(40),
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  isCrossRepository: false,
  mergedAt: null,
  closedAt: null,
  checks: [],
  reviewers: [],
  assignees: [],
  commits: [],
  files: [],
  timeline: [],
  ...patch,
});

const repo: GhRepo = {
  nameWithOwner: "o/r",
  url: "https://github.com/o/r",
  defaultBranch: "main",
  mergeCommitAllowed: true,
  squashMergeAllowed: false,
  rebaseMergeAllowed: true,
  viewerPermission: "WRITE",
};

describe("pull request actions", () => {
  it("offers the merge methods the repository allows when the merge box is clean", () => {
    const a = prActions(details(), repo, "bob");
    expect([a.merge, a.squash, a.rebase, a.asAdmin]).toEqual([true, false, true, false]);
    expect([a.close, a.reopen, a.ready, a.requestReview, a.setMyselfAsReviewer]).toEqual([
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it("does not merge blocked or conflicting pull requests, except as an administrator", () => {
    const blocked = details({ mergeStateStatus: "BLOCKED" });
    expect(prActions(blocked, repo, "bob").merge).toBe(false);
    const admin = prActions(blocked, { ...repo, viewerPermission: "ADMIN" }, "bob");
    expect([admin.merge, admin.asAdmin]).toEqual([true, true]);
    const dirty = prActions(details({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), repo, "bob");
    expect([dirty.merge, dirty.rebase]).toEqual([false, false]);
  });

  it("leaves merging to writers and managing to triagers or the author", () => {
    const reader = { ...repo, viewerPermission: "READ" };
    const guest = prActions(details(), reader, "bob");
    expect([guest.merge, guest.close, guest.requestReview, guest.setMyselfAsReviewer]).toEqual([
      false,
      false,
      false,
      true,
    ]);
    const author = prActions(details({ summary: { ...summary, isDraft: true } }), reader, "ann");
    expect([author.close, author.ready, author.setMyselfAsReviewer]).toEqual([true, true, false]);
  });

  it("offers reopening closed pull requests and nothing for merged ones", () => {
    const closed = prActions(details({ summary: { ...summary, state: "closed" } }), repo, "bob");
    expect([closed.reopen, closed.close, closed.merge]).toEqual([true, false, false]);
    const merged = prActions(details({ summary: { ...summary, state: "merged" } }), repo, "bob");
    expect(Object.values(merged).some(Boolean)).toBe(false);
  });

  it("does not offer Set Myself as Reviewer to a reviewer", () => {
    const pr = details({ reviewers: [{ login: "bob", state: "REQUESTED" }] });
    expect(prActions(pr, repo, "bob").setMyselfAsReviewer).toBe(false);
  });

  it("prefills merge and squash commit messages", () => {
    const pr = details({
      commits: [
        { oid: "1", headline: "one", body: "", author: "ann", date: "" },
        { oid: "2", headline: "two", body: "", author: "ann", date: "" },
      ],
    });
    expect(mergeMessage(pr, false)).toEqual({ subject: "Merge pull request #7 from fix", body: "Fix" });
    expect(mergeMessage(pr, true)).toEqual({ subject: "Fix (#7)", body: "* one\n\n* two" });
  });

  it("summarises checks, conflicts and reviews", () => {
    const c = (status: PrCheck["status"]): PrCheck => ({ name: status, workflow: null, status, url: null });
    const pr = details({
      checks: [c("success"), c("success")],
      reviewers: [
        { login: "zoe", state: "APPROVED" },
        { login: "kim", state: "REQUESTED" },
      ],
    });
    expect(statusLines(pr)).toEqual([
      { status: "success", text: "All checks have passed" },
      { status: "success", text: "Approved by zoe" },
      { status: "warning", text: "Waiting for review from kim" },
    ]);
    const conflicting = details({ mergeable: "CONFLICTING", checks: [c("failure")] });
    expect(statusLines(conflicting).map((l) => l.status)).toEqual(["failure", "failure"]);
    expect(statusLines(details({ summary: { ...summary, state: "merged" } }))).toEqual([]);
  });
});

describe("pull request search history", () => {
  const defaults: PrListQuery = {
    state: "open",
    authorMe: false,
    reviewRequested: false,
    assigneeMe: false,
    search: "",
    limit: 100,
  };
  const q = (patch: Partial<PrListQuery>): PrListQuery => ({ ...defaults, ...patch });

  it("keeps the newest search first, once, and never the default filter", () => {
    let h = withQuery([], q({ search: "fix" }), defaults);
    h = withQuery(h, q({ authorMe: true }), defaults);
    h = withQuery(h, q({ search: " fix " }), defaults);
    h = withQuery(h, defaults, defaults);
    expect(h.map(queryText)).toEqual(['state:"Open" "fix"', 'state:"Open" author:@me']);
    for (let i = 0; i < 15; i++) h = withQuery(h, q({ search: `s${i}` }), defaults);
    expect(h).toHaveLength(10);
    expect(h[0]!.search).toBe("s14");
  });

  it("shows searches as IDEA's filter text", () => {
    expect(queryText(q({ state: "merged", reviewRequested: true, search: "label:bug" }))).toBe(
      'state:"Merged" review-requested:@me "label:bug"',
    );
    expect(queryText(q({ search: 'is:pr "exact"' }))).toBe('state:"Open" is:pr "exact"');
  });

  it("persists the history and the last search per project", () => {
    rememberSearch("/a", q({ search: "one" }), defaults);
    rememberSearch("/b", q({ search: "two" }), defaults);
    saveLastSearch("/a", q({ state: "closed" }));
    expect(loadSearchHistory("/a", defaults).map((h) => h.search)).toEqual(["one"]);
    expect(loadSearchHistory("/b", defaults).map((h) => h.search)).toEqual(["two"]);
    expect(loadLastSearch("/a", defaults)?.state).toBe("closed");
    expect(loadLastSearch("/b", defaults)).toBeNull();
    expect(loadSearchHistory(null, defaults)).toEqual([]);
  });

  it("ignores stored entries that are not queries", () => {
    localStorage.setItem("openidea.github.searchHistory.v1:/c", JSON.stringify([{ state: "bogus" }, 3, q({})]));
    expect(loadSearchHistory("/c", defaults)).toHaveLength(1);
  });
});
