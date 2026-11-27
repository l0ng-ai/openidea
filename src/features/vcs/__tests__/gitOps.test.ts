import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, Commit, FileStatus } from "@/bindings";

const vcsStatus = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStatus: () => vcsStatus(),
      vcsBranchInfo: async () => ({ status: "ok", data: info() }),
      vcsRoots: async () => ({ status: "ok", data: [{ root: "/p", operation: null }] }),
    },
  };
});

import { addToVcsTargets, rollbackPlan } from "../changeOps";
import { planCommit, renamedFromPath } from "../changes";
import { refsSignature } from "../logStore";
import { newestFirst } from "../operations";
import {
  combineRebaseRows,
  combinedCommitMessage,
  headPushed,
  initialRows,
  moveRebaseRows,
  nativePlanProblem,
  nativePlanReply,
  nativePlanRows,
  planIsNoop,
  planProblem,
  rebaseRange,
  rebaseRowKey,
  rebaseRowsMatch,
  setRebaseRowAction,
  singleCommitPlan,
  squashPlan,
  toEntries,
  undoCommitProblem,
} from "../rebasePlan";
import { refreshNow, useVcs } from "../store";

const info = (patch: Partial<BranchInfo> = {}): BranchInfo => ({
  head: "main",
  headCommit: "c3",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  ...patch,
});

const commit = (id: string, parents: string[] = [], summary = id): Commit => ({
  id,
  shortId: id.slice(0, 8),
  parents,
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary,
  message: summary,
  refs: [],
});

const fs = (rel: string, patch: Partial<FileStatus> = {}): FileStatus => ({
  path: `/p/${rel}`,
  relPath: rel,
  staged: null,
  unstaged: null,
  renamedFrom: null,
  ...patch,
});

const branch = (name: string, commitId: string, remote = false): Branch => ({
  name,
  remote,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: commitId,
});

describe("commit plan and rollback with renames", () => {
  const renamed = fs("src/new.ts", { staged: "renamed", renamedFrom: "src/old.ts" });

  it("resolves the absolute source of a rename", () => {
    expect(renamedFromPath(renamed)).toBe("/p/src/old.ts");
    expect(renamedFromPath(fs("a.ts"))).toBeNull();
  });

  it("leaves both sides of an excluded rename out so the deletion is not committed alone", () => {
    const plan = planCommit([renamed], new Map([[renamed.path, "none"]]));
    expect(plan.exclude).toEqual(["/p/src/new.ts", "/p/src/old.ts"]);
    expect(plan.included).toEqual([]);
  });

  it("rolls back renames on both paths and keeps added files unless asked", () => {
    const added = fs("added.ts", { staged: "added" });
    const modified = fs("m.ts", { staged: "modified", unstaged: "modified" });
    const conflicted = fs("c.ts", { unstaged: "conflicted" });
    expect(rollbackPlan([renamed, added, modified, conflicted], false)).toEqual({
      unstage: ["/p/src/new.ts", "/p/src/old.ts", "/p/added.ts", "/p/m.ts"],
      discard: ["/p/src/new.ts", "/p/src/old.ts", "/p/m.ts", "/p/c.ts"],
    });
    expect(rollbackPlan([added], true).discard).toEqual(["/p/added.ts"]);
  });
});

describe("Add to VCS", () => {
  it("adds only unversioned files, also below a selected directory", () => {
    const status = [
      fs("dir/new.ts", { unstaged: "untracked" }),
      fs("dir/sub/n2.ts", { unstaged: "untracked" }),
      fs("dir/tracked.ts", { unstaged: "modified" }),
      fs("other.ts", { unstaged: "untracked" }),
    ];
    expect(addToVcsTargets(["/p/dir"], status)).toEqual(["/p/dir/new.ts", "/p/dir/sub/n2.ts"]);
    expect(addToVcsTargets(["/p/dir/tracked.ts", "/p/other.ts"], status)).toEqual(["/p/other.ts"]);
    expect(addToVcsTargets(["/p/di"], status)).toEqual([]);
  });
});

describe("Undo Commit", () => {
  it("is offered for the latest non-merge commit only", () => {
    expect(undoCommitProblem(commit("c3", ["c2"]), info())).toBeNull();
    expect(undoCommitProblem(commit("c2", ["c1"]), info())).toMatch(/latest commit/);
    expect(undoCommitProblem(commit("c3", ["c2", "x"]), info())).toMatch(/merge commit/);
    expect(undoCommitProblem(commit("c3", ["c2"]), info({ operation: "rebase" }))).toMatch(/rebase is in progress/);
    expect(undoCommitProblem(commit("c3"), info())).toBeNull();
    expect(undoCommitProblem(commit("c3"), info({ head: null }))).toMatch(/detached/);
  });

  it("warns when HEAD is already pushed", () => {
    expect(headPushed(info({ upstream: "origin/main", ahead: 0 }))).toBe(true);
    expect(headPushed(info({ upstream: "origin/main", ahead: 1 }))).toBe(false);
    expect(headPushed(info())).toBe(false);
  });
});

describe("interactive rebase plan", () => {
  it("reorders Git's real commands and preserves comments, abbreviations and line endings", () => {
    const text = "p abcd # A\r\n\r\n  f -C 1234 # amend! A\r\n# Git instructions\r\n";
    const data = [
      {
        kind: "commit",
        line: 0,
        action: "pick",
        id: "abcd0000",
        revision: "abcd",
        author: "A",
        summary: "A",
        message: "A\n\nBody",
      },
      {
        kind: "commit",
        line: 2,
        action: "fixup",
        fixupMessage: "replace",
        id: "12340000",
        revision: "1234",
        author: "B",
        summary: "amend! A",
        message: "amend! A\n\nReplacement\n\n# Details",
      },
    ] as const;
    const rows = nativePlanRows(data);
    expect(nativePlanReply(text, data, rows)).toEqual({ text, rewords: {} });
    const edited = setRebaseRowAction(rows, new Set(["12340000"]), "fixup", "edit");
    expect(rebaseRowsMatch(rows, edited)).toBe(false);
    expect(nativePlanReply(text, data, edited).text).toBe(text.replace("f -C", "f -c"));
    const plain = setRebaseRowAction(rows, new Set(["12340000"]), "fixup");
    expect(nativePlanReply(text, data, plain).text).toBe(text.replace("f -C", "f"));
    const rewordedRoot = setRebaseRowAction(rows, new Set(["abcd0000"]), "reword");
    expect(nativePlanReply(text, data, rewordedRoot)).toEqual({
      text: "reword abcd # A\r\n\r\n  f 1234 # amend! A\r\n# Git instructions\r\n",
      rewords: { abcd0000: "Replacement\n\n# Details" },
    });
    const moved = moveRebaseRows(rows, new Set(["12340000"]), -1);
    expect(moved[0]?.action).toBe("pick");
    if (moved[0]?.action === "pick") moved[0] = { ...moved[0], action: "reword", message: "Prepared message" };
    expect(nativePlanProblem(moved)).toBeNull();
    expect(nativePlanReply(text, data, moved)).toEqual({
      text: "  reword 1234 # amend! A\r\n\r\np abcd # A\r\n# Git instructions\r\n",
      rewords: { "12340000": "Prepared message" },
    });
  });

  it("moves a ref update through command slots while preserving its name and excluding it from commit actions", () => {
    const text = "p a111 # A\n  u refs/heads/review\n\np b222 # B\n# Help\n";
    const plan = [
      {
        kind: "commit",
        line: 0,
        action: "pick",
        id: "a1110000",
        revision: "a111",
        author: "A",
        summary: "A",
        message: "A",
      },
      { kind: "updateRef", line: 1, reference: "refs/heads/review" },
      {
        kind: "commit",
        line: 3,
        action: "pick",
        id: "b2220000",
        revision: "b222",
        author: "B",
        summary: "B",
        message: "B",
      },
    ] as const;
    const rows = nativePlanRows(plan);
    const key = rebaseRowKey(rows[1]!);
    const moved = moveRebaseRows(rows, new Set([key]), 1);
    expect(nativePlanReply(text, plan, moved).text).toBe("p a111 # A\np b222 # B\n\n  u refs/heads/review\n# Help\n");
    expect(setRebaseRowAction(rows, new Set(rows.map(rebaseRowKey)), "drop").map((row) => row.action)).toEqual([
      "drop",
      "updateRef",
      "drop",
    ]);
    expect(combineRebaseRows(rows, new Set(rows.map(rebaseRowKey)), "squash").rows).toBe(rows);
    expect(nativePlanProblem([rows[1]!, { ...initialRows([commit("x")])[0]!, action: "fixup" }])).toMatch(/fixed up/);
  });
  const history = [commit("c4", ["c3"]), commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1")];

  it("takes the commits from the target to HEAD, oldest first", () => {
    const range = rebaseRange(history[2]!, history);
    expect(range).toEqual({ base: "c1", commits: [history[2], history[1], history[0]] });
    expect(rebaseRange(history[3]!, history)).toMatchObject({ base: null });
    expect(rebaseRange(commit("zz", ["c1"]), history)).toEqual({ error: "The commit is not in the current branch" });
    const merged = [commit("m", ["c2", "x"]), ...history.slice(2)];
    expect(rebaseRange(history[2]!, merged)).toMatchObject({ error: expect.stringMatching(/merge commits/) });
  });

  it("validates, reorders and serialises the plan", () => {
    const commits = [history[2]!, history[1]!, history[0]!];
    let rows = initialRows(commits);
    expect(planIsNoop(rows, commits)).toBe(true);
    expect(planProblem(rows)).toBeNull();
    rows = moveRebaseRows(rows, new Set(["c4"]), -1).filter((row) => row.action !== "updateRef");
    expect(rows.map(rebaseRowKey)).toEqual(["c2", "c4", "c3"]);
    expect(moveRebaseRows(rows, new Set(["c2"]), -1)).toBe(rows);
    expect(planIsNoop(rows, commits)).toBe(false);

    rows = rows.map((r, i) => (i === 0 ? { ...r, action: "squash" as const } : r));
    expect(planProblem(rows)).toMatch(/first commit cannot be squashed/);
    rows = rows.map((r, i) => (i === 0 ? { ...r, action: "drop" as const } : r));
    expect(planProblem(rows)).toBeNull();
    rows = rows.map((r, i) => (i === 1 ? { ...r, action: "fixup" as const } : r));
    expect(planProblem(rows)).toMatch(/fixed up/);
    rows = rows.map((r, i) => (i === 1 ? { ...r, action: "reword" as const, message: "  " } : r));
    expect(planProblem(rows)).toMatch(/needs a message/);
    rows = rows.map((r, i) => (i === 1 ? { ...r, message: " new message " } : r));
    expect(toEntries(rows)).toEqual([
      { commit: "c2", action: "drop", message: null },
      { commit: "c4", action: "reword", message: "new message" },
      { commit: "c3", action: "pick", message: null },
    ]);
    expect(planProblem(rows.map((r) => ({ ...r, action: "drop" as const })))).toMatch(/At least one/);
  });

  it("moves noncontiguous selections without changing the relative order of any selected rows", () => {
    const rows = initialRows(["a", "b", "c", "d", "e"].map((id) => commit(id)));
    const selected = new Set(["b", "c", "e"]);
    const moved = moveRebaseRows(rows, selected, -1);
    expect(moved.map(rebaseRowKey)).toEqual(["b", "c", "a", "e", "d"]);
    expect(moveRebaseRows(moved, selected, 1)).toEqual(rows);
    expect(moveRebaseRows(rows, selected, 1)).toBe(rows);
  });

  it("moves roots with all their fixups and crosses neighboring groups intact", () => {
    const rows = initialRows([
      commit("a"),
      commit("b"),
      commit("b1", [], "fixup! b"),
      commit("c"),
      commit("c1", [], "squash! c"),
    ]);
    const moved = (ids: string[], delta: -1 | 1) => moveRebaseRows(rows, new Set(ids), delta).map(rebaseRowKey);
    expect(moved(["b"], -1)).toEqual(["b", "b1", "a", "c", "c1"]);
    expect(moved(["b", "b1"], 1)).toEqual(["a", "c", "c1", "b", "b1"]);
    expect(moved(["a"], 1)).toEqual(["b", "b1", "a", "c", "c1"]);
    expect(moveRebaseRows(rows, new Set(["c"]), 1)).toBe(rows);
  });

  it("keeps a child joined when reordering siblings and makes it a pick across a group boundary", () => {
    const rows = initialRows([
      commit("a"),
      commit("b"),
      commit("x", [], "fixup! b"),
      commit("y", [], "squash! b"),
      commit("c"),
    ]);
    const moved = (id: string, delta: -1 | 1) =>
      moveRebaseRows(rows, new Set([id]), delta).map((r) => [rebaseRowKey(r), r.action].join(":"));
    expect(moved("y", -1)).toEqual(["a:pick", "b:pick", "y:squash", "x:fixup", "c:pick"]);
    expect(moved("x", -1)).toEqual(["a:pick", "x:pick", "b:pick", "y:squash", "c:pick"]);
    expect(moved("y", 1)).toEqual(["a:pick", "b:pick", "x:fixup", "c:pick", "y:pick"]);
  });

  it("combines noncontiguous rows, including existing dependent fixups, at the first selection", () => {
    const rows = initialRows([commit("a"), commit("b"), commit("c"), commit("d", [], "fixup! c"), commit("e")]);
    const { rows: combined } = combineRebaseRows(rows, new Set(["a", "c"]), "fixup");
    expect(combined.map((r) => [rebaseRowKey(r), r.action])).toEqual([
      ["a", "pick"],
      ["c", "fixup"],
      ["d", "fixup"],
      ["b", "pick"],
      ["e", "pick"],
    ]);
    expect(combineRebaseRows(combined, new Set(["c", "d"]), "squash").rows).toBe(combined);
    const squash = combineRebaseRows(combined, new Set(["d", "e"]), "squash");
    expect(squash.messageCommit).toBe("a");
    expect(squash.rows.map((r) => [rebaseRowKey(r), r.action])).toEqual([
      ["a", "reword"],
      ["c", "fixup"],
      ["d", "fixup"],
      ["e", "fixup"],
      ["b", "pick"],
    ]);
    expect(squash.rows[0]).toMatchObject({ message: "a\n\n\ne" });
    expect(toEntries(squash.rows)).toEqual([
      { commit: "a", action: "pick", message: null },
      { commit: "c", action: "fixup", message: null },
      { commit: "d", action: "fixup", message: null },
      { commit: "e", action: "fixup", message: "a\n\n\ne" },
      { commit: "b", action: "pick", message: null },
    ]);
    expect(combinedCommitMessage(["Subject\n\nBody", "fixup! Subject\n\n# Note", "Subject\n\nBody"])).toBe(
      "Subject\n\nBody\n\n\n# Note",
    );
    expect(setRebaseRowAction(squash.rows, new Set(["a"]), "drop").map((r) => r.action)).toEqual([
      "drop",
      "drop",
      "drop",
      "drop",
      "pick",
    ]);
    const detached = setRebaseRowAction(squash.rows, new Set(["c"]), "pick");
    expect(detached.map((r) => [rebaseRowKey(r), r.action])).toEqual([
      ["a", "reword"],
      ["d", "fixup"],
      ["e", "fixup"],
      ["c", "pick"],
      ["b", "pick"],
    ]);
  });

  it("builds single-commit plans for Edit Commit Message and Drop Commit", () => {
    const range = { base: "c1", commits: [history[2]!, history[1]!] };
    expect(singleCommitPlan(range, "c3", "reword", "msg\n")).toEqual([
      { commit: "c2", action: "pick", message: null },
      { commit: "c3", action: "reword", message: "msg" },
    ]);
    expect(singleCommitPlan(range, "c2", "drop").map((e) => e.action)).toEqual(["drop", "pick"]);
  });

  it("autosquashes fixup! / squash! commits after their target", () => {
    const commits = [
      commit("a1", [], "Add parser"),
      commit("b2", ["a1"], "Add lexer"),
      commit("c3", ["b2"], "fixup! Add parser"),
      commit("d4", ["c3"], "squash! Add lexer"),
      commit("e5", ["d4"], "fixup! fixup! Add parser"),
      commit("f6", ["e5"], "fixup! Unknown"),
    ];
    const rows = initialRows(commits);
    expect(rows.map((r) => `${r.action}:${r.commit.id}`)).toEqual([
      "pick:a1",
      "fixup:c3",
      "fixup:e5",
      "pick:b2",
      "squash:d4",
      "pick:f6",
    ]);
    expect(planIsNoop(rows, commits)).toBe(false);
  });

  it("squashes selected commits into the oldest one's position", () => {
    const range = { base: "c1", commits: [history[2]!, history[1]!, history[0]!] };
    expect(squashPlan(range, new Set(["c2", "c4"]), " merged \n")).toEqual([
      { commit: "c2", action: "pick", message: null },
      { commit: "c4", action: "squash", message: "merged" },
      { commit: "c3", action: "pick", message: null },
    ]);
  });
});

describe("log ordering and staleness", () => {
  it("orders commits by their position in the log, not by date", () => {
    const log = [commit("new"), commit("mid"), commit("old")];
    const picked = [
      { ...log[2]!, timeMs: 3 },
      { ...log[0]!, timeMs: 1 },
    ];
    expect(newestFirst(picked, log).map((c) => c.id)).toEqual(["new", "old"]);
    expect(newestFirst([commit("a"), { ...commit("b"), timeMs: 5 }], []).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("changes the refs signature when HEAD or any branch tip moves", () => {
    const base = refsSignature(info(), [branch("main", "c3"), branch("origin/main", "c3", true)]);
    expect(refsSignature(info(), [branch("origin/main", "c3", true), branch("main", "c3")])).toBe(base);
    expect(
      refsSignature(info({ headCommit: "c2" }), [branch("main", "c2"), branch("origin/main", "c3", true)]),
    ).not.toBe(base);
    expect(refsSignature(info(), [branch("main", "c3"), branch("origin/main", "c4", true)])).not.toBe(base);
    expect(refsSignature(info(), [branch("main", "c3")])).not.toBe(base);
  });
});

describe("status refresh", () => {
  beforeEach(() => {
    vcsStatus.mockReset();
    useVcs.setState({ available: true, branchesLoaded: false, stashesLoaded: false, status: [] });
  });

  it("a refresh requested while one is running resolves only after a newer refresh", async () => {
    let release: (v: unknown) => void = () => {};
    vcsStatus
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockImplementationOnce(async () => ({ status: "ok", data: [fs("after.ts", { unstaged: "modified" })] }));
    const first = refreshNow();
    await Promise.resolve();
    // An operation finished while the first refresh was in flight.
    const second = refreshNow();
    const third = refreshNow();
    expect(third).toBe(second);
    release({ status: "ok", data: [fs("before.ts", { unstaged: "modified" })] });
    await first;
    await second;
    expect(useVcs.getState().status.map((f) => f.relPath)).toEqual(["after.ts"]);
    expect(vcsStatus).toHaveBeenCalledTimes(2);
  });
});
