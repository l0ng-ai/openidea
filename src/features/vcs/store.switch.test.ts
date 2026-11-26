import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, FileStatus, ProjectInfo, VcsRoot } from "@/bindings";
import { commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { deferred } from "@/test/deferred";
import { getFileDecoration } from "@/workbench/contributions";
import {
  applyStatus,
  discoverRoots,
  installVcsStore,
  onConflictsChanged,
  onConflictsCleared,
  refreshNow,
  refreshPathsNow,
  useVcs,
} from "./store";

vi.mock(import("@/platform/ipc"), async (original) => ({
  ...(await original()),
  isTauri: vi.fn(() => false),
}));

const git: ProjectInfo = { root: "/a", name: "a", isGit: true, trusted: true, settings: {} };
const nonGit: ProjectInfo = { root: "/b", name: "b", isGit: false, trusted: true, settings: {} };
const branch: BranchInfo = {
  head: "feature-a",
  headCommit: "abc1234",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: "merge",
};
const roots: VcsRoot[] = [
  {
    root: git.root,
    branchRoot: git.root,
    head: branch.head,
    headCommit: branch.headCommit,
    operation: "merge",
    shallow: false,
  },
];
const conflicted: FileStatus = {
  path: "/a/src/conflict.ts",
  relPath: "src/conflict.ts",
  staged: null,
  unstaged: "conflicted",
  renamedFrom: null,
};
const modified: FileStatus = {
  ...conflicted,
  path: "/a/src/edited.ts",
  relPath: "src/edited.ts",
  unstaged: "modified",
};
const status = [conflicted, modified];

type Ok<T> = { status: "ok"; data: T };
const ok = <T>(data: T): Ok<T> => ({ status: "ok", data });

let dispose: () => void;
const appeared = vi.fn();
const cleared = vi.fn();

beforeEach(() => {
  vi.spyOn(commands, "vcsRoots").mockResolvedValue(ok(roots));
  vi.spyOn(commands, "vcsStatus").mockResolvedValue(ok(status));
  vi.spyOn(commands, "vcsBranchInfo").mockResolvedValue(ok(branch));
  onConflictsChanged(appeared);
  onConflictsCleared(cleared);
  dispose = installVcsStore();
});

afterEach(() => {
  dispose();
  onConflictsChanged(() => undefined);
  onConflictsCleared(() => undefined);
  appeared.mockClear();
  cleared.mockClear();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReset();
  useProject.setState(useProject.getInitialState(), true);
  useVcs.setState(useVcs.getInitialState(), true);
});

it("updates the notification as conflicts are resolved and reopened", () => {
  const sibling: FileStatus = { ...modified, unstaged: "conflicted" };
  applyStatus([conflicted, sibling], branch);
  applyStatus([conflicted, modified], branch);
  applyStatus([conflicted, modified], branch);
  applyStatus([conflicted, sibling], branch);
  applyStatus([modified], branch);

  expect(appeared.mock.calls).toEqual([[[conflicted, sibling]], [[conflicted]], [[conflicted, sibling]]]);
  expect(cleared).toHaveBeenCalledOnce();
});

describe("VCS status ownership", () => {
  it.each([
    { command: "status", reopen: false },
    { command: "roots", reopen: false },
    { command: "status", reopen: true },
  ])("drops a late $command response after switching projects (reopen: $reopen)", async ({ command, reopen }) => {
    const response = deferred<void>();
    const request =
      command === "status"
        ? vi.mocked(commands.vcsStatus).mockReturnValueOnce(response.promise.then(() => ok(status)))
        : vi.mocked(commands.vcsRoots).mockReturnValueOnce(response.promise.then(() => ok(roots)));
    useProject.setState({ project: git });
    const refreshing = refreshNow();
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      // Emulate desktop discovery of nested roots for the non-Git project; there are none.
      vi.mocked(isTauri).mockReturnValueOnce(true);
      vi.mocked(commands.vcsRoots).mockResolvedValueOnce(ok([]));
      useProject.setState({ project: nonGit });
      const current = reopen ? { ...git } : nonGit;
      if (reopen) useProject.setState({ project: current });
      const reset = useVcs.getState();
      expect(reset).toMatchObject({ root: current.root, status: [], branch: null, statusLoaded: false });

      response.resolve();
      await refreshing;

      expect(useProject.getState().project).toBe(current);
      expect.soft(useVcs.getState()).toEqual(reset);
      expect.soft(getFileDecoration(conflicted.path)).toBeUndefined();
      expect.soft(getFileDecoration(modified.path)).toBeUndefined();
      expect.soft(appeared).not.toHaveBeenCalled();
      expect.soft(cleared).not.toHaveBeenCalled();
    } finally {
      response.resolve();
      await refreshing;
    }
  });

  it("does not publish an old refresh error in the new project", async () => {
    const reply = deferred<Ok<FileStatus[]>>();
    const request = vi.mocked(commands.vcsStatus).mockReturnValueOnce(reply.promise);
    useProject.setState({ project: git });
    const refreshing = refreshNow();
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      useProject.setState({ project: nonGit });
      const reset = useVcs.getState();

      reply.reject(new Error("project A's Git status failed"));
      await refreshing;

      expect(useVcs.getState()).toEqual(reset);
    } finally {
      reply.resolve(ok(status));
      await refreshing;
    }
  });

  it("does not enable VCS from a discovery started before reopening the same folder", async () => {
    const reply = deferred<Ok<VcsRoot[]>>();
    const request = vi.mocked(commands.vcsRoots).mockReturnValueOnce(reply.promise);
    const folder = { ...git, isGit: false };
    useProject.setState({ project: folder });
    vi.mocked(isTauri).mockReturnValueOnce(true);
    const discovering = discoverRoots();
    // Drain any incorrectly started full refresh before disposing.
    const refreshed = deferred<void>();
    const offRefresh = useVcs.subscribe((s, prev) => {
      if (prev.loading && !s.loading) refreshed.resolve();
    });
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      useProject.setState({ project: nonGit });
      useProject.setState({ project: { ...folder } });

      reply.resolve(ok(roots));
      await discovering;
      if (useVcs.getState().loading) await refreshed.promise;

      expect.soft(useVcs.getState()).toMatchObject({ root: folder.root, available: false, roots: [], status: [] });
      expect.soft(commands.vcsStatus).not.toHaveBeenCalled();
    } finally {
      reply.resolve(ok([]));
      await discovering;
      if (useVcs.getState().loading) await refreshed.promise;
      offRefresh();
    }
  });

  it("drains a queued refresh for the new project without retrying the old incremental refresh", async () => {
    useProject.setState({ project: git });
    await refreshNow();
    const reply = deferred<Ok<FileStatus[]>>();
    const request = vi.spyOn(commands, "vcsStatusPaths").mockReturnValueOnce(reply.promise);
    const refreshing = refreshPathsNow([conflicted.path]);
    let next: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith([conflicted.path]));
      const nextBranch = { ...branch, head: "main", operation: null };
      vi.mocked(commands.vcsRoots).mockResolvedValue(
        ok([
          {
            root: nonGit.root,
            branchRoot: nonGit.root,
            head: nextBranch.head,
            headCommit: nextBranch.headCommit,
            operation: null,
          },
        ]),
      );
      vi.mocked(commands.vcsStatus).mockResolvedValue(ok([]));
      vi.mocked(commands.vcsBranchInfo).mockResolvedValue(ok(nextBranch));
      vi.mocked(isTauri).mockReturnValueOnce(true);
      useProject.setState({ project: { ...nonGit, isGit: true } });
      next = refreshNow();

      reply.resolve(ok([conflicted]));
      await Promise.all([refreshing, next]);

      expect(useVcs.getState()).toMatchObject({ root: nonGit.root, status: [], branch: nextBranch });
      expect(getFileDecoration(conflicted.path)).toBeUndefined();
      expect(commands.vcsStatus).toHaveBeenCalledTimes(2);
    } finally {
      reply.resolve(ok([]));
      await Promise.all([refreshing, next]);
    }
  });

  it("applies branch, changed files, decorations and conflict notifications for the active project", async () => {
    useProject.setState({ project: git });
    await refreshNow();

    expect(useVcs.getState()).toMatchObject({ root: git.root, roots: [git.root], branch, status, statusLoaded: true });
    expect(useVcs.getState().byPath).toEqual(new Map(status.map((file) => [file.path, file])));
    expect(getFileDecoration(conflicted.path)?.color).toBe("var(--vcs-conflict)");
    expect(getFileDecoration(modified.path)?.color).toBe("var(--vcs-modified)");
    expect(appeared).toHaveBeenCalledExactlyOnceWith([conflicted]);
    expect(cleared).not.toHaveBeenCalled();
  });

  it("clears the previous Git state when Directory Mappings removes the last repository", async () => {
    useProject.setState({ project: git });
    await refreshNow();
    expect(getFileDecoration(modified.path)?.color).toBe("var(--vcs-modified)");

    vi.mocked(commands.vcsRoots).mockResolvedValue(ok([]));
    vi.mocked(commands.vcsStatus).mockRejectedValue(new Error("project is not a git repository"));
    vi.mocked(commands.vcsBranchInfo).mockRejectedValue(new Error("repository was removed"));
    await refreshNow();

    expect(useVcs.getState()).toMatchObject({
      root: git.root,
      available: false,
      roots: [],
      repo: null,
      status: [],
      branch: null,
      branches: [],
      heads: {},
      operations: {},
      error: null,
    });
    expect(getFileDecoration(modified.path)).toBeUndefined();
  });

  it("refreshes branch lists and status when Directory Mappings removes the selected repository", async () => {
    useProject.setState({ project: git });
    await refreshNow();
    useVcs.setState({ branchesLoaded: true });
    const remaining = "/a/remaining";
    const remainingBranch: Branch = {
      name: "main",
      remote: false,
      current: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      lastCommitMs: 0,
      commit: "def1234",
    };
    const remainingStatus = { ...modified, path: remaining + "/src/edited.ts" };
    vi.mocked(commands.vcsRoots).mockResolvedValue(
      ok([{ root: remaining, branchRoot: remaining, head: "main", headCommit: "def1234", operation: null }]),
    );
    vi.mocked(commands.vcsStatus).mockResolvedValue(ok([remainingStatus]));
    vi.mocked(commands.vcsBranchInfo).mockImplementation(async (repo) => {
      if (repo === git.root) throw new Error("repository was removed");
      return ok({ ...branch, head: "main", headCommit: "def1234", operation: null });
    });
    const listBranches = vi.spyOn(commands, "vcsBranches").mockImplementation(async (repo) => {
      if (repo === git.root) throw new Error("repository was removed");
      return ok([remainingBranch]);
    });

    await refreshNow();
    await vi.waitFor(() =>
      expect(useVcs.getState()).toMatchObject({
        available: true,
        roots: [remaining],
        repo: remaining,
        status: [remainingStatus],
        branches: [remainingBranch],
      }),
    );
    expect(listBranches).toHaveBeenLastCalledWith(remaining);
    expect(getFileDecoration(modified.path)).toBeUndefined();
    expect(getFileDecoration(remainingStatus.path)?.color).toBe("var(--vcs-modified)");
  });
});
