import { describe, expect, it } from "vitest";
import { groupWorktrees, isCurrentWorktree, worktreeContainsProject, type RepoWorktrees } from "./worktrees";

const worktree = (path: string, main = false) => ({
  path,
  head: "0123456789abcdef",
  branch: path.split("/").pop() ?? null,
  main,
  locked: false,
  prunable: false,
});

describe("isCurrentWorktree", () => {
  it("matches the repository root this window works in", () => {
    expect(isCurrentWorktree("/work/app", "/work/app")).toBe(true);
    expect(isCurrentWorktree("/work/app-wt", "/work/app")).toBe(false);
    expect(isCurrentWorktree("/work/app/", "/work/app")).toBe(true);
    expect(isCurrentWorktree("/work/app", null)).toBe(false);
  });

  it("ignores the drive letter's case and separators on Windows", () => {
    expect(isCurrentWorktree("c:/Work/app", "C:/Work/app")).toBe(true);
    expect(isCurrentWorktree("C:\\Work\\app", "C:/Work/app")).toBe(true);
    // Only drive paths: elsewhere the case is part of the name.
    expect(isCurrentWorktree("/Work/App", "/work/app")).toBe(false);
  });
});

describe("groupWorktrees", () => {
  it("keeps one group per repository", () => {
    const groups = groupWorktrees([
      { root: "/work/app", worktrees: [worktree("/work/app", true)] },
      { root: "/work/web", worktrees: [worktree("/work/web", true)] },
    ]);
    expect(groups.map((g) => g.root)).toEqual(["/work/app", "/work/web"]);
  });

  it("merges the roots of a linked worktree that list the same repository", () => {
    const worktrees = [worktree("/work/app", true), worktree("/work/app-feature")];
    const groups = groupWorktrees([
      { root: "/work/app-feature", worktrees },
      { root: "/work/app", worktrees },
    ]);
    // The main folder names the group even when the linked root came first.
    expect(groups).toEqual([{ root: "/work/app", worktrees }]);
  });

  it("matches the main worktree case-insensitively on Windows", () => {
    const worktrees = [worktree("C:/Work/app", true), worktree("C:/Work/app-feature")];
    const groups = groupWorktrees([
      { root: "c:/work/app", worktrees },
      { root: "C:/Work/app-feature", worktrees },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.root).toBe("c:/work/app");
  });

  it("files a root that failed under the repository that lists it", () => {
    const failed: RepoWorktrees = { root: "/work/app-feature", worktrees: [], error: "not a git repository" };
    const loaded: RepoWorktrees = {
      root: "/work/app",
      worktrees: [worktree("/work/app", true), worktree("/work/app-feature")],
    };
    const groups = groupWorktrees([failed, loaded]);
    expect(groups).toHaveLength(1);
    // The group keeps the root that loaded, so its actions keep working.
    expect(groups[0]?.root).toBe("/work/app");
    expect(groups[0]?.worktrees).toBe(loaded.worktrees);
    // `error` is absent rather than the stale message.
    expect(groups[0]?.error).toBeUndefined();
  });

  it("keeps errors from roots whose repository was not listed by another root", () => {
    const failed: RepoWorktrees = { root: "/work/other-feature", worktrees: [], error: "permission denied" };
    const loaded: RepoWorktrees = {
      root: "/work/app",
      worktrees: [worktree("/work/app", true), worktree("/work/app-feature")],
    };
    expect(groupWorktrees([failed, loaded])).toEqual([loaded, failed]);
    expect(groupWorktrees([failed])).toEqual([failed]);
  });
});

describe("worktreeContainsProject", () => {
  it.each([
    ["/p/front", "/p/front", true],
    ["/p/front/", "/p/front/src", true],
    ["/p/front", "/p/front-wt", false],
    ["/p/front/linked", "/p/front", false],
    ["/", "/p/front", true],
    ["C:\\Work\\App", "c:/work/app/src", true],
    ["C:/Work/App/", "c:/work/app-wt", false],
    ["/Work/App", "/work/app", false],
    ["/p/front", null, false],
  ])("compares %s with project %s", (path, root, expected) => {
    expect(worktreeContainsProject(path, root)).toBe(expected);
  });
});
