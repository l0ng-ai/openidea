import { describe, expect, it, vi } from "vitest";
import type { FileStatus, LineHunk } from "@/bindings";
import { hunkKeys } from "../hunks";
import { buildCommitDiff, limitCommitDiff, runCommitMessageGeneration } from "../commitMessageGenerator";

const file = (path: string, patch: Partial<FileStatus> = {}): FileStatus => ({
  path,
  relPath: path.split("/").pop()!,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
  ...patch,
});
const hunk = (start: number, oldText: string): LineHunk => ({
  kind: "modified",
  start,
  lines: 1,
  oldStart: start,
  oldLines: 1,
  oldText,
});

describe("commit message selected change snapshot", () => {
  it("uses each selected repository's HEAD and excludes unchecked and untracked files", async () => {
    const included = file("/a/one.ts");
    const other = file("/b/two.ts");
    const excluded = file("/a/secret.ts");
    const untracked = file("/a/new.ts", { unstaged: "untracked" });
    const readRevision = vi.fn(async (path: string, revision: string) => `${path}:${revision}`);
    const readWorking = vi.fn(async (path: string) => `${path}:working`);
    const patch = vi.fn(
      async (path: string, oldText: string, newText: string, selected: number[]) =>
        `${path}:${oldText}->${newText}:${selected.join(",")}`,
    );
    const result = await buildCommitDiff({
      status: [included, other, excluded, untracked],
      checks: new Map([[excluded.path, "none"]]),
      excludedHunks: new Map(),
      roots: ["/a", "/b"],
      io: { isBinary: async () => false, readRevision, readWorking, hunks: async () => [hunk(0, "old")], patch },
    });
    expect(readRevision.mock.calls).toEqual([
      [included.path, "HEAD"],
      [other.path, "HEAD"],
    ]);
    expect(readWorking.mock.calls).toEqual([[included.path], [other.path]]);
    expect(result).toContain("/a/one.ts:HEAD");
    expect(result).toContain("/b/two.ts:HEAD");
    expect(result).not.toContain("secret.ts");
    expect(result).not.toContain("new.ts");
  });

  it("uses the index only for partially staged files", async () => {
    const f = file("/a/one.ts", { staged: "modified", unstaged: "modified" });
    const readRevision = vi.fn(async (_path: string, revision: string) => (revision === "HEAD" ? "base" : "index"));
    const readWorking = vi.fn(async () => "unstaged secret");
    const patch = vi.fn(async (_path: string, old: string, next: string) => `${old}->${next}`);
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map(),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: { isBinary: async () => false, readRevision, readWorking, hunks: async () => [hunk(0, "base")], patch },
    });
    expect(result).toContain("base->index");
    expect(readWorking).not.toHaveBeenCalled();
  });
  it("includes the recreated working file when a staged deletion is selected entirely", async () => {
    const f = file("/a/restored.ts", { staged: "deleted", unstaged: "untracked" });
    const readRevision = vi.fn(async () => "original");
    const readWorking = vi.fn(async () => "recreated");
    const patch = vi.fn(async (_path: string, old: string, next: string) => `${old}->${next}`);
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map(),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: { isBinary: async () => false, readRevision, readWorking, hunks: async () => [hunk(0, "original")], patch },
    });
    expect(result).toContain("original->recreated");
    expect(readWorking).toHaveBeenCalledWith(f.path);
  });
  it("does not require an index entry for a selected staged deletion", async () => {
    const f = file("/a/deleted.ts", { staged: "deleted", unstaged: "untracked" });
    const readRevision = vi.fn(async (_path: string, revision: string) => {
      if (revision === ":0") throw new Error("no index entry");
      return "original";
    });
    const patch = vi.fn(async (_path: string, old: string, next: string) => `${old}->${next}`);
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map([[f.path, "staged"]]),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: {
        isBinary: async () => false,
        readRevision,
        readWorking: async () => "recreated",
        hunks: async () => [hunk(0, "original")],
        patch,
      },
    });
    expect(result).toContain("original->");
    expect(readRevision).not.toHaveBeenCalledWith(f.path, ":0");
  });

  it("passes only included hunk indexes to the existing patch builder", async () => {
    const f = file("/a/one.ts");
    const updated = "changed\nsecret\n";
    const hunks = [hunk(0, "first\n"), hunk(1, "private\n")];
    const excluded = hunkKeys(updated, hunks)[1]!;
    const patch = vi.fn(async (_path: string, _old: string, _next: string, chosen: number[]) => chosen.join(","));
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map([[f.path, "hunks"]]),
      excludedHunks: new Map([[f.path, new Set([excluded])]]),
      roots: ["/a"],
      io: {
        isBinary: async () => false,
        readRevision: async () => "first\nprivate\n",
        readWorking: async () => updated,
        hunks: async () => hunks,
        patch,
      },
    });
    expect(patch).toHaveBeenCalledWith("one.ts", "first\nprivate\n", updated, [0]);
    expect(result).not.toContain("secret");
  });
  it("fails closed if a previously excluded hunk changed before snapshotting", async () => {
    const f = file("/a/one.ts");
    const patch = vi.fn(async () => "secret");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map([[f.path, "hunks"]]),
        excludedHunks: new Map([[f.path, new Set(["stale-hunk-key"])]]),
        roots: ["/a"],
        io: {
          isBinary: async () => false,
          readRevision: async () => "old",
          readWorking: async () => "new",
          hunks: async () => [hunk(0, "old")],
          patch,
        },
      }),
    ).rejects.toThrow("one.ts");
    expect(patch).not.toHaveBeenCalled();
  });

  it("reads renamed HEAD from its original path and allows selected new and deleted files", async () => {
    const renamed = file("/a/new.ts", { relPath: "new.ts", staged: "renamed", unstaged: null, renamedFrom: "old.ts" });
    const added = file("/a/created.ts", { unstaged: "untracked" });
    const deleted = file("/a/deleted.ts", { unstaged: "deleted" });
    const readRevision = vi.fn(async (path: string, revision: string) =>
      path.endsWith("old.ts") ? "old" : revision === ":0" ? "new" : "before",
    );
    const readWorking = vi.fn(async (path: string) =>
      path.endsWith("created.ts") ? "created" : path.endsWith("new.ts") ? "new" : null,
    );
    const patch = vi.fn(async (path: string, old: string, next: string) => `${path}:${old}->${next}`);
    const result = await buildCommitDiff({
      status: [renamed, added, deleted],
      checks: new Map([[added.path, "all"]]),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: { isBinary: async () => false, readRevision, readWorking, hunks: async () => [hunk(0, "old")], patch },
    });
    expect(readRevision).toHaveBeenCalledWith("/a/old.ts", "HEAD");
    expect(result).toContain("old.ts");
    expect(result).toContain("created.ts");
    expect(result).toContain("deleted.ts");
  });

  it("does not silently send empty content when a selected working file cannot be read", async () => {
    const f = file("/a/broken.ts");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map(),
        excludedHunks: new Map(),
        roots: ["/a"],
        io: {
          isBinary: async () => false,
          readRevision: async () => "base",
          readWorking: async () => null,
          hunks: async () => [],
          patch: async () => "",
        },
      }),
    ).rejects.toThrow("broken.ts");
  });
  it("does not read a file after the backend rejects an unsafe symbolic link", async () => {
    const f = file("/a/link.ts", { unstaged: "untracked" });
    const readWorking = vi.fn(async () => "outside secret");
    const patch = vi.fn(async () => "outside secret");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map([[f.path, "all"]]),
        excludedHunks: new Map(),
        roots: ["/a"],
        io: {
          isBinary: async () => {
            throw new Error("symbolic links are unsupported");
          },
          readRevision: async () => null,
          readWorking,
          hunks: async () => [],
          patch,
        },
      }),
    ).rejects.toThrow("symbolic");
    expect(readWorking).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
  it("does not treat a missing HEAD for a tracked file as an addition", async () => {
    const f = file("/a/private.ts");
    const patch = vi.fn(async () => "unsafe");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map(),
        excludedHunks: new Map(),
        roots: ["/a"],
        io: {
          isBinary: async () => false,
          readRevision: async () => null,
          readWorking: async () => "private",
          hunks: async () => [],
          patch,
        },
      }),
    ).rejects.toThrow("private.ts");
    expect(patch).not.toHaveBeenCalled();
  });
  it("does not treat a missing staged version of a tracked file as a deletion", async () => {
    const f = file("/a/staged.ts", { staged: "modified", unstaged: "modified" });
    const patch = vi.fn(async () => "unsafe");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map(),
        excludedHunks: new Map(),
        roots: ["/a"],
        io: {
          isBinary: async () => false,
          readRevision: async (_path, revision) => (revision === "HEAD" ? "base" : null),
          readWorking: async () => "work",
          hunks: async () => [],
          patch,
        },
      }),
    ).rejects.toThrow("staged.ts");
    expect(patch).not.toHaveBeenCalled();
  });
  it("describes selected binary files without reading or sending binary content", async () => {
    const f = file("/a/image.png", { unstaged: "untracked" });
    const readWorking = vi.fn(async () => "binary secret");
    const patch = vi.fn(async () => "binary secret");
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map([[f.path, "all"]]),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: { isBinary: async () => true, readRevision: async () => null, readWorking, hunks: async () => [], patch },
    });
    expect(result).toContain("image.png");
    expect(result).toContain("binary");
    expect(result).not.toContain("binary secret");
    expect(readWorking).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
  it("rejects a partial binary selection", async () => {
    const f = file("/a/image.png");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map([[f.path, "hunks"]]),
        excludedHunks: new Map(),
        roots: ["/a"],
        io: {
          isBinary: async () => true,
          readRevision: async () => "base",
          readWorking: async () => "binary",
          hunks: async () => [],
          patch: async () => "",
        },
      }),
    ).rejects.toThrow("image.png");
  });
  it("rejects a selected modified file that has no textual change", async () => {
    const f = file("/a/same.ts");
    await expect(
      buildCommitDiff({
        status: [f],
        checks: new Map(),
        excludedHunks: new Map(),
        roots: ["/a"],
        io: {
          isBinary: async () => false,
          readRevision: async () => "same",
          readWorking: async () => "same",
          hunks: async () => [],
          patch: async () => "",
        },
      }),
    ).rejects.toThrow("same.ts");
  });
  it("describes an added empty file even though it has no line hunks", async () => {
    const f = file("/a/empty.ts", { unstaged: "untracked" });
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map([[f.path, "all"]]),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: {
        isBinary: async () => false,
        readRevision: async () => null,
        readWorking: async () => "",
        hunks: async () => [],
        patch: async () => "",
      },
    });
    expect(result).toContain("empty.ts");
    expect(result).toContain("added");
  });
  it("caps large diffs on Unicode character boundaries and marks truncation", async () => {
    const f = file("/a/large.ts");
    const result = await buildCommitDiff({
      status: [f],
      checks: new Map(),
      excludedHunks: new Map(),
      roots: ["/a"],
      io: {
        isBinary: async () => false,
        readRevision: async () => "old",
        readWorking: async () => "new",
        hunks: async () => [hunk(0, "old")],
        patch: async () => "😀".repeat(20_000),
      },
    });
    expect(Array.from(result).length).toBeGreaterThan(12_000);
    const limited = limitCommitDiff(result);
    expect(Array.from(limited).length).toBeLessThanOrEqual(12_000);
    expect(limited).toContain("truncated");
    expect(limited).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("commit message async generation", () => {
  it("writes a successful response when the draft and project remain unchanged", async () => {
    const setMessage = vi.fn();
    const state = { project: "/a", message: "draft", changes: 0 };
    const result = await runCommitMessageGeneration({
      getState: () => ({ ...state }),
      setMessage,
      makeDiff: async () => "diff",
      generate: async () => "feat: message",
    });
    expect(result).toBe("applied");
    expect(setMessage).toHaveBeenCalledWith("feat: message");
  });
  it("does not overwrite a draft edited while the request was running", async () => {
    const setMessage = vi.fn();
    const state = { project: "/a", message: "draft", changes: 0 };
    const result = await runCommitMessageGeneration({
      getState: () => ({ ...state }),
      setMessage,
      makeDiff: async () => "diff",
      generate: async () => {
        state.message = "user edited";
        state.changes++;
        return "generated";
      },
    });
    expect(result).toBe("changed");
    expect(setMessage).not.toHaveBeenCalled();
  });
  it("does not write into a different project or after selection changes", async () => {
    for (const change of ["project", "changes"] as const) {
      const setMessage = vi.fn();
      const state = { project: "/a", message: "draft", changes: 0 };
      const result = await runCommitMessageGeneration({
        getState: () => ({ ...state }),
        setMessage,
        makeDiff: async () => "diff",
        generate: async () => {
          if (change === "project") state.project = "/b";
          else state.changes++;
          return "generated";
        },
      });
      expect(result).toBe("changed");
      expect(setMessage).not.toHaveBeenCalled();
    }
  });
  it("never sends a diff when the selection changes while it is being assembled", async () => {
    const state = { project: "/a", message: "draft", changes: 0 };
    const generate = vi.fn(async () => "generated");
    const result = await runCommitMessageGeneration({
      getState: () => ({ ...state }),
      setMessage: vi.fn(),
      makeDiff: async () => {
        state.changes++;
        return "outdated diff";
      },
      generate,
    });
    expect(result).toBe("changed");
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not apply a generated message if selected file contents change during the request", async () => {
    const state = { project: "/a", message: "draft", changes: 0 };
    const setMessage = vi.fn();
    let diff = "before";
    const result = await runCommitMessageGeneration({
      getState: () => ({ ...state }),
      setMessage,
      makeDiff: async () => diff,
      generate: async () => {
        diff = "after";
        return "generated";
      },
    });
    expect(result).toBe("changed");
    expect(setMessage).not.toHaveBeenCalled();
  });
  it("does not send a diff if file content changed while the snapshot was assembled", async () => {
    const state = { project: "/a", message: "draft", changes: 0 };
    let call = 0;
    const generate = vi.fn(async () => "generated");
    const result = await runCommitMessageGeneration({
      getState: () => ({ ...state }),
      setMessage: vi.fn(),
      makeDiff: async () => (++call === 1 ? "before" : "after"),
      generate,
    });
    expect(result).toBe("changed");
    expect(generate).not.toHaveBeenCalled();
  });
  it("also detects changes beyond the prompt length limit", async () => {
    const state = { project: "/a", message: "draft", changes: 0 };
    let diff = "a".repeat(12_001) + "before";
    const setMessage = vi.fn();
    const result = await runCommitMessageGeneration({
      getState: () => ({ ...state }),
      setMessage,
      makeDiff: async () => diff,
      generate: async () => {
        diff = "a".repeat(12_001) + "after";
        return "generated";
      },
    });
    expect(result).toBe("changed");
    expect(setMessage).not.toHaveBeenCalled();
  });
  it("does not alter the draft if generation fails or returns an empty message", async () => {
    const setMessage = vi.fn();
    const opts = {
      getState: () => ({ project: "/a", message: "draft", changes: 0 }),
      setMessage,
      makeDiff: async () => "diff",
    };
    await expect(
      runCommitMessageGeneration({
        ...opts,
        generate: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    await expect(runCommitMessageGeneration({ ...opts, generate: async () => "  " })).rejects.toThrow();
    expect(setMessage).not.toHaveBeenCalled();
  });
});
