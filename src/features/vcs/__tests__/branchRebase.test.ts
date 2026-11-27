import type { BranchInfo, BranchRebasePlan, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { beforeEach, expect, it, vi } from "vitest";
import { pausedBranchRebase, rebaseOntoBranch, runBranchRebases, type PlannedRebase } from "../branchRebase";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  branches: vi.fn(),
  operation: vi.fn(),
  restore: vi.fn(),
  notify: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: async (result: unknown) => result,
  commands: {
    vcsBranchInfo: mocks.info,
    vcsBranches: mocks.branches,
    vcsOperation: mocks.operation,
    vcsRestoreHead: mocks.restore,
  },
}));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof import("@/workbench/messages")>()),
  ask: mocks.ask,
}));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runOp: async (_label: string, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch {
      return undefined;
    }
  },
  runGitOperationWith: async (
    _description: string,
    options: { onError: () => Promise<boolean> },
    run: (context: { request: number; output(): null; cancelled(): boolean }) => Promise<unknown>,
  ) => {
    try {
      await run({ request: 1, output: () => null, cancelled: () => false });
      return true;
    } catch {
      await options.onError();
      return false;
    }
  },
  startShelfBatch: () => ({ id: "batch", finish: async () => null }),
}));
vi.mock("../operations", () => ({
  conflictsInstead: async () => true,
  rebaseFeedback: () => ({}),
}));

const target = { branch: { name: "origin/topic", remote: true }, repos: ["/a", "/b", "/c"] };
const info = new Map<string, Partial<BranchInfo>>();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ask.mockResolvedValue({ button: "keep" });
  info.clear();
  useProject.setState({ project: { name: "p", root: "/p" } as ProjectInfo });
  for (const root of target.repos) info.set(root, { head: "main", headCommit: `${root}-old`, operation: null });
  mocks.info.mockImplementation(async (root: string) => info.get(root));
  mocks.branches.mockImplementation(async (root: string) => [
    { name: "origin/topic", remote: false, commit: "other" },
    { name: "origin/topic", remote: true, commit: `${root}-target` },
  ]);
  mocks.operation.mockImplementation(async (root: string, _request: number, { plan }: { plan: BranchRebasePlan }) => {
    if (root === "/b") {
      info.set(root, { operation: "rebase", rebase: { original: plan.head, onto: plan.onto } });
      throw new Error("Conflict");
    }
    return { rebased: { branch: "main", commit: `${root}-new` } };
  });
});

it("pins the exact remote target in each repository and resumes the remaining roots after a pause", async () => {
  await rebaseOntoBranch(target);
  expect(mocks.operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b"]);
  expect(mocks.operation.mock.calls[0]?.[2]).toMatchObject({
    op: "rebaseBranch",
    plan: { target: "refs/remotes/origin/topic", onto: "/a-target", head: { branch: "main", commit: "/a-old" } },
  });
  const pause = await pausedBranchRebase("/b");
  expect(pause?.completedRoots).toEqual(["/a"]);
  expect(pause?.state).toEqual({ original: { branch: "main", commit: "/b-old" }, onto: "/b-target" });
  await pause?.resume({ branch: "main", commit: "/b-new" });
  expect(mocks.operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b", "/c"]);
  expect(await pausedBranchRebase("/b")).toBeUndefined();
  expect(mocks.restore).not.toHaveBeenCalled();
});

it("rolls back only repositories with receipts and leaves later roots untouched on abort", async () => {
  await rebaseOntoBranch(target);
  const pause = await pausedBranchRebase("/b");
  expect(pause?.completedRoots).toEqual(["/a"]);
  await pause?.abort(true);
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith("/a", "/a-old", "/a-new", "main", null);
  expect(mocks.operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b"]);
});

const checkoutPlans: PlannedRebase[] = target.repos.map((root) => {
  const original = { branch: "topic", commit: `${root}-topic` };
  const base = { branch: "main", commit: `${root}-old` };
  return {
    root,
    operation: {
      op: "checkoutRebase",
      plan: { base, branch: original.branch, branchTip: original.commit, remote: null },
    },
    state: { original, onto: base.commit },
  };
});
const checkoutFeedback = { progress: "Checkout and Rebase", failure: "Checkout and Rebase failed", success: "Rebased" };

it("resumes pending checkouts after a conflict on the selected branch", async () => {
  mocks.operation.mockImplementation(async (root: string) => {
    if (root === "/b") {
      info.set(root, { operation: "rebase", rebase: checkoutPlans[1]!.state });
      throw new Error("Conflict");
    }
    return { rebased: { branch: "topic", commit: `${root}-rebased` } };
  });
  await runBranchRebases(checkoutPlans, checkoutFeedback);
  expect(mocks.operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b"]);
  const pause = await pausedBranchRebase("/b");
  expect(pause?.completedRoots).toEqual(["/a"]);
  await pause?.resume({ branch: "topic", commit: "/b-rebased" });
  expect(mocks.operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b", "/c"]);
});

it("rolls back a completed checkout even when its branch tip did not change", async () => {
  mocks.operation.mockImplementation(async (root: string) => {
    if (root === "/b") throw new Error("Rebase refused");
    return { rebased: { branch: "topic", commit: `${root}-topic` } };
  });
  mocks.ask.mockResolvedValue({ button: "rollback" });
  await runBranchRebases(checkoutPlans, checkoutFeedback);
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith("/a", "/a-topic", "/a-topic", "topic", {
    branch: "main",
    commit: "/a-old",
  });
  expect(mocks.operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b"]);
});

it("refuses the whole branch action when any selected repository has detached HEAD", async () => {
  info.set("/c", { head: null, headCommit: "/c-old" });
  await rebaseOntoBranch(target);
  expect(mocks.operation).not.toHaveBeenCalled();
});
