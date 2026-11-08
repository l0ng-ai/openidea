import { beforeEach, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, Worktree } from "@/bindings";
const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  worktrees: vi.fn(),
}));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  promptText: mocks.prompt,
  confirmDialog: mocks.confirm,
}));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify, expire: vi.fn() }) }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsWorktrees: mocks.worktrees,
      vcsRemoveWorktree: mocks.removeWorktree,
      vcsDeleteBranch: mocks.deleteBranch,
    },
  };
});
import { deleteBranch, newBranch, newBranchInRepos, renameBranch } from "../branchOps";
import { useVcs } from "../store";

const branch = (head: string | null): BranchInfo => ({
  head,
  headCommit: "abc1234567890",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
});

const local = (name: string, current = false): Branch => ({
  name,
  remote: false,
  current,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The current branch is always among the local branches, so the suggestion names an existing one.
  useVcs.setState({
    root: "/p",
    repo: "/p/front",
    roots: ["/p/front"],
    branch: branch("feature/ui"),
    branches: [local("feature/ui", true), local("main")],
    available: false,
  });
  // Cancel: only what the dialog was offered matters here, not its outcome.
  mocks.prompt.mockResolvedValue(null);
});

it("prefills a plain New Branch with the current branch name", async () => {
  await newBranch();
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("feature/ui");
  expect(mocks.prompt.mock.calls[0]?.[0].validateInitial).toBe(true);
});

it("prefills nothing when HEAD is detached", async () => {
  useVcs.setState({ branch: branch(null) });
  await newBranch();
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("");
});

it("still suggests a remote branch's name without the prefix", async () => {
  await newBranch("origin/main");
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("main");
});

it("prefills the current branch in the multi-repository dialog too", async () => {
  await newBranchInRepos(["/p/front", "/p/back"]);
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("feature/ui");
});

it.each([
  ["New Branch", () => newBranch()],
  ["New Branch from a revision", () => newBranch("origin/main")],
  ["New Branch in several repositories", () => newBranchInRepos(["/p/front", "/p/back"])],
  ["Rename Branch", () => renameBranch("main")],
])("%s turns a typed space into a separator, as IDEA does", async (_name, open) => {
  await open();
  const { sanitize, validate } = mocks.prompt.mock.calls[0]![0];
  const typed: string = sanitize("fix login");
  expect(typed).toBe("fix-login");
  expect(validate(typed)).toBeNull();
});

const worktree = (path: string, branchName: string | null, main = false): Worktree => ({
  path,
  head: "abc1234567890",
  branch: branchName,
  main,
  locked: false,
  prunable: false,
});

const deleted = { name: "feature/wt", tip: "abc1234567890", upstream: null, unmerged: false };
const ok = (data: unknown) => ({ status: "ok", data });

beforeEach(() => {
  mocks.deleteBranch.mockResolvedValue(ok(deleted));
  mocks.removeWorktree.mockResolvedValue(ok(null));
});

it("deletes a worktree holding the branch before deleting it", async () => {
  mocks.worktrees.mockResolvedValue(
    ok([worktree("/p/front", "main", true), worktree("/p/front-feature-wt", "feature/wt")]),
  );
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  expect(mocks.confirm.mock.calls[0]?.[0].message).toContain("/p/front-feature-wt");
  expect(mocks.removeWorktree).toHaveBeenCalledWith("/p/front", "/p/front-feature-wt", false);
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/front", "feature/wt");
});

it("keeps the branch when the worktree question is turned down", async () => {
  mocks.worktrees.mockResolvedValue(ok([worktree("/p/front-feature-wt", "feature/wt")]));
  mocks.confirm.mockResolvedValue(false);
  await deleteBranch("feature/wt");
  expect(mocks.removeWorktree).not.toHaveBeenCalled();
  expect(mocks.deleteBranch).not.toHaveBeenCalled();
});

it("never offers to delete this window's worktrees or the main one", async () => {
  useVcs.setState({ roots: ["/p/front-feature-wt"] });
  mocks.worktrees.mockResolvedValue(
    ok([worktree("/p/front", "feature/wt", true), worktree("/p/front-feature-wt", "feature/wt")]),
  );
  await deleteBranch("feature/wt");
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.removeWorktree).not.toHaveBeenCalled();
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/front", "feature/wt");
});
