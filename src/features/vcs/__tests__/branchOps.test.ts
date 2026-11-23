import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, ProjectInfo, Worktree } from "@/bindings";
const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  deleteTag: vi.fn(),
  remotes: vi.fn(),
  remoteOperation: vi.fn(),
  worktrees: vi.fn(),
  restoreBranch: vi.fn(),
  branches: vi.fn(),
  branchInfo: vi.fn(),
  mergeBase: vi.fn(),
  rebases: vi.fn(),
  rename: vi.fn(),
  ask: vi.fn(),
  checkout: vi.fn(),
  hasCommit: vi.fn(),
  chooseRevision: vi.fn(),
  executeAction: vi.fn(),
  windowOpenRemote: vi.fn(),
}));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  promptText: mocks.prompt,
  confirmDialog: mocks.confirm,
}));
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof import("@/workbench/messages")>()),
  ask: mocks.ask,
}));
vi.mock("../RevisionChooser", () => ({ chooseRevision: mocks.chooseRevision }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.executeAction,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify, expire: vi.fn() }),
}));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runRemote: mocks.remoteOperation,
}));
vi.mock("../branchRebase", async (original) => ({
  ...(await original<typeof import("../branchRebase")>()),
  runBranchRebases: mocks.rebases,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsWorktrees: mocks.worktrees,
      vcsRemoveWorktree: mocks.removeWorktree,
      vcsDeleteBranch: mocks.deleteBranch,
      vcsDeleteTag: mocks.deleteTag,
      vcsRemotes: mocks.remotes,
      vcsRestoreBranch: mocks.restoreBranch,
      vcsBranches: mocks.branches,
      vcsBranchInfo: mocks.branchInfo,
      vcsMergeBase: mocks.mergeBase,
      vcsRenameBranch: mocks.rename,
      vcsCheckout: mocks.checkout,
      vcsHasCommit: mocks.hasCommit,
      windowOpenRemote: mocks.windowOpenRemote,
    },
  };
});
import {
  checkoutAndRebase,
  checkoutBranch,
  checkoutInRepos,
  checkoutRevision,
  deleteBranch,
  deleteBranches,
  deleteTag,
  newBranch,
  newBranchInRepos,
  renameBranch,
} from "../branchOps";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";

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
    branchesLoaded: true,
    available: false,
  });
  // Cancel: only what the dialog was offered matters here, not its outcome.
  mocks.prompt.mockResolvedValue(null);
  mocks.branches.mockResolvedValue(ok([]));
  mocks.branchInfo.mockResolvedValue(ok(branch("feature/ui")));
});

it("offers remote tag deletion for the captured repository and annotated tag object", async () => {
  const deleted = { name: "v1", target: "a".repeat(40) };
  mocks.deleteTag.mockResolvedValue(ok(deleted));
  mocks.remotes.mockResolvedValue(ok([{ name: "release/empty", url: "/bare/empty" }]));

  await deleteTag("v1", "/p/front");
  expect(mocks.remotes).toHaveBeenCalledWith("/p/front");
  const notice = mocks.notify.mock.calls.find(([entry]) => entry.title === "Deleted tag v1")?.[0];
  const action = notice?.actions.find((item: { label: string }) => item.label === "Delete on Remote");
  expect(action).toBeDefined();
  useVcs.setState({ repo: "/p/other" });
  action.run();
  expect(mocks.remoteOperation).toHaveBeenCalledWith({ op: "deleteTagOnRemotes", deleted }, "v1", ["/p/front"]);
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
  await newBranch({ name: "origin/main", remote: true });
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("main");
});

it("prefills the current branch in the multi-repository dialog too", async () => {
  await newBranchInRepos(["/p/front", "/p/back"]);
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("feature/ui");
});

it("validates a suggested local branch name against the selected repositories", async () => {
  mocks.branches.mockResolvedValue(ok([local("feature/source"), local("taken"), local("folder/nested")]));
  await newBranchInRepos(["/p/front", "/p/back"], { name: "feature/source", remote: false });

  const prompt = mocks.prompt.mock.calls[0]?.[0];
  expect(prompt.initial).toBe("feature/source");
  expect(prompt.scope.options.map((option: { value: string }) => option.value)).toEqual(["*", "/p/front", "/p/back"]);
  expect(prompt.validate("taken", false, "*")).toBe("Branch 'taken' already exists (back)");
  expect(prompt.validate("folder", false, "*")).toBe("Branch name 'folder' conflicts with 'folder/nested' (back)");
  expect(prompt.validate("taken", false, "/p/front")).toBeNull();
  expect(prompt.overwriteBranch("taken", "*")).toBe(true);
  expect(prompt.overwriteBranch("taken", "/p/front")).toBe(false);
  expect(prompt.validate("taken", true, "*")).toBeNull();
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

it.each(["local", "drop", "cancel"])("handles the choice for a divergent remote branch (%s)", async (button) => {
  const remote: Branch = { ...local("origin/topic"), remote: true, commit: "remote-tip" };
  mocks.branchInfo.mockResolvedValue(ok(branch("main")));
  mocks.branches.mockResolvedValue(ok([remote, { ...tracked("topic", "origin/topic"), commit: "local-tip" }]));
  mocks.mergeBase.mockResolvedValue(ok("fork-point"));
  mocks.ask.mockResolvedValue({ button });

  await checkoutAndRebase({ branch: remote, repos: ["/p/front"] });

  expect(mocks.ask.mock.calls[0]?.[0].buttons.map((item: { label: string }) => item.label)).toEqual([
    "Use Local Branch",
    "Drop Local Commits",
    "Cancel",
  ]);
  expect(mocks.checkout).not.toHaveBeenCalled();
  if (button === "cancel") {
    expect(mocks.rebases).not.toHaveBeenCalled();
    return;
  }
  expect(mocks.rebases.mock.calls[0]?.[0]).toEqual([
    {
      root: "/p/front",
      state: {
        original: { branch: "topic", commit: button === "drop" ? "remote-tip" : "local-tip" },
        onto: "abc1234567890",
      },
      operation: {
        op: "checkoutRebase",
        plan: {
          base: { branch: "main", commit: "abc1234567890" },
          branch: "topic",
          branchTip: "local-tip",
          remote: { name: "origin/topic", commit: "remote-tip", dropLocalCommits: button === "drop" },
        },
      },
    },
  ]);
});

it("asks for a new local branch name if the remote branch's namesake already tracks another remote", async () => {
  const remote: Branch = { ...local("origin/topic"), remote: true, commit: "remote-tip" };
  mocks.branchInfo.mockResolvedValue(ok(branch("main")));
  mocks.branches.mockResolvedValue(ok([remote, { ...tracked("topic", "upstream/topic"), commit: "local-tip" }]));
  mocks.prompt.mockResolvedValue({ value: "review", checked: false });

  await checkoutAndRebase({ branch: remote, repos: ["/p/front"] });

  expect(mocks.prompt).toHaveBeenCalledWith(expect.objectContaining({ initial: "topic", validateInitial: true }));
  expect(mocks.ask).not.toHaveBeenCalled();
  expect(mocks.rebases.mock.calls[0]?.[0][0]?.operation.plan).toMatchObject({ branch: "review", branchTip: null });
});

it("uses each repository's starting branch when preparing a batch", async () => {
  const selected = { ...local("topic"), commit: "topic-tip" };
  const repos = ["/p/front", "/p/back", "/p/common"];
  mocks.branchInfo.mockImplementation((repo: string) => Promise.resolve(ok(branch(repo.split("/").at(-1)!))));
  mocks.branches.mockResolvedValue(ok([selected]));

  await checkoutAndRebase({ branch: selected, repos });

  expect(
    mocks.rebases.mock.calls[0]?.[0].map((entry: import("../branchRebase").PlannedRebase) => [
      entry.root,
      entry.operation.op === "checkoutRebase" && entry.operation.plan.base.branch,
    ]),
  ).toEqual([
    ["/p/front", "front"],
    ["/p/back", "back"],
    ["/p/common", "common"],
  ]);
});

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

it("offers to open the worktree that has the branch checked out", async () => {
  mocks.checkout.mockResolvedValue(ok({ kind: "checkedOutInWorktree", branch: "feature/wt", path: "/p/front-wt" }));
  mocks.ask.mockResolvedValue({ button: "open" });
  await checkoutBranch(local("feature/wt"));
  expect(mocks.checkout).toHaveBeenCalledWith(
    "/p/front",
    "refs/heads/feature/wt",
    false,
    { mode: "normal", diverged: null },
    null,
  );
  expect(mocks.ask.mock.calls[0]?.[0].title).toBe("Worktree Conflict");
  expect(mocks.ask.mock.calls[0]?.[0].body).toContain("already checked out in a worktree at:\n/p/front-wt");
  expect(mocks.executeAction).toHaveBeenCalledWith("file.openProjectPath", "/p/front-wt");
  expect(mocks.checkout).toHaveBeenCalledTimes(1);
});

it("uses the exact remote ref when a local branch has the same display name", async () => {
  const remote = { ...local("team/ops/topic"), remote: true };
  useVcs.setState({ branches: [local(remote.name), tracked("topic", remote.name), remote] });
  mocks.remotes.mockResolvedValue(ok([{ name: "team/ops" }]));
  mocks.checkout.mockResolvedValue(ok({ kind: "done" }));

  await checkoutBranch(remote);

  expect(mocks.checkout).toHaveBeenCalledExactlyOnceWith(
    "/p/front",
    "refs/remotes/team/ops/topic",
    false,
    { mode: "normal", diverged: null },
    null,
  );
});

it("checks a revision out detached in the explicitly selected repository", async () => {
  mocks.chooseRevision.mockImplementation(async () => {
    useVcs.setState({ repo: "/p/other" });
    return "refs/heads/main";
  });
  mocks.hasCommit.mockResolvedValue(ok(true));
  mocks.checkout.mockResolvedValue(ok({ kind: "done" }));
  await checkoutRevision({ repo: "/p/nested" });
  expect(mocks.chooseRevision).toHaveBeenCalledExactlyOnceWith("Checkout Tag or Revision", {
    tags: true,
    commonOnly: true,
    repositories: ["/p/nested"],
  });
  expect(mocks.hasCommit).toHaveBeenCalledExactlyOnceWith("/p/nested", "refs/heads/main");
  expect(mocks.checkout).toHaveBeenCalledExactlyOnceWith(
    "/p/nested",
    "refs/heads/main^{commit}",
    false,
    { mode: "normal", diverged: null },
    null,
  );
});

it("checks every affected repository before moving any HEAD", async () => {
  const repos = ["/p/front", "/p/nested"];
  mocks.chooseRevision.mockResolvedValue("release");
  mocks.hasCommit.mockImplementation(async (root) => ok(root === repos[0]));
  await checkoutRevision({ repos });
  expect(mocks.hasCommit.mock.calls).toEqual(repos.map((root) => [root, "release"]));
  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Revision was not found in nested" }));

  mocks.hasCommit.mockResolvedValue(ok(true));
  mocks.checkout.mockResolvedValue(ok({ kind: "done" }));
  await checkoutRevision({ repos });
  expect(mocks.checkout.mock.calls.map(([root, ref]) => [root, ref])).toEqual(
    repos.map((root) => [root, "release^{commit}"]),
  );
});

it("uses one worktree per Git repository when invoking a synchronized checkout without an explicit scope", async () => {
  useVcs.setState({
    repo: "/p/front-wt",
    roots: ["/p/front", "/p/front-wt", "/p/nested"],
    branchRoots: { "/p/front": "/p/front", "/p/front-wt": "/p/front", "/p/nested": "/p/nested" },
  });
  mocks.chooseRevision.mockResolvedValue(null);
  await checkoutRevision();
  expect(mocks.chooseRevision).toHaveBeenCalledExactlyOnceWith(
    "Checkout Tag or Revision",
    expect.objectContaining({
      repositories: ["/p/front-wt", "/p/nested"],
    }),
  );
});

it("asks for a branch name before moving any repository when a common remote's namesake tracks elsewhere", async () => {
  const remote = { ...local("team/ops/topic"), remote: true };
  useVcs.setState({ branches: [tracked("topic", remote.name), remote] });
  mocks.remotes.mockResolvedValue(ok([{ name: "team/ops" }]));
  mocks.branches.mockResolvedValue(ok([tracked("topic", "other/topic"), remote]));

  await checkoutInRepos(remote, ["/p/front", "/p/back"]);

  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Create New Branch from team/ops/topic",
      initial: "topic",
      scope: expect.objectContaining({ initial: "*" }),
    }),
  );
});

it("checks the branch out anyway when asked, alongside the other worktree", async () => {
  mocks.checkout
    .mockResolvedValueOnce(ok({ kind: "checkedOutInWorktree", branch: "feature/wt", path: "/p/front-wt" }))
    .mockResolvedValueOnce(ok({ kind: "done" }));
  mocks.ask.mockResolvedValue({ button: "anyway" });
  await checkoutBranch(local("feature/wt"));
  expect(mocks.checkout).toHaveBeenLastCalledWith(
    "/p/front",
    "refs/heads/feature/wt",
    false,
    { mode: "normal", diverged: null, ignoreOtherWorktrees: true },
    null,
  );
  expect(mocks.executeAction).not.toHaveBeenCalled();
});

it("does not open the worktree when the checkout offer is declined", async () => {
  mocks.checkout.mockResolvedValue(ok({ kind: "checkedOutInWorktree", branch: "feature/wt", path: "/p/front-wt" }));
  mocks.ask.mockResolvedValue({ button: "cancel" });
  await checkoutBranch(local("feature/wt"));
  expect(mocks.executeAction).not.toHaveBeenCalled();
});

it("names the files git would remove when untracked ones block the checkout", async () => {
  mocks.checkout.mockResolvedValue(ok({ kind: "untrackedFiles", files: ["TEST.md"], removed: true }));
  await checkoutBranch(local("feature/x"));
  expect(mocks.checkout).toHaveBeenCalledTimes(1);
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "error",
      title: "Untracked files prevent checkout",
      body: expect.stringContaining(
        "The following untracked working tree files would be removed by checkout:\nTEST.md",
      ),
    }),
  );
});

it("still says overwritten when untracked files would be overwritten", async () => {
  mocks.checkout.mockResolvedValue(ok({ kind: "untrackedFiles", files: ["dir/new.txt"], removed: false }));
  await checkoutBranch(local("feature/x"));
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "error",
      body: expect.stringContaining(
        "The following untracked working tree files would be overwritten by checkout:\ndir/new.txt",
      ),
    }),
  );
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
  mocks.deleteBranch.mockResolvedValue(
    ok({
      ...deleted,
      upstream: "origin/feature/wt",
      remoteUpstream: { remote: "origin", branch: "feature/wt" },
    }),
  );
  mocks.remotes.mockResolvedValue(ok([{ name: "origin" }]));
  mocks.branches.mockResolvedValue(
    ok([
      { ...local("other"), upstream: "origin/feature/wt" },
      { ...local("origin/feature/wt"), remote: true },
    ]),
  );
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

afterEach(() => useRemote.setState({ session: null }));

it.each(["focused", "failed"])("opens a checked-out SSH branch without retrying checkout: %s", async (outcome) => {
  const target = { kind: "ssh", config: "connected-host" } as const;
  const path = "/p/front feature";
  useRemote.setState({ session: { target, root: "/p/front", host: "demo-linux", os: "linux", commands: [] } });
  mocks.checkout.mockReset().mockResolvedValue(ok({ kind: "checkedOutInWorktree", branch: "feature/wt", path }));
  mocks.ask.mockReset().mockResolvedValue({ button: "open" });
  mocks.windowOpenRemote
    .mockReset()
    .mockResolvedValue(
      outcome === "focused"
        ? ok({ kind: "focused", label: "existing-window" })
        : { status: "error", error: { kind: "unavailable", message: "SSH unavailable", detail: null } },
    );
  mocks.executeAction.mockClear();
  mocks.notify.mockClear();
  await checkoutBranch(local("feature/wt"));
  expect(mocks.windowOpenRemote).toHaveBeenCalledExactlyOnceWith(target, path, true);
  expect(mocks.checkout).toHaveBeenCalledTimes(1);
  expect(mocks.executeAction).not.toHaveBeenCalledWith("file.openProjectPath", expect.anything());
  if (outcome === "failed") {
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "SSH unavailable" }));
  }
});

it("keeps the local open action when another worktree holds the branch", async () => {
  const path = "C:/src/project-worktree";
  useRemote.setState({ session: null });
  mocks.checkout.mockResolvedValue(ok({ kind: "checkedOutInWorktree", branch: "feature/wt", path }));
  mocks.ask.mockResolvedValue({ button: "open" });
  await checkoutBranch(local("feature/wt"));
  expect(mocks.executeAction).toHaveBeenCalledExactlyOnceWith("file.openProjectPath", path);
  expect(mocks.windowOpenRemote).not.toHaveBeenCalled();
  expect(mocks.checkout).toHaveBeenCalledTimes(1);
});
