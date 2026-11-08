import { beforeEach, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  local: vi.fn(),
  remote: vi.fn(),
  focus: vi.fn(),
  notify: vi.fn(),
  range: vi.fn(),
}));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: mocks.confirm,
}));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runOp: mocks.local,
  runRemote: mocks.remote,
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
  showCommitRange: mocks.range,
}));

import { canDeleteBranch, deleteBranches } from "../branchOps";
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
  mocks.focus.mockImplementation(async (repo: string) => {
    useVcs.setState({ repo });
  });
});

it("restores the original repository after deleting across repositories", async () => {
  const repos: (string | null)[] = [];
  mocks.local.mockImplementation(async () => {
    repos.push(useVcs.getState().repo);
  });
  await deleteBranches([target("one", "/p/b"), target("two", "/p/a"), target("three", "/p/b")]);
  expect(repos).toEqual(["/p/b", "/p/a", "/p/b"]);
  expect(useVcs.getState().repo).toBe("/p/a");
});

it("restores focus when deletion throws", async () => {
  mocks.local.mockRejectedValue(new Error("failed"));
  await expect(deleteBranches([target("one", "/p/b")])).rejects.toThrow("failed");
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
  expect(mocks.remote).not.toHaveBeenCalled();
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
  expect(mocks.remote).not.toHaveBeenCalled();
  expect(mocks.focus).not.toHaveBeenCalled();
});

it("confirms once for remote branches across repositories and deletes in the right repository", async () => {
  const repos: (string | null)[] = [];
  mocks.remote.mockImplementation(async () => {
    repos.push(useVcs.getState().repo);
    return true;
  });
  await deleteBranches([
    target("origin/one", "/p/a", { remote: true }),
    target("origin/two", "/p/b", { remote: true }),
  ]);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.remote.mock.calls.map(([op]) => op.branch)).toEqual(["origin/one", "origin/two"]);
  expect(repos).toEqual(["/p/a", "/p/b"]);
  expect(useVcs.getState().repo).toBe("/p/a");
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

it("Delete Tracked Branch keeps the repository captured before focus was restored", async () => {
  mocks.local.mockResolvedValue({ name: "one", tip: "abc", upstream: "origin/one", unmerged: false });
  await deleteBranches([target("one", "/p/b")]);
  expect(useVcs.getState().repo).toBe("/p/a");
  const notification = mocks.notify.mock.calls[0]![0];
  notification.actions.find((a: { label: string }) => a.label === "Delete Tracked Branch").run();
  await vi.waitFor(() =>
    expect(mocks.remote).toHaveBeenCalledWith({ op: "deleteBranch", branch: "origin/one" }, "origin/one", ["/p/b"]),
  );
});

it("View Commits keeps the deleted branch's repository after focus was restored", async () => {
  mocks.local.mockResolvedValue({ name: "one", tip: "abc", upstream: null, unmerged: true });
  await deleteBranches([target("one", "/p/b")]);
  const notification = mocks.notify.mock.calls[0]![0];
  notification.actions.find((a: { label: string }) => a.label === "View Commits").run();
  expect(mocks.range).toHaveBeenCalledWith("Commits of one", "HEAD", "abc", "/p/b");
});

it("restores the primary repository when it was focused implicitly", async () => {
  useVcs.setState({ repo: null, roots: ["/p/a", "/p/b"] });
  await deleteBranches([target("one", "/p/b")]);
  expect(useVcs.getState().repo).toBe("/p/a");
});
