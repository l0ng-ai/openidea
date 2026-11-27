import { beforeEach, describe, expect, it, vi } from "vitest";

const unstage = vi.hoisted(() => vi.fn());
const stage = vi.hoisted(() => vi.fn());
const commit = vi.hoisted(() => vi.fn());
const fileAt = vi.hoisted(() => vi.fn());
const readText = vi.hoisted(() => vi.fn());
const diffHunks = vi.hoisted(() => vi.fn());

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
      vcsConfigGet: () => ok("configured"),
      vcsFileAt: fileAt,
      fsReadText: readText,
      vcsDiffHunks: diffHunks,
    },
  };
});

import type { FileStatus } from "@/bindings";
import { commitChanges } from "../changeOps";
import { useCommit } from "../commitStore";
import { hunkKeys } from "../hunks";
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
      excludedHunkLines: new Map(),
      checkResult: null,
    });
  });

  it("keeps the 15 excluded files excluded instead of checking them again", async () => {
    expect(await commitChanges()).toEqual([{ repo: "/p", id: "commit1" }]);
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
    expect(await commitChanges()).toEqual([{ repo: "/p", id: "commit1" }]);
    expect(commit.mock.calls[0]?.[2].exclude).toEqual([staged.path]);
    expect(unstage).not.toHaveBeenCalled();
  });

  it("commits only the selected repository when another repository has a paused operation", async () => {
    const pending = { ...files[0]!, staged: "modified" as const, unstaged: null };
    const independent = { ...files[1]!, path: "/p/nested/independent.ts", relPath: "independent.ts" };
    useVcs.setState({
      roots: ["/p", "/p/nested"],
      status: [pending, independent],
      operations: { "/p": "revert" },
    });
    useCommit.setState({ checks: new Map([[pending.path, "none"]]) });
    expect(await commitChanges()).toEqual([{ repo: "/p/nested", id: "commit1" }]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[2].stage).toEqual([independent.path]);
  });

  it("passes only the included deleted and added lines to the commit", async () => {
    const file = files[0]!;
    const head = "top\nold one\nold two\nend\n";
    const disk = "top\nnew one\nnew two\nend\n";
    const hunk = {
      kind: "modified",
      start: 1,
      lines: 2,
      oldStart: 1,
      oldLines: 2,
      oldText: "old one\nold two\n",
    } as const;
    const [key] = hunkKeys(disk, [hunk]);
    fileAt.mockResolvedValue({ status: "ok", data: head });
    diffHunks.mockResolvedValue([hunk]);
    useVcs.setState({ status: [file] });
    useCommit.setState({
      checks: new Map([[file.path, "hunks"]]),
      excludedHunkLines: new Map([[file.path, new Map([[key!, { old: new Set([1]), current: new Set([0]) }]])]]),
    });
    readText.mockResolvedValue({ status: "ok", data: disk.replace("new two", "another edit") });
    expect(await commitChanges()).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect(useCommit.getState().excludedHunkLines.size).toBe(1);

    readText.mockResolvedValue({ status: "ok", data: disk.replace(/\n/g, "\r\n") });
    expect(await commitChanges()).toEqual([{ repo: "/p", id: "commit1" }]);
    expect(commit.mock.calls[0]?.[2].partial).toEqual([
      {
        path: file.path,
        hunks: [],
        lineHunks: [
          {
            range: { start: 1, lines: 2, oldStart: 1, oldLines: 2 },
            oldText: hunk.oldText,
            newText: "new one\nnew two\n",
            additions: [1],
            deletions: [0],
          },
        ],
      },
    ]);
    expect(useCommit.getState().excludedHunkLines.size).toBe(0);
  });
});
