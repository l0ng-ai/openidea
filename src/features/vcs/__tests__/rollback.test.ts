import { describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import { rollbackCandidates } from "../changeOps";
import { GITLINK_MODE, loadDiffEntries } from "../gitDiffEntries";
import { inspectSubmoduleRollback } from "../submoduleRollback";

vi.mock("../gitDiffEntries", () => ({ GITLINK_MODE: "160000", loadDiffEntries: vi.fn() }));

const fs = (rel: string, unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/r/${rel}`,
  relPath: rel,
  staged: null,
  unstaged,
  renamedFrom: null,
});

describe("rollback candidates with a submodule", () => {
  const roots = ["/r", "/r/libs/core"];
  const status = [
    fs("app.txt", "modified"),
    fs("libs/core", "modified"),
    fs("libs/core/core.txt", "modified"),
    fs("libs/core/wip.txt", "untracked"),
  ];
  const paths = (files: FileStatus[]) => files.map((f) => f.path);

  it("offers the submodule entry alongside the tracked files", () => {
    expect(paths(rollbackCandidates(undefined, status))).toEqual([
      "/r/app.txt",
      "/r/libs/core",
      "/r/libs/core/core.txt",
    ]);
  });

  it("takes a selected change alone, not the submodule's changes below its path", () => {
    expect(rollbackCandidates(["/r/libs/core"], status)).toEqual([status[1]]);
    expect(paths(rollbackCandidates(["/r/app.txt", "/r/libs/core"], status))).toEqual(["/r/app.txt", "/r/libs/core"]);
  });

  it("takes the changes below a selected folder", () => {
    expect(paths(rollbackCandidates(["/r/libs"], status))).toEqual(["/r/libs/core", "/r/libs/core/core.txt"]);
  });

  it("plans the parent index and the checkout against the selected rollback source", async () => {
    const path = status[1]!.path;
    const entry = (gitlink: string) => ({ mode: GITLINK_MODE, gitlink });
    vi.mocked(loadDiffEntries).mockResolvedValue([entry("head"), entry("index"), entry("checkout")]);
    expect((await inspectSubmoduleRollback(status, roots, "all")).get(path)).toEqual({
      indexPaths: [path],
      worktree: [{ path, missing: false }],
    });
    expect((await inspectSubmoduleRollback(status, roots, "unstaged")).get(path)).toEqual({
      indexPaths: [],
      worktree: [{ path, missing: false }],
    });
    vi.mocked(loadDiffEntries).mockResolvedValue([entry("head"), entry("head"), entry("head")]);
    expect(await inspectSubmoduleRollback(status, roots, "all")).toEqual(
      new Map([[path, { indexPaths: [], worktree: [] }]]),
    );
  });

  it("offers to recreate an absent submodule when there is a recorded gitlink", async () => {
    const file = fs("libs/core", "deleted");
    const entry = { mode: GITLINK_MODE, gitlink: "index" };
    const missing = { mode: GITLINK_MODE, gitlink: null };
    const worktree = [{ path: file.path, missing: true }];
    vi.mocked(loadDiffEntries).mockResolvedValue([entry, entry, missing]);
    for (const scope of ["all", "unstaged"] as const) {
      expect((await inspectSubmoduleRollback([file], ["/r"], scope)).get(file.path)).toEqual({
        indexPaths: [],
        worktree,
      });
    }
    vi.mocked(loadDiffEntries).mockResolvedValue([entry, null, missing]);
    expect(
      (await inspectSubmoduleRollback([{ ...file, staged: "deleted", unstaged: null }], ["/r"], "all")).get(file.path),
    ).toEqual({
      indexPaths: [file.path],
      worktree,
    });
  });
});
