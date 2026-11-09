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
  headPushed,
  initialRows,
  moveRow,
  planIsNoop,
  planProblem,
  rebaseRange,
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
    rows = moveRow(rows, 2, -1);
    expect(rows.map((r) => r.commit.id)).toEqual(["c2", "c4", "c3"]);
    expect(moveRow(rows, 0, -1).map((r) => r.commit.id)).toEqual(["c2", "c4", "c3"]);
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
