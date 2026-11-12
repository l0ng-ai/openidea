import { beforeEach, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, ProjectInfo, Worktree } from "@/bindings";
const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  worktrees: vi.fn(),
  restoreBranch: vi.fn(),
  branches: vi.fn(),
  rename: vi.fn(),
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
      vcsRestoreBranch: mocks.restoreBranch,
      vcsBranches: mocks.branches,
      vcsRenameBranch: mocks.rename,
    },
  };
});
import { deleteBranch, deleteBranches, newBranch, newBranchInRepos, renameBranch } from "../branchOps";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

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
  vi.resetAllMocks();
  useProject.setState({ project: { root: "/p", name: "p" } as ProjectInfo });
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
  ["Rename Branch", () => renameBranch(local("main"))],
])("%s turns a typed space into a separator, as IDEA does", async (_name, open) => {
  await open();
  const { sanitize, validate } = mocks.prompt.mock.calls[0]![0];
  const typed: string = sanitize("fix login");
  expect(typed).toBe("fix-login");
  expect(validate(typed)).toBeNull();
});

const tracked = (name: string, upstream: string, current = false): Branch => ({ ...local(name, current), upstream });

it("offers to drop the upstream only for a branch that tracks one", async () => {
  await renameBranch(tracked("topic", "origin/topic"));
  expect(mocks.prompt.mock.calls[0]?.[0]).toMatchObject({
    initial: "topic",
    checkbox: { label: "Unset upstream branch", initial: false },
  });
  await renameBranch(local("plain"));
  expect(mocks.prompt.mock.calls[1]?.[0].checkbox).toBeUndefined();
});

it("renames with the tracking kept, or dropped when the box is ticked", async () => {
  mocks.prompt.mockResolvedValue({ value: "renamed", checked: false });
  await renameBranch(tracked("topic", "origin/topic"));
  expect(mocks.rename).toHaveBeenLastCalledWith("/p/front", "topic", "renamed", false);

  mocks.prompt.mockResolvedValue({ value: "renamed", checked: true });
  await renameBranch(tracked("topic", "origin/topic"));
  expect(mocks.rename).toHaveBeenLastCalledWith("/p/front", "topic", "renamed", true);

  // Nothing to drop on a branch without an upstream, whatever the box says.
  await renameBranch(local("plain"));
  expect(mocks.rename).toHaveBeenLastCalledWith("/p/front", "plain", "renamed", false);
});

it("shows a partial failure without claiming that the rename failed", async () => {
  const message = "Renamed branch 'topic' to 'renamed', but could not unset its upstream: config is locked";
  mocks.prompt.mockResolvedValue({ value: "renamed", checked: true });
  mocks.rename.mockResolvedValue({ status: "error", error: { kind: "io", message } });
  await renameBranch(tracked("topic", "origin/topic"));
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    group: "vcs",
    level: "error",
    title: "Rename branch topic",
    body: message,
  });
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
  mocks.restoreBranch.mockResolvedValue(ok(null));
  mocks.branches.mockResolvedValue(ok([]));
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

it("offers to delete a holding worktree even when the window has it open as a root", async () => {
  // A project opened on the parent folder has both worktrees as its roots.
  useVcs.setState({ roots: ["/p/front", "/p/front-feature-wt"] });
  mocks.worktrees.mockResolvedValue(
    ok([worktree("/p/front", "main", true), worktree("/p/front-feature-wt", "feature/wt")]),
  );
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  expect(mocks.removeWorktree).toHaveBeenCalledWith("/p/front", "/p/front-feature-wt", false);
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/front", "feature/wt");
});

it("keeps the branch checked out in the main worktree: git's own error stands", async () => {
  mocks.worktrees.mockResolvedValue(ok([worktree("/p/front", "feature/wt", true)]));
  await deleteBranch("feature/wt");
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.removeWorktree).not.toHaveBeenCalled();
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/front", "feature/wt");
});

it.each([
  ["/p/front", "/p/front"],
  ["/p/front/", "/p/front/"],
  ["/p/front", "/p/front/nested"],
  ["/p/front/", "/p/front/nested/"],
])("never offers to remove holding worktree %s containing project %s", async (path, root) => {
  useProject.setState({ project: { root, name: "project" } as ProjectInfo });
  mocks.worktrees.mockResolvedValue(ok([worktree(path, "feature/wt")]));
  mocks.confirm.mockResolvedValue(true);
  mocks.removeWorktree.mockRejectedValue(new Error("would reach Force Remove"));
  await deleteBranch("feature/wt");
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.removeWorktree).not.toHaveBeenCalled();
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/front", "feature/wt");
});

it("offers a prefix-only sibling of the project folder", async () => {
  useProject.setState({ project: { root: "/p/front-wt", name: "project" } as ProjectInfo });
  mocks.worktrees.mockResolvedValue(ok([worktree("/p/front", "feature/wt")]));
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  expect(mocks.removeWorktree).toHaveBeenCalledWith("/p/front", "/p/front", false);
});

it("ignores detached worktrees and matches the entire local branch name", async () => {
  mocks.worktrees.mockResolvedValue(
    ok([worktree("/p/detached", null), worktree("/p/wrong", "wt"), worktree("/p/right", "feature/wt")]),
  );
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  expect(mocks.removeWorktree).toHaveBeenCalledExactlyOnceWith("/p/front", "/p/right", false);
});

it("cancelling Force Remove keeps both the worktree and branch", async () => {
  mocks.worktrees.mockResolvedValue(ok([worktree("/p/wt", "feature/wt")]));
  mocks.removeWorktree.mockRejectedValue(new Error("fatal: '/p/wt' contains modified or untracked files"));
  mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await deleteBranch("feature/wt");
  expect(mocks.confirm.mock.calls[1]?.[0]).toMatchObject({
    message: "fatal: '/p/wt' contains modified or untracked files\n\nRemove it anyway, discarding its changes?",
    okLabel: "Force Remove",
    danger: true,
  });
  expect(mocks.removeWorktree).toHaveBeenCalledExactlyOnceWith("/p/front", "/p/wt", false);
  expect(mocks.deleteBranch).not.toHaveBeenCalled();
});

it("force removes a dirty worktree before deleting its branch", async () => {
  mocks.worktrees.mockResolvedValue(ok([worktree("/p/wt", "feature/wt")]));
  mocks.removeWorktree.mockRejectedValueOnce(new Error("dirty"));
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  expect(mocks.removeWorktree.mock.calls).toEqual([
    ["/p/front", "/p/wt", false],
    ["/p/front", "/p/wt", true],
  ]);
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/front", "feature/wt");
});

it("reports a locked worktree's force-removal error and keeps the branch", async () => {
  const error = "fatal: cannot remove a locked working tree; use 'remove -f -f' to override";
  mocks.worktrees.mockResolvedValue(ok([{ ...worktree("/p/wt", "feature/wt"), locked: true }]));
  mocks.removeWorktree.mockRejectedValue(new Error(error));
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  expect(mocks.deleteBranch).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: error }));
});

it.each([false, true])("continues a multi-repository selection after cancelling (force: %s)", async (force) => {
  mocks.worktrees.mockImplementation(async (repo) => ok([worktree(`${repo}/wt`, "feature/wt")]));
  if (force) {
    mocks.removeWorktree.mockRejectedValueOnce(new Error("dirty"));
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  } else mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await deleteBranches([
    { repo: "/p/front", branch: local("feature/wt") },
    { repo: "/p/back", branch: local("feature/wt") },
  ]);
  expect(mocks.worktrees.mock.calls).toEqual([["/p/front"], ["/p/back"]]);
  expect(mocks.removeWorktree).toHaveBeenLastCalledWith("/p/back", "/p/back/wt", false);
  expect(mocks.deleteBranch).toHaveBeenCalledExactlyOnceWith("/p/back", "feature/wt");
  expect(useVcs.getState().repo).toBe("/p/front");
});

it("restores only the branch after removing its worktree", async () => {
  mocks.worktrees.mockResolvedValue(ok([worktree("/p/wt", "feature/wt")]));
  mocks.confirm.mockResolvedValue(true);
  await deleteBranch("feature/wt");
  const notification = mocks.notify.mock.calls.find(([n]) => n.title === "Deleted branch feature/wt")![0];
  notification.actions.find((a: { label: string }) => a.label === "Restore").run();
  await vi.waitFor(() => expect(mocks.restoreBranch).toHaveBeenCalledWith("/p/front", deleted));
  expect(notification.title).not.toContain("worktree");
});

it("refreshes tracking branches in the deletion repository without replacing the focused branches", async () => {
  const focused = [local("main", true)];
  useVcs.setState({ branches: focused });
  mocks.worktrees.mockResolvedValue(ok([]));
  mocks.deleteBranch.mockResolvedValue(ok({ ...deleted, upstream: "origin/feature/wt" }));
  mocks.branches.mockResolvedValue(ok([{ ...local("other"), upstream: "origin/feature/wt" }]));
  await deleteBranch("feature/wt", "/p/back");
  expect(mocks.worktrees).toHaveBeenCalledWith("/p/back");
  expect(mocks.deleteBranch).toHaveBeenCalledWith("/p/back", "feature/wt");
  expect(mocks.branches).toHaveBeenCalledWith("/p/back");
  expect(useVcs.getState().branches).toEqual(focused);
  const notification = mocks.notify.mock.calls.find(([n]) => n.title === "Deleted branch feature/wt")![0];
  expect(notification.actions.map((a: { label: string }) => a.label)).not.toContain("Delete Tracked Branch");
  notification.actions.find((a: { label: string }) => a.label === "Restore").run();
  await vi.waitFor(() => expect(mocks.restoreBranch).toHaveBeenCalledWith("/p/back", expect.anything()));
});
