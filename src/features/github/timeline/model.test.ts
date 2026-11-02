import { describe, expect, it } from "vitest";
import type { GHActor, GHLabel, GHPRTimelineItem, GHPullRequestReviewThread, GHUser } from "../api/types";
import {
  buildSuggestionPatch,
  filterMentions,
  groupReactions,
  hunkLineNumbers,
  insertMention,
  mentionQuery,
  mergeTimeline,
  parsePatchHunk,
  reviewStatus,
  splitSuggestions,
  suggestionDisabledReason,
  suggestionTarget,
  threadDiffWithAnchor,
  toggleReactionLocally,
  truncateHunkBefore,
  type SimpleGroup,
  type StateGroup,
} from "./model";

const user = (login: string, name: string | null = null): GHUser => ({
  __typename: "User",
  id: `id-${login}`,
  login,
  url: `https://github.com/${login}`,
  avatarUrl: "",
  name,
});
const alice = user("alice");
const bob = user("bob");
const label = (name: string): GHLabel => ({ id: `l-${name}`, url: "", name, color: "ff0000" });
const at = (min: number) => new Date(Date.UTC(2024, 0, 1, 12, min)).toISOString();

const ev = (type: string, actor: GHActor | null, min: number, extra: object = {}) =>
  ({ __typename: type, actor, createdAt: at(min), ...extra }) as GHPRTimelineItem;
const commit = (id: string): GHPRTimelineItem => ({
  __typename: "PullRequestCommit",
  id,
  url: "",
  commit: { id, oid: id, abbreviatedOid: id.slice(0, 7), url: "", messageHeadline: id, author: null },
});

describe("mergeTimeline", () => {
  it("groups consecutive commits", () => {
    const out = mergeTimeline([commit("a"), commit("b"), ev("ClosedEvent", alice, 0), commit("c")]);
    expect(out.map((e) => e.kind)).toEqual(["commits", "state", "commits"]);
    expect(out[0]).toMatchObject({ commits: [{ id: "a" }, { id: "b" }] });
  });

  it("merges simple events of one actor within 2 minutes", () => {
    const out = mergeTimeline([
      ev("LabeledEvent", alice, 0, { label: label("bug") }),
      ev("AssignedEvent", alice, 1, { user: bob }),
      ev("LabeledEvent", alice, 4, { label: label("ui") }),
      ev("LabeledEvent", bob, 4, { label: label("x") }),
    ]);
    expect(out).toHaveLength(3);
    const first = out[0] as SimpleGroup;
    expect(first.count).toBe(2);
    expect(first.addedLabels.map((l) => l.name)).toEqual(["bug"]);
    expect(first.assigned.map((u) => u.login)).toEqual(["bob"]);
    expect((out[1] as SimpleGroup).addedLabels.map((l) => l.name)).toEqual(["ui"]);
  });

  it("drops merged events that cancel out", () => {
    const out = mergeTimeline([
      ev("LabeledEvent", alice, 0, { label: label("bug") }),
      ev("UnlabeledEvent", alice, 1, { label: label("bug") }),
      ev("ClosedEvent", bob, 5),
      ev("ReopenedEvent", bob, 5),
    ]);
    expect(out).toEqual([]);
  });

  it("keeps a single event even without changes and tracks renames", () => {
    const out = mergeTimeline([
      ev("RenamedTitleEvent", alice, 0, { previousTitle: "a", currentTitle: "b" }),
      ev("RenamedTitleEvent", alice, 1, { previousTitle: "b", currentTitle: "c" }),
    ]);
    expect((out[0] as SimpleGroup).rename).toEqual(["a", "c"]);
  });

  it("keeps merged as the state of merged state events", () => {
    const merged = ev("MergedEvent", alice, 0, { mergedEventCommit: null, mergeRefName: "main" });
    const out = mergeTimeline([merged, ev("ClosedEvent", alice, 1)]);
    expect((out[0] as StateGroup).newState).toBe("MERGED");
    expect((out[0] as StateGroup).last).toBe(merged);
  });

  it("hides unknown items unless asked", () => {
    const items: GHPRTimelineItem[] = [{ __typename: "Unknown", type: "PinnedEvent" }];
    expect(mergeTimeline(items)).toEqual([]);
    expect(mergeTimeline(items, true)).toMatchObject([{ kind: "unknown", type: "PinnedEvent" }]);
  });

  it("does not merge across comments", () => {
    const comment = { __typename: "IssueComment", id: "c1" } as unknown as GHPRTimelineItem;
    const out = mergeTimeline([
      ev("AssignedEvent", alice, 0, { user: bob }),
      comment,
      ev("AssignedEvent", alice, 0, { user: alice }),
    ]);
    expect(out.map((e) => e.kind)).toEqual(["simple", "comment", "simple"]);
  });
});

describe("reviewStatus", () => {
  it("maps states to IntelliJ's texts", () => {
    expect(reviewStatus("APPROVED")).toEqual({ text: "approved the changes", type: "SUCCESS" });
    expect(reviewStatus("CHANGES_REQUESTED").type).toBe("ERROR");
    expect(reviewStatus("PENDING").text).toBe("started a review");
    expect(reviewStatus("DISMISSED").text).toBe("reviewed the changes");
  });
});

const HUNK = ["@@ -10,4 +10,5 @@ class A", " a", "-b", "+B", "+B2", " c", " d"].join("\n");

describe("hunks", () => {
  it("parses and numbers a hunk", () => {
    const h = parsePatchHunk(HUNK)!;
    expect(h.startLineBefore).toBe(9);
    expect(h.lines.map((l) => l.type)).toEqual(["CONTEXT", "REMOVE", "ADD", "ADD", "CONTEXT", "CONTEXT"]);
    expect(hunkLineNumbers(h)).toEqual([
      [10, 10],
      [11, null],
      [null, 11],
      [null, 12],
      [12, 13],
      [13, 14],
    ]);
  });

  it("truncates before an index", () => {
    const h = truncateHunkBefore(parsePatchHunk(HUNK)!, 2);
    expect(h.startLineBefore).toBe(11);
    expect(h.startLineAfter).toBe(10);
    expect(h.lines).toHaveLength(4);
  });

  it("keeps the anchor and 3 lines of context before it", () => {
    const d = threadDiffWithAnchor({
      diffHunk: HUNK,
      diffSide: "RIGHT",
      originalLine: 14,
      startDiffSide: null,
      originalStartLine: null,
    })!;
    expect(d.hunk.lines).toHaveLength(4);
    expect(d.anchor).toEqual([3, 4]);
  });

  it("anchors a multi-line range", () => {
    const d = threadDiffWithAnchor({
      diffHunk: HUNK,
      diffSide: "RIGHT",
      originalLine: 14,
      startDiffSide: "RIGHT",
      originalStartLine: 13,
    })!;
    expect(d.anchor).toEqual([3, 5]);
    expect(d.hunk.lines).toHaveLength(5);
  });

  it("has no diff for an empty hunk", () => {
    expect(
      threadDiffWithAnchor({
        diffHunk: "",
        diffSide: "RIGHT",
        originalLine: 1,
        startDiffSide: null,
        originalStartLine: null,
      }),
    ).toBeNull();
  });
});

describe("suggestions", () => {
  const thread = {
    isResolved: false,
    path: "src/a.ts",
    line: 12,
    startLine: 11,
    originalLine: 12,
    originalStartLine: 11,
    diffHunk: HUNK,
  } satisfies Partial<GHPullRequestReviewThread> & { diffHunk: string };

  it("splits a body into Markdown and suggestion blocks", () => {
    expect(splitSuggestions("Use this:\n```suggestion\nB\nC\n```\nthanks")).toEqual([
      { type: "markdown", text: "Use this:" },
      { type: "suggestion", lines: ["B", "C"] },
      { type: "markdown", text: "thanks" },
    ]);
    expect(splitSuggestions("```suggestion\nx")).toEqual([{ type: "markdown", text: "```suggestion\nx" }]);
  });

  it("finds the commented code and the applicability", () => {
    const t = suggestionTarget(thread);
    expect(t).toMatchObject({ applicability: "APPLICABLE", startLineIndex: 10, endLineIndex: 11 });
    expect(t.originalLines).toEqual(["B", "B2"]);
    expect(suggestionTarget({ ...thread, line: null }).applicability).toBe("OUTDATED");
    expect(suggestionTarget({ ...thread, isResolved: true }).applicability).toBe("RESOLVED");
    expect(suggestionDisabledReason("APPLICABLE", false)).toMatch(/different branch/);
    expect(suggestionDisabledReason("APPLICABLE", true)).toBeNull();
  });

  it("builds a patch with context against the local file", () => {
    const text = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "B", "B2", "c", "d"].join("\n") + "\n";
    const r = buildSuggestionPatch(text, suggestionTarget(thread), ["X"]);
    expect(r.start).toBe(10);
    expect(r.patch).toBe(
      ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -8,7 +8,6 @@", " 8", " 9", " a", "-B", "-B2", "+X", " c", " d", ""].join(
        "\n",
      ),
    );
  });

  it("finds moved code and fails when it is gone", () => {
    const moved = ["0", "a", "B", "B2", "c"].join("\n");
    const r = buildSuggestionPatch(moved, suggestionTarget(thread), ["X"]);
    expect(r.start).toBe(2);
    expect(r.patch).toContain("\\ No newline at end of file");
    expect(() => buildSuggestionPatch("nothing\n", suggestionTarget(thread), ["X"])).toThrow(/does not apply/);
  });

  it("keeps CRLF line ends", () => {
    const r = buildSuggestionPatch("a\r\nB\r\nB2\r\n", suggestionTarget(thread), ["X"]);
    expect(r.patch).toContain("-B\r\n");
    expect(r.patch).toContain("+X\r\n");
  });
});

describe("reactions", () => {
  it("groups by content and marks the viewer's", () => {
    const rs = [
      { content: "HEART" as const, user: alice },
      { content: "EYES" as const, user: bob },
      { content: "HEART" as const, user: bob },
    ];
    const g = groupReactions(rs, bob.id);
    expect(g.map((r) => [r.content, r.users.length, r.isReactedByCurrentUser])).toEqual([
      ["HEART", 2, true],
      ["EYES", 1, true],
    ]);
    expect(groupReactions(toggleReactionLocally(rs, "HEART", bob, false), bob.id)[0]!.users).toHaveLength(1);
  });
});

describe("mentions", () => {
  it("finds the query before the caret", () => {
    expect(mentionQuery("hi @al", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail@x", 6)).toBeNull();
    expect(mentionQuery("hi @al ", 7)).toBeNull();
  });

  it("filters and inserts", () => {
    const users = [user("bob", "Alice Bobson"), user("alice"), user("malik")];
    expect(filterMentions(users, "al").map((u) => u.login)).toEqual(["alice", "bob", "malik"]);
    expect(insertMention("hi @al!", 3, 6, "alice")).toEqual({ text: "hi @alice !", caret: 10 });
  });
});
