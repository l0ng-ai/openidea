import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  merge: vi.fn(),
  mergeMode: vi.fn(),
  mergePreview: vi.fn(),
  mergeBlockers: {} as Record<string, string[]>,
  mergeConflicts: new Set<string>(),
  upToDate: new Set<string>(),
  failedMerge: "/b" as string | null,
  branches: vi.fn(),
  deleteMergedBranch: vi.fn(),
  restoreBranch: vi.fn(),
  execute: vi.fn(),
  checkout: vi.fn(),
  checkoutMode: vi.fn(),
  checkoutPreview: vi.fn(),
  checkoutReview: vi.fn(),
  localChanges: {} as Record<string, string[]>,
  rename: vi.fn(),
  prompt: vi.fn(),
  restore: vi.fn(),
  finishShelfBatch: vi.fn(),
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
      vcsMerge: (root: string, branch: string, batch: string | null, smart: boolean) => {
        mocks.merge(root, branch, batch);
        mocks.mergeMode(root, smart);
        const files = mocks.mergeBlockers[root];
        if (files?.length && !smart) return ok({ kind: "localChanges", files });
        if (root === mocks.failedMerge) return fail("merge refused");
        if (mocks.mergeConflicts.has(root)) {
          mocks.ops[root] = "merge";
          return ok({ kind: "conflicts" });
        }
        if (mocks.upToDate.has(root)) return ok({ kind: "alreadyUpToDate" });
        mocks.heads[root] = `${root}-merged`;
        return ok({ kind: "done" });
      },
      vcsMergeAffectedFiles: (roots: string[], rev: string) => ok(mocks.mergePreview(roots, rev)),
      vcsBranches: (root: string) => ok(mocks.branches(root)),
      vcsDeleteMergedBranch: (root: string, branch: string, tip: string) =>
        mocks.deleteMergedBranch(root, branch, tip)
          ? ok({ name: branch, tip, upstream: null, unmerged: false })
          : fail("branch changed since merge"),
      vcsRestoreBranch: (root: string, branch: unknown) => ok(mocks.restoreBranch(root, branch)),
      vcsFinishShelfBatch: (batch: string, roots: string[]) => {
        mocks.finishShelfBatch(batch, roots);
        return ok(null);
      },
      vcsRenameBranch: (root: string, from: string, to: string, unset: boolean) => {
        mocks.rename(root, from, to, unset);
        if (root === "/b" && from === "feature") return fail("a branch named 'feature2' already exists");
        return ok(null);
      },
      vcsCheckout: (root: string, rev: string, _create: boolean, options: { mode: string }) => {
        mocks.checkout(root, rev);
        mocks.checkoutMode(root, options.mode);
        const files = mocks.localChanges[root];
        if (files?.length && options.mode === "normal") return ok({ kind: "localChanges", files });
        mocks.heads[root] = `${root}-${rev}`;
        return ok({ kind: "done" });
      },
      vcsCheckoutAffectedFiles: (roots: string[], rev: string) => ok(mocks.checkoutPreview(roots, rev)),
      vcsRestoreHead: (root: string, before: string, after: string) => {
        mocks.restore(root, before, after);
        return ok(null);
      },
    },
  };
});
vi.mock("@/workbench/messages", () => ({ ask: mocks.ask, showError: vi.fn() }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.execute,
}));
vi.mock("../LocalChangesReviewDialog", () => ({ reviewLocalChanges: mocks.checkoutReview }));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  promptText: mocks.prompt,
}));

import { branchRef, checkoutInRepos, mergeInRepos, mergeIntoCurrent, renameInRepos } from "../branchOps";
import { useVcs } from "../store";
import { pendingFixup } from "../commitStore";
import type { Commit, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { notifications, provideNotificationService, type NotificationService } from "@/workbench/contributions";

describe("an operation over several repositories that fails part way (IDEA's rollback proposal)", () => {
  beforeEach(() => {
    mocks.ask.mockReset();
    mocks.merge.mockReset();
    mocks.mergeMode.mockReset();
    mocks.mergePreview.mockReset();
    mocks.checkoutReview.mockReset();
    mocks.execute.mockReset();
    mocks.mergeBlockers = {};
    mocks.mergeConflicts.clear();
    mocks.upToDate.clear();
    mocks.failedMerge = "/b";
    mocks.restore.mockReset();
    mocks.finishShelfBatch.mockReset();
    mocks.heads = { "/a": "a1", "/b": "b1", "/c": "c1" };
    mocks.ops = {};
  });

  it("offers to reset the repositories it already merged, and does so on Rollback", async () => {
    mocks.ask.mockResolvedValue({ button: "rollback" });
    await mergeInRepos("feature", ["/a", "/b", "/c"]);
    const batch = mocks.merge.mock.calls[0]?.[2];
    expect(batch).toEqual(expect.any(String));
    expect(mocks.merge.mock.calls).toEqual([
      ["/a", "feature", batch],
      ["/b", "feature", batch],
    ]);
    expect(mocks.finishShelfBatch).toHaveBeenCalledExactlyOnceWith(batch, ["/a", "/b", "/c"]);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.restore).toHaveBeenCalledWith("/a", "a1", "/a-merged");
  });

  it("leaves them merged on Don't Rollback", async () => {
    mocks.ask.mockResolvedValue({ button: "keep" });
    await mergeInRepos("feature", ["/a", "/b"]);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("does not offer rollback for a repository that was already up to date", async () => {
    mocks.upToDate.add("/a");
    await mergeInRepos("feature", ["/a", "/b"]);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("doesn't ask when the failed repository stopped on conflicts", async () => {
    mocks.ops = { "/b": "merge" };
    await mergeInRepos("feature", ["/a", "/b"]);
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("reviews both blocked repositories together and opens one resolver after the merge round", async () => {
    mocks.failedMerge = null;
    mocks.mergeBlockers = { "/a": ["staged.txt"], "/b": ["incoming.txt"] };
    mocks.mergeConflicts = new Set(["/a", "/b"]);
    mocks.mergePreview.mockReturnValue([["/b", ["incoming.txt"]]]);
    mocks.checkoutReview.mockImplementation(async (_op, files) => ({ mode: "smart", files }));

    await mergeInRepos("feature", ["/a", "/b", "/c"]);

    expect(mocks.mergePreview).toHaveBeenCalledExactlyOnceWith(["/b", "/c"], "feature");
    expect(mocks.checkoutReview).toHaveBeenCalledExactlyOnceWith(
      "merge",
      [
        ["/a", ["staged.txt"]],
        ["/b", ["incoming.txt"]],
      ],
      true,
    );
    expect(mocks.mergeMode.mock.calls).toEqual([
      ["/a", false],
      ["/a", false],
      ["/a", true],
      ["/b", false],
      ["/b", true],
      ["/c", false],
    ]);
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("vcs.resolveConflicts", undefined);
  });

  it("leaves the blocked repositories untouched when Smart Merge is declined", async () => {
    mocks.mergeBlockers = { "/a": ["staged.txt"], "/b": ["incoming.txt"] };
    mocks.mergePreview.mockReturnValue([["/b", ["incoming.txt"]]]);
    mocks.checkoutReview.mockResolvedValue(null);

    await mergeInRepos("feature", ["/a", "/b"]);

    expect(mocks.mergeMode.mock.calls).toEqual([["/a", false]]);
    expect(mocks.heads).toMatchObject({ "/a": "a1", "/b": "b1" });
  });
});

describe("cleanup after a successful branch merge", () => {
  const notify = vi.fn<NotificationService["notify"]>();
  const expire = vi.fn();
  const previousService = notifications();
  const action = (label: string) =>
    notify.mock.calls.flatMap(([notice]) => notice.actions ?? []).find((action) => action.label === label);

  beforeEach(() => {
    notify.mockClear();
    expire.mockClear();
    provideNotificationService({ notify, expire });
    useProject.setState({ project: { root: "/project" } as ProjectInfo });
    mocks.failedMerge = null;
    mocks.mergeBlockers = {};
    mocks.mergeConflicts.clear();
    mocks.upToDate.clear();
    mocks.heads = { "/a": "a1", "/b": "b1" };
    mocks.ops = {};
    mocks.branches
      .mockReset()
      .mockImplementation((root: string) => [
        { name: "feature", remote: false, current: false, commit: `${root}-tip` },
      ]);
    mocks.deleteMergedBranch.mockReset().mockReturnValue(true);
    mocks.restoreBranch.mockReset();
  });

  afterEach(() => {
    useProject.setState({ project: null });
    provideNotificationService(previousService);
  });

  it("restores every deleted tip in its own repository from one notification", async () => {
    await mergeInRepos("feature", ["/a", "/b"], branchRef("feature", false));
    const remove = action("Delete feature");
    await remove?.run();
    expect(mocks.deleteMergedBranch.mock.calls).toEqual([
      ["/a", "feature", "/a-tip"],
      ["/b", "feature", "/b-tip"],
    ]);
    await action("Restore")?.run();
    expect(mocks.restoreBranch.mock.calls).toEqual([
      ["/a", { name: "feature", tip: "/a-tip", upstream: null, unmerged: false }],
      ["/b", { name: "feature", tip: "/b-tip", upstream: null, unmerged: false }],
    ]);
    expect(expire).toHaveBeenCalledTimes(2);
    await remove?.run();
    expect(mocks.deleteMergedBranch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [["/a", "/b"], "Already up to date in 2 repositories"],
    [["/a"], "Merged feature in 2 repositories"],
  ])("reports the result across the repositories and offers cleanup", async (unchanged, title) => {
    mocks.upToDate = new Set(unchanged);
    await mergeInRepos("feature", ["/a", "/b"], branchRef("feature", false));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title }));
    expect(action("Delete feature")).toBeDefined();
  });

  it("keeps the restore action for the successful repository when another tip has changed", async () => {
    mocks.deleteMergedBranch.mockImplementation((root: string) => root !== "/b");
    await mergeInRepos("feature", ["/a", "/b"], branchRef("feature", false));
    await action("Delete feature")?.run();
    await action("Restore")?.run();
    expect(mocks.restoreBranch).toHaveBeenCalledExactlyOnceWith("/a", {
      name: "feature",
      tip: "/a-tip",
      upstream: null,
      unmerged: false,
    });
  });

  it("leaves a success notice without a delete action after a partial merge", async () => {
    mocks.failedMerge = "/b";
    mocks.ask.mockResolvedValue({ button: "keep" });
    await mergeInRepos("feature", ["/a", "/b"], branchRef("feature", false));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Merged feature in 1 of 2 repositories" }));
    expect(action("Delete feature")).toBeUndefined();
  });

  it.each([
    ["main", "refs/heads/main"],
    ["origin/feature", "refs/remotes/origin/feature"],
    ["feature", "refs/tags/feature"],
  ])("does not offer to delete %s after merging %s", async (name, ref) => {
    await mergeIntoCurrent(name, "/a", ref);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: `Merged ${name} into HEAD` }));
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(action(`Delete ${name}`)).toBeUndefined();
  });

  it("ignores a delete action left over from the previous project", async () => {
    await mergeIntoCurrent("feature", "/a", branchRef("feature", false));
    const cleanup = action("Delete feature");
    expect(cleanup).toBeDefined();
    useProject.setState({ project: { root: "/other" } as ProjectInfo });
    await cleanup?.run();
    expect(mocks.deleteMergedBranch).not.toHaveBeenCalled();
  });
});

describe("checking out a common branch", () => {
  const heads = (h: Record<string, string>) =>
    useVcs.setState({
      heads: Object.fromEntries(Object.entries(h).map(([root, head]) => [root, { head, headCommit: `${root}1` }])),
    });
  beforeEach(() => {
    mocks.ask.mockReset();
    mocks.checkout.mockReset();
    mocks.checkoutMode.mockReset();
    mocks.checkoutPreview.mockReset().mockReturnValue([]);
    mocks.checkoutReview.mockReset();
    mocks.heads = { "/a": "a1", "/b": "b1", "/c": "c1" };
    heads({ "/a": "main", "/b": "main", "/c": "main" });
  });
  afterEach(() => {
    mocks.localChanges = {};
  });

  it("checks out only where it is not the current branch", async () => {
    heads({ "/a": "feature", "/b": "main" });
    await checkoutInRepos({ name: "feature", remote: false }, ["/a", "/b"]);
    expect(mocks.checkout.mock.calls).toEqual([["/b", "refs/heads/feature"]]);
  });

  it("does nothing when every repository is already on it", async () => {
    heads({ "/a": "feature", "/b": "feature" });
    await checkoutInRepos({ name: "feature", remote: false }, ["/a", "/b"]);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it.each(["smart", "force"])(
    "confirms %s checkout once for the tracked changes in both repositories",
    async (mode) => {
      mocks.localChanges = { "/a": ["same.txt"], "/b": ["same.txt"] };
      mocks.checkoutPreview.mockReturnValue([["/b", ["same.txt"]]]);
      mocks.checkoutReview.mockImplementation(async (_op, files) => ({ mode, files }));

      await checkoutInRepos({ name: "feature", remote: false }, ["/a", "/b", "/c"]);

      expect(mocks.checkoutPreview).toHaveBeenCalledExactlyOnceWith(["/b", "/c"], "refs/heads/feature");
      expect(mocks.checkoutReview).toHaveBeenCalledExactlyOnceWith(
        "checkout",
        [
          ["/a", ["same.txt"]],
          ["/b", ["same.txt"]],
        ],
        true,
      );
      expect(mocks.checkoutMode.mock.calls).toEqual([
        ["/a", "normal"],
        ["/a", "normal"],
        ["/a", mode],
        ["/b", "normal"],
        ["/b", mode],
        ["/c", "normal"],
      ]);
    },
  );

  it("can cancel the combined prompt before switching either affected repository", async () => {
    mocks.localChanges = { "/a": ["a.txt"], "/b": ["b.txt"] };
    mocks.checkoutPreview.mockReturnValue([["/b", ["b.txt"]]]);
    mocks.checkoutReview.mockResolvedValue(null);

    await checkoutInRepos({ name: "feature", remote: false }, ["/a", "/b"]);

    expect(mocks.checkoutReview).toHaveBeenCalledTimes(1);
    expect(mocks.checkoutMode.mock.calls).toEqual([["/a", "normal"]]);
    expect(mocks.heads).toMatchObject({ "/a": "a1", "/b": "b1" });
  });

  it("asks again when checkout finds a file outside the approved preview", async () => {
    mocks.localChanges = { "/a": ["a.txt"], "/b": ["b.txt", "new.txt"] };
    mocks.checkoutPreview.mockReturnValue([["/b", ["b.txt"]]]);
    mocks.checkoutReview
      .mockImplementationOnce(async (_op, files) => ({ mode: "force", files }))
      .mockResolvedValueOnce(null);
    mocks.ask.mockResolvedValue({ button: "keep" });

    await checkoutInRepos({ name: "feature", remote: false }, ["/a", "/b"]);

    expect(mocks.checkoutReview).toHaveBeenNthCalledWith(2, "checkout", [["/b", ["b.txt", "new.txt"]]], true);
    expect(mocks.checkoutMode.mock.calls).toEqual([
      ["/a", "normal"],
      ["/a", "normal"],
      ["/a", "force"],
      ["/b", "normal"],
    ]);
    expect(mocks.heads["/b"]).toBe("b1");
  });

  it("retries a repository normally after removing its blocking changes during review", async () => {
    mocks.localChanges = { "/a": ["a.txt"], "/b": ["b.txt"] };
    mocks.checkoutPreview.mockReturnValue([["/b", ["b.txt"]]]);
    mocks.checkoutReview.mockImplementation(async () => {
      delete mocks.localChanges["/a"];
      return { mode: "force", files: [["/b", ["b.txt"]]] };
    });

    await checkoutInRepos({ name: "feature", remote: false }, ["/a", "/b"]);

    expect(mocks.checkoutMode.mock.calls).toEqual([
      ["/a", "normal"],
      ["/a", "normal"],
      ["/b", "normal"],
      ["/b", "force"],
    ]);
  });
});

describe("renaming a common branch", () => {
  beforeEach(() => {
    mocks.ask.mockReset();
    mocks.rename.mockReset();
    mocks.prompt.mockReset().mockResolvedValue({ value: "feature2", checked: false });
    mocks.branches.mockReset().mockReturnValue([]);
    mocks.ops = {};
  });

  it("validates the namespace and remote names in every selected repository", async () => {
    mocks.branches.mockImplementation((repo) =>
      repo === "/b"
        ? [
            { name: "feature", remote: false },
            { name: "taken", remote: false },
            { name: "folder/leaf", remote: false },
            { name: "origin/folder", remote: true },
          ]
        : [{ name: "feature", remote: false }],
    );
    mocks.prompt.mockResolvedValue(null);
    await renameInRepos("feature", ["/a", "/b"], false);
    expect(mocks.branches.mock.calls).toEqual([["/a"], ["/b"]]);
    const { validate, prefixes } = mocks.prompt.mock.calls[0]![0];
    expect(validate("taken")).toBe("Branch 'taken' already exists (b)");
    expect(validate("folder")).toBe("Branch name 'folder' conflicts with 'folder/leaf' (b)");
    expect(validate("taken/new")).toBe("Branch name 'taken/new' conflicts with 'taken' (b)");
    expect(validate("origin/folder")).toBe("Branch name 'origin/folder' conflicts with a remote branch (b)");
    expect(validate("HeAd")).toBe("HEAD is a reserved keyword");
    expect(validate("feature/new")).toBeNull();
    expect(prefixes).toContain("folder/");
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("renames it in every repository", async () => {
    await renameInRepos("feature", ["/a", "/c"], false);
    expect(mocks.rename.mock.calls).toEqual([
      ["/a", "feature", "feature2", false],
      ["/c", "feature", "feature2", false],
    ]);
  });

  it("renames the first back after a failure in the second, on Rollback", async () => {
    mocks.ask.mockResolvedValue({ button: "rollback" });
    await renameInRepos("feature", ["/a", "/b", "/c"], false);
    expect(mocks.rename.mock.calls).toEqual([
      ["/a", "feature", "feature2", false],
      ["/b", "feature", "feature2", false],
      ["/a", "feature2", "feature", false],
    ]);
  });

  const recents = () => JSON.parse(localStorage.getItem("openidea.vcs.recentBranches:/p") ?? "[]");
  const keepRecents = () => {
    useVcs.setState({ root: "/p" });
    localStorage.setItem("openidea.vcs.recentBranches:/p", JSON.stringify(["feature", "main"]));
  };

  it("renames the branch in recent branches once it stayed renamed", async () => {
    keepRecents();
    await renameInRepos("feature", ["/a", "/c"], false);
    expect(recents()).toEqual(["feature2", "main"]);
  });

  it("leaves recent branches alone when the rename failed or was rolled back", async () => {
    keepRecents();
    await renameInRepos("feature", ["/b"], false);
    expect(recents()).toEqual(["feature", "main"]);
    mocks.ask.mockResolvedValue({ button: "rollback" });
    await renameInRepos("feature", ["/a", "/b"], false);
    expect(recents()).toEqual(["feature", "main"]);
  });

  it("unsets the upstream only after the branch was renamed in every repository", async () => {
    mocks.prompt.mockResolvedValue({ value: "feature2", checked: true });
    await renameInRepos("feature", ["/a", "/c"], true);
    expect(mocks.rename.mock.calls).toEqual([
      ["/a", "feature", "feature2", false],
      ["/c", "feature", "feature2", false],
      ["/a", "feature2", "feature2", true],
      ["/c", "feature2", "feature2", true],
    ]);
    mocks.rename.mockClear();
    mocks.ask.mockResolvedValue({ button: "rollback" });
    await renameInRepos("feature", ["/a", "/b"], true);
    expect(mocks.rename.mock.calls.some((c) => c[3] === true)).toBe(false);
  });

  it("unsets upstream in the repositories whose renames the user keeps", async () => {
    keepRecents();
    mocks.prompt.mockResolvedValue({ value: "feature2", checked: true });
    mocks.ask.mockResolvedValue({ button: "keep" });
    await renameInRepos("feature", ["/a", "/b", "/c"], true);
    expect(mocks.rename.mock.calls).toEqual([
      ["/a", "feature", "feature2", false],
      ["/b", "feature", "feature2", false],
      ["/a", "feature2", "feature2", true],
    ]);
    expect(recents()).toEqual(["feature2", "feature", "main"]);
  });

  it("offers to unset the upstream only when the branch has one", async () => {
    await renameInRepos("feature", ["/a"], true);
    expect(mocks.prompt.mock.calls[0]![0].checkbox).toEqual({ label: "Unset upstream branch", initial: false });
    mocks.prompt.mockClear();
    await renameInRepos("feature", ["/a"], false);
    expect(mocks.prompt.mock.calls[0]![0].checkbox).toBeUndefined();
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
