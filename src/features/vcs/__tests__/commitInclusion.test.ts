import { beforeEach, describe, expect, it, vi } from "vitest";

const unstage = vi.hoisted(() => vi.fn());
const stage = vi.hoisted(() => vi.fn());
const commit = vi.hoisted(() => vi.fn());

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    isTauri: () => false,
    call: async (p: Promise<{ status: "ok"; data: unknown }>) => (await p).data,
    commands: {
      ...real.commands,
      vcsUnstage: unstage.mockImplementation(() => ok(null)),
      vcsStage: stage.mockImplementation(() => ok(null)),
      vcsCommit: commit.mockImplementation(() => ok("commit1")),
    },
  };
});

import type { FileStatus } from "@/bindings";
import { commitChanges } from "../changeOps";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const files: FileStatus[] = Array.from({ length: 20 }, (_, i) => ({
  path: `/p/src/f${i}.ts`,
  relPath: `src/f${i}.ts`,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
}));

const excluded = files.slice(5);

describe("changes left out of a commit (#1539)", () => {
  beforeEach(() => {
    localStorage.clear();
    unstage.mockClear();
    stage.mockClear();
    commit.mockClear();
    useVcs.setState({
      available: false,
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      status: files,
      branch: null,
      operations: {},
    });
    useCommit.setState({
      message: "Commit 5 of 20",
      amend: false,
      checks: new Map(excluded.map((f) => [f.path, "none" as const])),
      excludedHunks: new Map([[files[5]!.path, new Set(["h1"])]]),
      checkProblems: [],
    });
  });

  it("keeps the 15 excluded files excluded instead of checking them again", async () => {
    expect(await commitChanges()).toBe("commit1");
    // Only the 5 checked files go into the commit; the index itself is not touched.
    expect(commit.mock.calls[0]?.[2].stage).toEqual(files.slice(0, 5).map((f) => f.path));
    expect(stage).not.toHaveBeenCalled();
    expect(unstage).not.toHaveBeenCalled();

    const { checks, excludedHunks } = useCommit.getState();
    expect(checks.size).toBe(15);
    expect(excluded.every((f) => checks.get(f.path) === "none")).toBe(true);
    expect(files.slice(0, 5).some((f) => checks.has(f.path))).toBe(false);
    // Block exclusions of files still in the tree are kept too.
    expect(excludedHunks.get(files[5]!.path)).toEqual(new Set(["h1"]));
  });

  it("leaves staged files out of the commit without unstaging them", async () => {
    const staged = { ...files[7]!, staged: "modified" as const, unstaged: null };
    useVcs.setState({ status: [...files.slice(0, 7), staged] });
    expect(await commitChanges()).toBe("commit1");
    expect(commit.mock.calls[0]?.[2].exclude).toEqual([staged.path]);
    expect(unstage).not.toHaveBeenCalled();
  });
});
