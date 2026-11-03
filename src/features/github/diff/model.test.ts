import { describe, expect, it } from "vitest";
import type { GHPullRequestReviewComment, GHPullRequestReviewThread } from "../api/types";
import {
  adjacentThread,
  commentableRanges,
  diffPosition,
  draftThread,
  isThreadVisible,
  mapAcrossPatch,
  newCommentLocation,
  parsePatch,
  submitActions,
  threadLocation,
  threadOrder,
} from "./model";
import { parseReviewDiffSettings } from "./settings";

// a.ts: line 2 changed, line 4 added; 20 lines later one removed.
const PATCH = [
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "+three and a half",
  " four",
  "@@ -20,3 +21,2 @@ function x() {",
  " twenty",
  "-twenty-one",
  " twenty-two",
].join("\n");

const comment = (over: Partial<GHPullRequestReviewComment> = {}): GHPullRequestReviewComment =>
  ({
    id: "C1",
    author: null,
    body: "",
    createdAt: "2026-10-01T10:00:00Z",
    url: "",
    state: "SUBMITTED",
    commit: { oid: "head", abbreviatedOid: "head" },
    originalCommit: { oid: "c1", abbreviatedOid: "c1" },
    diffHunk: "",
    pullRequestReview: null,
    viewerCanDelete: false,
    viewerCanUpdate: false,
    viewerCanReact: false,
    reactions: { nodes: [] },
    ...over,
  }) as GHPullRequestReviewComment;

const thread = (over: Partial<GHPullRequestReviewThread> = {}, c = comment()): GHPullRequestReviewThread => ({
  id: "T1",
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  subjectType: "LINE",
  diffSide: "RIGHT",
  line: 3,
  originalLine: 2,
  startDiffSide: null,
  startLine: null,
  originalStartLine: null,
  comments: { nodes: [c] },
  viewerCanReply: true,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  ...over,
});

describe("patches", () => {
  it("parses hunks with 0-based starts", () => {
    const hunks = parsePatch(PATCH + "\n");
    expect(hunks.map(({ rows: _r, ...h }) => h)).toEqual([
      { leftStart: 0, leftCount: 4, rightStart: 0, rightCount: 5 },
      { leftStart: 19, leftCount: 3, rightStart: 20, rightCount: 2 },
    ]);
    expect(hunks[1]!.rows).toEqual([" twenty", "-twenty-one", " twenty-two"]);
    expect(parsePatch(null)).toEqual([]);
  });

  it("takes every hunk line of a side as commentable (`patch.ranges`)", () => {
    expect(commentableRanges(parsePatch(PATCH))).toEqual({
      left: [
        { start: 0, end: 4 },
        { start: 19, end: 22 },
      ],
      right: [
        { start: 0, end: 5 },
        { start: 20, end: 22 },
      ],
    });
    // A new file has no left side.
    expect(commentableRanges(parsePatch("@@ -0,0 +1,2 @@\n+a\n+b")).left).toEqual([]);
  });

  it("maps lines across the patch", () => {
    const hunks = parsePatch(PATCH);
    expect(mapAcrossPatch(hunks, "left", 0)).toBe(0);
    expect(mapAcrossPatch(hunks, "left", 2)).toBe(2); // "three"
    expect(mapAcrossPatch(hunks, "left", 3)).toBe(4); // "four"
    expect(mapAcrossPatch(hunks, "right", 3)).toBe(3); // the added line: before "four"
    expect(mapAcrossPatch(hunks, "left", 10)).toBe(11); // between the hunks: +1
    expect(mapAcrossPatch(hunks, "left", 21)).toBe(21); // "twenty-two"
    expect(mapAcrossPatch(hunks, "left", 30)).toBe(30); // after: +1 -1
    expect(mapAcrossPatch(hunks, "right", 30)).toBe(30);
  });

  it("finds GitHub's diff position of a line", () => {
    expect(diffPosition(PATCH, "right", 0)).toBe(1);
    expect(diffPosition(PATCH, "left", 1)).toBe(2);
    expect(diffPosition(PATCH, "right", 1)).toBe(3);
    expect(diffPosition(PATCH, "right", 3)).toBe(5);
    // The second header counts as a row.
    expect(diffPosition(PATCH, "left", 20)).toBe(9);
    expect(diffPosition(PATCH, "right", 21)).toBe(10);
    expect(diffPosition(PATCH, "right", 10)).toBeNull();
  });
});

describe("threads in a diff", () => {
  it("places current threads of the changes at their lines", () => {
    expect(threadLocation(thread(), { commit: null })).toEqual({
      side: "right",
      line: 2,
      startSide: "right",
      startLine: 2,
    });
    expect(
      threadLocation(thread({ diffSide: "LEFT", line: 5, startLine: 3, startDiffSide: "LEFT" }), { commit: null }),
    ).toEqual({ side: "left", line: 4, startSide: "left", startLine: 2 });
    // Outdated and file threads have no line.
    expect(threadLocation(thread({ line: null, isOutdated: true }), { commit: null })).toBeNull();
    expect(threadLocation(thread({ subjectType: "FILE" }), { commit: null })).toBeNull();
  });

  it("places right-side threads of a commit's diff at their original lines", () => {
    expect(threadLocation(thread(), { commit: "c1" })).toEqual({
      side: "right",
      line: 1,
      startSide: "right",
      startLine: 1,
    });
    expect(threadLocation(thread(), { commit: "head" })?.line).toBe(2);
    expect(threadLocation(thread(), { commit: "other" })).toBeNull();
    expect(threadLocation(thread({ diffSide: "LEFT" }), { commit: "c1" })).toBeNull();
  });

  it("filters by Show Review Threads", () => {
    const resolved = { isResolved: true };
    expect(isThreadVisible(resolved, "all")).toBe(true);
    expect(isThreadVisible(resolved, "unresolved")).toBe(false);
    expect(isThreadVisible({ isResolved: false }, "unresolved")).toBe(true);
    expect(isThreadVisible({ isResolved: false }, "none")).toBe(false);
  });
});

describe("new comments", () => {
  it("builds the GitHub input of single- and multi-line comments", () => {
    expect(draftThread("a.ts", newCommentLocation("right", 4, 4), "hi")).toEqual({
      body: "hi",
      path: "a.ts",
      line: 5,
      side: "RIGHT",
      startLine: null,
      startSide: null,
    });
    expect(draftThread("a.ts", newCommentLocation("left", 6, 2), "x")).toMatchObject({
      line: 7,
      side: "LEFT",
      startLine: 3,
      startSide: "LEFT",
    });
  });

  it("offers Add Review Comment with a pending review, else the preferred of Start Review / Add Single Comment", () => {
    expect(submitActions(true, false)).toEqual(["reviewComment"]);
    expect(submitActions(false, true)).toEqual(["startReview", "singleComment"]);
    expect(submitActions(false, false)).toEqual(["singleComment", "startReview"]);
  });

  it("parses the stored settings with IntelliJ's defaults", () => {
    expect(parseReviewDiffSettings(null)).toEqual({
      threadsView: "unresolved",
      reviewCommentsPreferred: true,
      autoMarkViewed: false,
    });
    expect(parseReviewDiffSettings({ threadsView: "none", autoMarkViewed: true, reviewCommentsPreferred: 1 })).toEqual({
      threadsView: "none",
      reviewCommentsPreferred: true,
      autoMarkViewed: true,
    });
  });
});

describe("Previous / Next Comment", () => {
  const files = [
    { path: "a.ts", hunks: parsePatch(PATCH) },
    { path: "b.ts", hunks: [] },
  ];
  const threads = [
    thread({ id: "b1", path: "b.ts", line: 1 }),
    thread({ id: "a-right", line: 5 }),
    thread({ id: "a-left", diffSide: "LEFT", line: 2 }),
    thread({ id: "a-first", line: 1 }),
    thread({ id: "outdated", line: null }),
    thread({ id: "elsewhere", path: "c.ts" }),
  ];
  const order = threadOrder(files, threads);

  it("orders threads by file, right line, left line", () => {
    expect(order.map((p) => p.id)).toEqual(["a-first", "a-left", "a-right", "b1"]);
    expect(order[1]).toMatchObject({ side: "left", line: 1, left: 1, right: 1 });
  });

  it("moves from a thread or from the caret, skipping hidden threads", () => {
    expect(adjacentThread(order, { id: "a-first" }, 1)?.id).toBe("a-left");
    expect(adjacentThread(order, { id: "a-first" }, -1)).toBeNull();
    expect(adjacentThread(order, { id: "a-left" }, 1, (id) => id !== "a-right")?.id).toBe("b1");
    // The caret's line counts: the thread on it is the next and the previous one.
    expect(adjacentThread(order, { file: 0, left: 3, right: 4 }, 1)?.id).toBe("a-right");
    expect(adjacentThread(order, { file: 0, left: 3, right: 4 }, -1)?.id).toBe("a-right");
    expect(adjacentThread(order, { file: 0, left: 3, right: 3 }, -1)?.id).toBe("a-left");
    expect(adjacentThread(order, { file: 1, left: 9, right: 9 }, 1)).toBeNull();
  });
});
