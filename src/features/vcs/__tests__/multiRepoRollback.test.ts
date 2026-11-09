import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  merge: vi.fn(),
  restore: vi.fn(),
  heads: {} as Record<string, string>,
  ops: {} as Record<string, string | null>,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "failed", message } });
  return {
    ...real,
    isTauri: () => false,
    call: async (p: Promise<{ status: string; data?: unknown; error?: unknown }>) => {
      const r = await p;
      if (r.status === "error") throw r.error;
      return r.data;
    },
    commands: {
      ...real.commands,
      vcsBranchInfo: (root: string) =>
        ok({ head: "main", headCommit: mocks.heads[root], operation: mocks.ops[root] ?? null }),
      vcsMerge: (root: string, branch: string) => {
        mocks.merge(root, branch);
        if (root === "/b") return fail("merge refused");
        mocks.heads[root] = `${root}-merged`;
        return ok(null);
      },
      vcsRestoreHead: (root: string, before: string, after: string) => {
        mocks.restore(root, before, after);
        return ok(null);
      },
    },
  };
});
vi.mock("@/workbench/messages", () => ({ ask: mocks.ask, showError: vi.fn() }));

import { mergeInRepos } from "../branchOps";
import { pendingFixup } from "../commitStore";
import type { Commit } from "@/bindings";

describe("an operation over several repositories that fails part way (IDEA's rollback proposal)", () => {
  beforeEach(() => {
    mocks.ask.mockReset();
    mocks.merge.mockReset();
    mocks.restore.mockReset();
    mocks.heads = { "/a": "a1", "/b": "b1", "/c": "c1" };
    mocks.ops = {};
  });

  it("offers to reset the repositories it already merged, and does so on Rollback", async () => {
    mocks.ask.mockResolvedValue({ button: "rollback" });
    await mergeInRepos("feature", ["/a", "/b", "/c"]);
    expect(mocks.merge.mock.calls.map((c) => c[0])).toEqual(["/a", "/b"]);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.restore).toHaveBeenCalledWith("/a", "a1", "/a-merged");
  });

  it("leaves them merged on Don't Rollback", async () => {
    mocks.ask.mockResolvedValue({ button: "keep" });
    await mergeInRepos("feature", ["/a", "/b"]);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("doesn't ask when the failed repository stopped on conflicts", async () => {
    mocks.ops = { "/b": "merge" };
    await mergeInRepos("feature", ["/a", "/b"]);
    expect(mocks.ask).not.toHaveBeenCalled();
  });
});

describe("Commit and Rebase after Fixup…", () => {
  const target = { id: "c1", summary: "Add parser" } as Commit;
  it("is offered while the message is the one prepared for the target", () => {
    expect(pendingFixup("fixup! Add parser", target)).toBe(target);
    expect(pendingFixup("squash! Add parser\n\nmore", target)).toBe(target);
    expect(pendingFixup("Something else", target)).toBeNull();
    expect(pendingFixup("fixup! Add parser", null)).toBeNull();
  });
});
