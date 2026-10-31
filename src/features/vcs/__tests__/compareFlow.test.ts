import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), choose: vi.fn(), open: vi.fn(), show: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsCompareScope: mocks.scope } };
});
vi.mock("../RevisionChooser", () => ({ chooseRepositoryRevision: mocks.choose }));
vi.mock("../diffInput", () => ({ openDiff: mocks.open }));
vi.mock("../operations", () => ({ showPathComparison: mocks.show }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));
import { comparePathsWithRevision, showDirectoryWorkingDiff } from "../comparePaths";

afterEach(() => vi.clearAllMocks());

describe("comparison flow", () => {
  it("keeps a single file's direct revision → worktree diff and uses its own repository's picker", async () => {
    mocks.scope.mockResolvedValue({
      status: "ok",
      data: { repositories: ["/server"], singleFile: true, skippedPaths: [] },
    });
    mocks.choose.mockResolvedValue({ rev: "main", repositories: ["/server"] });
    await comparePathsWithRevision(["/server/a.ts"]);
    expect(mocks.choose).toHaveBeenCalledWith("Compare with Branch or Revision", {
      repositories: ["/server"],
      tags: true,
    });
    expect(mocks.open).toHaveBeenCalledWith({
      path: "/server/a.ts",
      left: { type: "rev", rev: "main", label: "main" },
      right: { type: "worktree" },
    });
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it("applies shared revisions across the selection so missing revisions are reported, and preserves repo-specific choices", async () => {
    mocks.scope.mockResolvedValue({
      status: "ok",
      data: { repositories: ["/client", "/server", "/admin"], singleFile: false, skippedPaths: [] },
    });
    mocks.choose.mockResolvedValue({ rev: "main", repositories: ["/client", "/server"] });
    await comparePathsWithRevision(["/workspace"]);
    expect(mocks.show).toHaveBeenLastCalledWith(["/workspace"], "main", null);
    mocks.choose.mockResolvedValue({ rev: "feature", repositories: ["/server"] });
    await comparePathsWithRevision(["/workspace"]);
    expect(mocks.show).toHaveBeenLastCalledWith(["/workspace"], "feature", ["/server"]);
  });

  it("reports non-repository selections before opening a picker", async () => {
    mocks.scope.mockResolvedValue({
      status: "ok",
      data: { repositories: [], singleFile: false, skippedPaths: ["/loose"] },
    });
    await comparePathsWithRevision(["/loose"]);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Selection is outside Git repositories" }),
    );
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it("reuses the tree against HEAD for Show Diff on folders", async () => {
    mocks.scope.mockResolvedValue({
      status: "ok",
      data: { repositories: ["/server"], singleFile: false, skippedPaths: [] },
    });
    expect(await showDirectoryWorkingDiff(["/server/src"])).toBe(true);
    expect(mocks.show).toHaveBeenCalledWith(["/server/src"], "HEAD", null);
  });
});
