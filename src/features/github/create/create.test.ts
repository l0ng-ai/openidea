import { describe, expect, it } from "vitest";
import type { Branch } from "@/platform/ipc";
import type { GHRemote } from "../data/repository";
import {
  baseText,
  checkBranches,
  cleanUpBranchName,
  commitDescription,
  commitsRange,
  defaultBaseBranch,
  defaultDirection,
  generateTitle,
  headRefName,
  headText,
  needsPush,
  pushTarget,
  remoteBranchesOf,
  searchHead,
  splitRemoteBranch,
  trackedHead,
  type Direction,
} from "./model";
import { canCreate, selectableReviewers } from "./store";

const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: null,
  ...extra,
});
const remote = (name: string, commit?: string) => branch(name, { remote: true, commit });

const origin: GHRemote = { owner: "l0ng-ai", name: "openidea", remote: "origin", url: "" };
const fork: GHRemote = { owner: "me", name: "openidea", remote: "fork", url: "" };

const branches = [
  branch("feature", { current: true, upstream: "fork/feature", commit: "a1" }),
  branch("local-only", { commit: "b1" }),
  branch("tracking-main", { upstream: "origin/main", commit: "c1" }),
  remote("origin/HEAD"),
  remote("origin/main", "c1"),
  remote("origin/master", "m1"),
  remote("fork/feature", "a0"),
];

describe("merge direction", () => {
  it("splits remote branches by the longest remote name", () => {
    expect(splitRemoteBranch("origin/feat/x", ["origin"])).toEqual({ remote: "origin", name: "feat/x" });
    expect(splitRemoteBranch("my/fork/x", ["my", "my/fork"])).toEqual({ remote: "my/fork", name: "x" });
    expect(splitRemoteBranch("upstream/x", ["origin"])).toBeNull();
  });

  it("lists a remote's branches without HEAD", () => {
    expect(remoteBranchesOf(branches, "origin").map((b) => b.name)).toEqual(["main", "master"]);
  });

  it("defaults the base to the repository default, then master, then main", () => {
    expect(defaultBaseBranch(branches, "origin", "main")).toEqual({ remote: "origin", name: "main" });
    expect(defaultBaseBranch(branches, "origin", "develop")).toEqual({ remote: "origin", name: "master" });
    expect(defaultBaseBranch([remote("origin/main")], "origin", null)).toEqual({ remote: "origin", name: "main" });
    expect(defaultBaseBranch([], "origin", "main")).toBeNull();
  });

  it("defaults the head to the current branch in its tracked remote's repository", () => {
    const d = defaultDirection({
      baseRepo: origin,
      remotes: [origin, fork],
      branches,
      currentBranch: "feature",
      defaultBranch: "main",
    });
    expect(d.headRepo).toBe(fork);
    expect(d.headBranch).toEqual({ kind: "local", name: "feature" });
    expect(d.baseBranch).toEqual({ remote: "origin", name: "main" });
    const untracked = defaultDirection({
      baseRepo: origin,
      remotes: [origin, fork],
      branches,
      currentBranch: "local-only",
      defaultBranch: "main",
    });
    expect(untracked.headRepo).toBe(origin);
  });

  it("shows the owner only when the repositories differ", () => {
    const same: Direction = {
      baseRepo: origin,
      baseBranch: { remote: "origin", name: "main" },
      headRepo: origin,
      headBranch: { kind: "local", name: "feature" },
    };
    expect(baseText(same)).toBe("openidea:main");
    expect(headText(same)).toBe("openidea:feature");
    const forked: Direction = { ...same, headRepo: fork, headBranch: { kind: "remote", remote: "fork", name: "x" } };
    expect(baseText(forked)).toBe("l0ng-ai/openidea:main");
    expect(headText(forked)).toBe("me/openidea:fork/x");
    expect(baseText({ ...same, baseBranch: null })).toBeNull();
    expect(headText({ ...same, headRepo: null })).toBeNull();
  });

  it("builds the log range and the API head names", () => {
    expect(commitsRange({ remote: "origin", name: "main" }, { kind: "local", name: "f" })).toBe("origin/main..f");
    expect(commitsRange({ remote: "origin", name: "main" }, { kind: "remote", remote: "fork", name: "f" })).toBe(
      "origin/main..fork/f",
    );
    expect(headRefName(origin, origin, "f")).toBe("f");
    expect(headRefName(origin, fork, "f")).toBe("me:f");
    expect(searchHead(origin, "f")).toBe("l0ng-ai:f");
  });
});

describe("branches check", () => {
  const base = { remote: "origin", name: "main" };
  const head = { kind: "local" as const, name: "tracking-main" };

  it("finds the tracked branch of the head", () => {
    expect(trackedHead(head, branches, ["origin", "fork"])).toEqual(base);
    expect(trackedHead({ kind: "local", name: "local-only" }, branches, ["origin"])).toBeNull();
  });

  it("reports no changes, an existing pull request, or OK", () => {
    expect(checkBranches({ base, head, tracked: base, commits: [1], existing: null })).toEqual({
      kind: "noChanges",
      base: "main",
      head: "tracking-main",
    });
    expect(checkBranches({ base, head, tracked: null, commits: [], existing: 3 }).kind).toBe("noChanges");
    expect(checkBranches({ base, head, tracked: null, commits: [1], existing: 3 })).toEqual({
      kind: "alreadyExists",
      number: 3,
    });
    expect(checkBranches({ base, head, tracked: null, commits: [1], existing: null })).toEqual({ kind: "ok" });
  });

  it("enables Create only for OK while nothing runs or after a failure", () => {
    const okCheck = { state: "ok" as const, value: { kind: "ok" as const } };
    expect(canCreate({ check: okCheck, creation: null })).toBe(true);
    expect(canCreate({ check: okCheck, creation: { kind: "error", error: "x" } })).toBe(true);
    expect(canCreate({ check: okCheck, creation: { kind: "pushing" } })).toBe(false);
    expect(canCreate({ check: { state: "loading" }, creation: null })).toBe(false);
    expect(canCreate({ check: { state: "ok", value: { kind: "alreadyExists", number: 1 } }, creation: null })).toBe(
      false,
    );
  });
});

describe("push target", () => {
  it("is the tracked branch on the head's remote", () => {
    expect(pushTarget(branches, "feature", "fork", ["origin", "fork"])).toEqual({ remote: "fork", name: "feature" });
    expect(pushTarget(branches, "feature", "origin", ["origin", "fork"])).toBeNull();
    expect(pushTarget(branches, "local-only", "origin", ["origin", "fork"])).toBeNull();
  });

  it("needs a push when the tips differ or the remote branch is missing", () => {
    expect(needsPush(branches, "feature", { remote: "fork", name: "feature" })).toBe(true);
    expect(needsPush(branches, "tracking-main", { remote: "origin", name: "main" })).toBe(false);
    expect(needsPush(branches, "local-only", { remote: "origin", name: "local-only" })).toBe(true);
  });

  it("cleans up branch names like GitRefNameValidator", () => {
    expect(cleanUpBranchName(" my feature: v2? ")).toBe("my_feature__v2_");
    expect(cleanUpBranchName("a..b~c^d")).toBe("a_b_c_d");
    expect(cleanUpBranchName("/x.lock")).toBe("x_lock");
  });
});

describe("text", () => {
  it("titles with the only commit's subject, else the branch", () => {
    const head = { kind: "local" as const, name: "feature" };
    expect(generateTitle([{ summary: "Fix it" }], head)).toBe("Fix it");
    expect(generateTitle([{ summary: "a" }, { summary: "b" }], head)).toBe("feature");
    expect(generateTitle([], { kind: "remote", remote: "fork", name: "x" })).toBe("fork/x");
  });

  it("takes the description paragraph of a commit message", () => {
    expect(commitDescription("Subject\n\nBody line\nmore\n\nTrailer: x")).toBe("Body line\nmore");
    expect(commitDescription("Subject")).toBe("");
  });

  it("leaves the current user out of the reviewers", () => {
    const me = { __typename: "User" as const, id: "1", login: "me", url: "", avatarUrl: "", name: null };
    const other = { ...me, id: "2", login: "other" };
    const team = {
      __typename: "Team" as const,
      id: "1",
      slug: "core",
      url: "",
      teamAvatarUrl: null,
      teamName: "Core",
      combinedSlug: "org/core",
    };
    expect(selectableReviewers([me, other, team], me)).toEqual([other, team]);
  });
});
