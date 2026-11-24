import { beforeEach, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  local: vi.fn(),
  remoteRound: vi.fn(),
  confirmChecked: vi.fn(),
  focus: vi.fn(),
  notify: vi.fn(),
  range: vi.fn(),
  deleteBranch: vi.fn(),
  deleteTrackingBranch: vi.fn(),
  restoreBranch: vi.fn(),
  branches: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsDeleteBranch: mocks.deleteBranch,
      vcsDeleteTrackingBranch: mocks.deleteTrackingBranch,
      vcsRestoreBranch: mocks.restoreBranch,
      vcsBranches: mocks.branches,
      vcsRemotes: async () => ({ status: "ok", data: [{ name: "origin" }] }),
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { head: "main", headCommit: "1", operation: null } }),
    },
  };
});
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: mocks.confirm,
}));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runOp: mocks.local,
  runRemoteRound: mocks.remoteRound,
}));
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof import("@/workbench/messages")>()),
  confirmChecked: mocks.confirmChecked,
}));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  focusRepo: mocks.focus,
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));

vi.mock("../CompareBranches", async (original) => ({
  ...(await original<typeof import("../CompareBranches")>()),
  showCommitRanges: mocks.range,
}));

import { canDeleteBranch, deleteBranches, deleteInRepos } from "../branchOps";
import { branchMenu } from "../branchMenu";
import { registerLogPaneActions, useBranchesPane } from "../logPaneActions";
import { getAction } from "@/platform/actions";
import { useVcs } from "../store";

const branch = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: null,
  ...opts,
});
const target = (name: string, repo = "/p/a", opts: Partial<Branch> = {}) => ({
  ref: name,
  repo,
  branch: branch(name, opts),
});

beforeEach(() => {
  vi.resetAllMocks();
  useVcs.setState({ root: "/p", repo: "/p/a", branches: [], branchesLoaded: true });
  useBranchesPane.setState({ selected: [] });
  mocks.confirm.mockResolvedValue(true);
  mocks.remoteRound.mockResolvedValue([]);
  mocks.branches.mockResolvedValue({ status: "ok", data: [] });
  mocks.focus.mockImplementation(async (repo: string) => {
    useVcs.setState({ repo });
  });
});

it("deletes across repositories without changing focus", async () => {
  await deleteBranches([target("one", "/p/b"), target("two", "/p/a"), target("three", "/p/b")]);
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(useVcs.getState().repo).toBe("/p/a");
});

it("keeps deletion targets when an in-flight refresh overwrites focus between deletions", async () => {
  mocks.local.mockImplementation(async (_title, run) => {
    const result = await run();
    useVcs.setState({ repo: "/p/b" });
    return result;
  });
  mocks.focus.mockImplementation(async () => {
    // A refresh started in B finishes after the attempt to focus A.
    useVcs.setState({ repo: "/p/b" });
  });
  mocks.deleteBranch.mockResolvedValue({ status: "ok", data: null });
  await deleteBranches([target("one", "/p/b"), target("two", "/p/a")]);
  expect(mocks.deleteBranch.mock.calls).toEqual([
    ["/p/b", "one"],
    ["/p/a", "two"],
  ]);
  expect(mocks.focus).not.toHaveBeenCalled();
});

it("leaves focus untouched when deletion throws", async () => {
  mocks.local.mockRejectedValue(new Error("failed"));
  await expect(deleteBranches([target("one", "/p/b")])).rejects.toThrow("failed");
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(useVcs.getState().repo).toBe("/p/a");
});

it("skips tags, groups and each repository's current branch", async () => {
  const selected = [
    target("main", "/p/a", { current: true }),
    target("other", "/p/b", { current: true }),
    { ref: "v1", repo: "/p/a" },
    {},
    target("other", "/p/a"),
    target("main", "/p/b"),
  ];
  expect(selected.map((t) => canDeleteBranch("ref" in t ? t : null))).toEqual([false, false, false, false, true, true]);
  await deleteBranches(selected);
  expect(mocks.local.mock.calls.map(([title]) => title)).toEqual(["Delete branch other", "Delete branch main"]);
});

it("does nothing for only current branches or non-branch rows", async () => {
  await deleteBranches([target("main", "/p/a", { current: true }), { ref: "v1" }, {}]);
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.remoteRound).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(branchMenu(branch("main", { current: true }), "main").some((i) => "label" in i && i.label === "Delete")).toBe(
    false,
  );
});

it.each([1, 2])("cancelling %s remote branches leaves the whole mixed selection untouched", async (count) => {
  mocks.confirm.mockResolvedValue(false);
  await deleteBranches([
    target("local"),
    ...Array.from({ length: count }, (_, i) => target(`origin/r${i}`, "/p/b", { remote: true })),
  ]);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.remoteRound).not.toHaveBeenCalled();
  expect(mocks.focus).not.toHaveBeenCalled();
});

it("confirms once for remote branches across repositories and deletes in the right repository", async () => {
  await deleteBranches([
    target("origin/one", "/p/a", { remote: true }),
    target("origin/two", "/p/b", { remote: true }),
  ]);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.remoteRound).toHaveBeenCalledExactlyOnceWith([
    { repo: "/p/a", op: { op: "deleteBranch", branch: "origin/one" } },
    { repo: "/p/b", op: { op: "deleteBranch", branch: "origin/two" } },
  ]);
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(useVcs.getState().repo).toBe("/p/a");
});

it.each([false, true])(
  "deletes only the checked local tracking branches after remote success (%s)",
  async (checked) => {
    mocks.local.mockImplementation(async (_title, run) => run());
    mocks.branches.mockImplementation(async (repo) => ({
      status: "ok",
      data: [
        branch("work", { upstream: "origin/feature", commit: repo + "-tip" }),
        branch("active", { upstream: "origin/feature", current: repo === "/p/b", commit: "active" }),
        branch("unrelated", { upstream: "origin/main", commit: "unrelated" }),
        ...(repo === "/p/a" ? [branch("only-a", { upstream: "origin/feature", commit: "only-a" })] : []),
      ],
    }));
    mocks.confirmChecked.mockResolvedValue({ checked });
    mocks.deleteTrackingBranch.mockImplementation(async (_repo, name, tip) => ({
      status: "ok",
      data: { name, tip, upstream: "origin/feature", unmerged: false },
    }));
    await deleteBranches([
      target("origin/feature", "/p/a", { remote: true }),
      target("origin/feature", "/p/b", { remote: true }),
    ]);
    expect(mocks.confirmChecked).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        checkbox: "Delete the local tracking branch 'work' as well",
      }),
    );
    expect(mocks.remoteRound).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTrackingBranch.mock.calls).toEqual(
      checked
        ? [
            ["/p/a", "work", "/p/a-tip", "origin/feature"],
            ["/p/b", "work", "/p/b-tip", "origin/feature"],
          ]
        : [],
    );
    if (checked)
      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Deleted branch work in 2 repositories",
          actions: [expect.objectContaining({ label: "Restore" })],
        }),
      );
  },
);

it("keeps the selected local tracking branches if the remote deletion fails in one repository", async () => {
  mocks.branches.mockResolvedValue({
    status: "ok",
    data: [branch("work", { upstream: "origin/feature", commit: "tip" })],
  });
  mocks.confirmChecked.mockResolvedValue({ checked: true });
  mocks.remoteRound.mockImplementation(async (targets) => [{ target: targets[1], error: new Error("denied") }]);
  await deleteBranches([
    target("origin/feature", "/p/a", { remote: true }),
    target("origin/feature", "/p/b", { remote: true }),
  ]);
  expect(mocks.deleteTrackingBranch).not.toHaveBeenCalled();
  expect(mocks.local).not.toHaveBeenCalled();
});

it("the Delete action uses the whole pane selection without an explicit argument", async () => {
  const dispose = registerLogPaneActions();
  try {
    useBranchesPane.setState({ selected: [target("one"), target("two")] });
    await getAction("vcs.log.branches.delete")!.run({ ctx: {} });
    await vi.waitFor(() => expect(mocks.local).toHaveBeenCalledTimes(2));
  } finally {
    dispose();
  }
});

it("Delete Tracked Branch keeps the repository captured without changing focus", async () => {
  mocks.local.mockResolvedValue({
    name: "one",
    tip: "abc",
    upstream: "origin/one",
    remoteUpstream: { remote: "origin", branch: "one" },
    unmerged: false,
  });
  mocks.branches.mockResolvedValue({ status: "ok", data: [branch("origin/one", { remote: true })] });
  await deleteBranches([target("one", "/p/b")]);
  expect(useVcs.getState().repo).toBe("/p/a");
  const notification = mocks.notify.mock.calls[0]![0];
  await notification.actions.find((a: { label: string }) => a.label === "Delete Tracked Branch").run();
  expect(mocks.remoteRound).toHaveBeenCalledExactlyOnceWith([
    { repo: "/p/b", op: { op: "deleteBranch", branch: "origin/one" } },
  ]);
});

it("does not offer to delete the protected branch on the remote", async () => {
  mocks.local.mockResolvedValue({
    name: "one",
    tip: "abc",
    upstream: "origin/main",
    remoteUpstream: { remote: "origin", branch: "main" },
    unmerged: false,
  });
  mocks.branches.mockResolvedValue({ status: "ok", data: [branch("origin/main", { remote: true })] });
  await deleteBranches([target("one", "/p/b")]);
  const actions = mocks.notify.mock.calls[0]![0].actions;
  expect(actions.map((a: { label: string }) => a.label)).toEqual(["Restore"]);
});

it("rechecks other tracking branches after confirming remote deletion", async () => {
  mocks.local.mockResolvedValue({
    name: "one",
    tip: "abc",
    upstream: "origin/one",
    remoteUpstream: { remote: "origin", branch: "one" },
    unmerged: false,
  });
  const remoteBranch = branch("origin/one", { remote: true });
  mocks.branches.mockResolvedValue({ status: "ok", data: [remoteBranch] });
  mocks.confirm.mockImplementation(async () => {
    mocks.branches.mockResolvedValue({
      status: "ok",
      data: [remoteBranch, branch("another", { upstream: "origin/one" })],
    });
    return true;
  });
  await deleteBranches([target("one", "/p/b")]);
  await mocks.notify.mock.calls[0]![0].actions.find(
    (a: { label: string }) => a.label === "Delete Tracked Branch",
  ).run();
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.remoteRound).not.toHaveBeenCalled();
});

it("View Commits keeps the deleted branch's repository without changing focus", async () => {
  mocks.local.mockResolvedValue({ name: "one", tip: "abc", upstream: null, unmerged: true });
  await deleteBranches([target("one", "/p/b")]);
  const notification = mocks.notify.mock.calls[0]![0];
  notification.actions.find((a: { label: string }) => a.label === "View Commits").run();
  expect(mocks.range).toHaveBeenCalledWith(
    "Commits of one",
    [{ repo: "/p/b", from: "HEAD", to: "abc" }],
    expect.any(Function),
  );
});

it("keeps the primary repository focused implicitly", async () => {
  useVcs.setState({ repo: null, roots: ["/p/a", "/p/b"] });
  await deleteBranches([target("one", "/p/b")]);
  expect(useVcs.getState().repo).toBeNull();
  expect(mocks.focus).not.toHaveBeenCalled();
});

it("deletes a common branch only in the repositories where it is not checked out", async () => {
  mocks.local.mockImplementation(async (_title, run) => run());
  mocks.deleteBranch.mockResolvedValue({ status: "ok", data: { name: "dev" } });
  useVcs.setState({ heads: { "/p/a": { head: "main", headCommit: "1" }, "/p/b": { head: "dev", headCommit: "2" } } });
  await deleteInRepos("dev", ["/p/a", "/p/b"]);
  expect(mocks.deleteBranch.mock.calls).toEqual([["/p/a", "dev"]]);
  useVcs.setState({ heads: { "/p/a": { head: "dev", headCommit: "1" }, "/p/b": { head: "dev", headCommit: "2" } } });
  mocks.deleteBranch.mockClear();
  mocks.confirm.mockClear();
  await deleteInRepos("dev", ["/p/a", "/p/b"]);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.deleteBranch).not.toHaveBeenCalled();
});

it("deletes a common branch with one notification and restores it from View Commits", async () => {
  const roots = ["/p/a", "/p/b"];
  mocks.local.mockImplementation(async (_title, run) => run());
  mocks.deleteBranch.mockImplementation(async (repo) => ({
    status: "ok",
    data: { name: "dev", tip: repo + "-tip", unmerged: true, unmergedBase: repo + "-base", upstream: null },
  }));
  mocks.restoreBranch.mockResolvedValue({ status: "ok", data: null });
  useVcs.setState({ heads: { "/p/a": { head: "main", headCommit: "1" }, "/p/b": { head: "main", headCommit: "2" } } });
  await deleteInRepos("dev", roots);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      title: "Deleted branch dev in 2 repositories",
      body: "Unmerged commits were discarded",
    }),
  );
  const actions = mocks.notify.mock.calls[0]![0].actions;
  actions.find((a: { label: string }) => a.label === "View Commits").run();
  expect(mocks.range).toHaveBeenCalledExactlyOnceWith(
    "Commits of dev",
    roots.map((repo) => ({
      repo,
      from: repo + "-base",
      to: repo + "-tip",
    })),
    expect.any(Function),
  );
  await mocks.range.mock.calls[0]![2]();
  expect(mocks.restoreBranch.mock.calls.map(([repo, receipt]) => [repo, receipt.tip])).toEqual(
    roots.map((repo) => [repo, repo + "-tip"]),
  );
});
