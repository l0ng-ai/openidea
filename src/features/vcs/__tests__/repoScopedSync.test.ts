import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.execute,
}));

import { branchMenu, commonBranchMenu, tagMenu } from "../branchMenu";
import { updateRepos } from "../remoteUi";
import { useVcs } from "../store";

const current: Branch = {
  name: "feature",
  remote: false,
  current: true,
  upstream: "origin/feature",
  ahead: 1,
  behind: 0,
  lastCommitMs: null,
};

const runItem = (items: ReturnType<typeof branchMenu>, label: string) => {
  const item = items.find((i) => "label" in i && i.label === label);
  if (!item || !("run" in item) || !item.run) throw new Error(`no ${label} item`);
  item.run();
};

beforeEach(() => {
  mocks.execute.mockReset();
  useVcs.setState({ roots: ["/p", "/p/lib"], repo: "/p/lib", heads: {} });
});

describe("checkout and rebase menu", () => {
  const topic = { ...current, name: "topic", current: false };

  it("uses the current commit when HEAD is detached", () => {
    runItem(branchMenu(topic, null, undefined, { headCommit: "123456789" }), "Checkout and Rebase onto '12345678'");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.checkoutAndRebase", { branch: topic, repos: ["/p/lib"] });
  });

  it("reaches every repository of a shared branch and disables the action if one already has it checked out", () => {
    const common = { name: topic.name, remote: false, current: false, favorite: false, upstream: false };
    const roots = ["/p", "/p/lib"];
    const heads = { "/p": { head: "main", headCommit: "1234" }, "/p/lib": { head: "release", headCommit: "2345" } };
    useVcs.setState({ heads });
    runItem(commonBranchMenu(common, roots), "Checkout and Rebase onto Current");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.checkoutAndRebase", { branch: common, repos: roots });

    useVcs.setState({ heads: { ...heads, "/p/lib": { ...heads["/p/lib"], head: "topic" } } });
    const item = commonBranchMenu(common, roots).find(
      (i) => "label" in i && i.label === "Checkout and Rebase onto Current",
    );
    expect(item).toMatchObject({ disabled: true });
  });

  it("dispatches the same operation when every selected repository shares the current branch", () => {
    const common = { name: topic.name, remote: false, current: false, favorite: false, upstream: false };
    const roots = ["/p", "/p/lib"];
    useVcs.setState({
      heads: { "/p": { head: "main", headCommit: "1234" }, "/p/lib": { head: "main", headCommit: "2345" } },
    });
    runItem(commonBranchMenu(common, roots, "main"), "Checkout and Rebase onto 'main'");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.checkoutAndRebase", { branch: common, repos: roots });
  });
});

it("passes all selected roots to Rebase Current and disables it when one HEAD is detached", () => {
  const target = { name: "origin/topic", remote: true, current: false, favorite: false, upstream: false };
  const roots = ["/p", "/p/lib"];
  const heads = { "/p": { head: "main", headCommit: "1234" }, "/p/lib": { head: "release", headCommit: "2345" } };
  useVcs.setState({ heads });
  runItem(commonBranchMenu(target, roots), "Rebase Current onto 'origin/topic'");
  expect(mocks.execute).toHaveBeenCalledWith("vcs.rebaseOntoBranch", { branch: target, repos: roots });

  useVcs.setState({ heads: { ...heads, "/p/lib": { head: null, headCommit: "2345" } } });
  expect(
    commonBranchMenu(target, roots).find(
      (item) => "label" in item && item.label === "Rebase Current onto 'origin/topic'",
    ),
  ).toMatchObject({ disabled: true, hint: "Rebase requires a checked-out branch" });
});

describe("current branch menu of one repository", () => {
  it("updates only the repository the menu belongs to", () => {
    runItem(branchMenu(current, "feature"), "Update");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.log.branches.update", [
      { repo: "/p/lib", ref: "feature", branch: current },
    ]);
  });

  it("pushes the named branch from the repository the menu belongs to", () => {
    runItem(branchMenu(current, "feature"), "Push…");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.push", { repo: "/p/lib", branch: "feature" });
  });

  it("shows actions for the local branch's remote-tracking ref", () => {
    const upstream = { ...current, name: "origin/feature", current: false, remote: true, upstream: null };
    const menu = branchMenu(current, "feature", undefined, { branches: [current, upstream] });
    const tracked = menu.find((item) => "label" in item && item.label === "Tracked Branch 'origin/feature'");
    expect(tracked).toBeDefined();
    if (!tracked || !("submenu" in tracked) || !tracked.submenu) throw new Error("Missing tracked branch actions");
    runItem(tracked.submenu, "Show History");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.showLog", { branch: "origin/feature" });
  });

  it("targets the primary repository when its menu is open", () => {
    useVcs.setState({ repo: null });
    runItem(branchMenu(current, "feature"), "Update");
    runItem(branchMenu(current, "feature"), "Push…");
    expect(mocks.execute).toHaveBeenNthCalledWith(1, "vcs.log.branches.update", [
      { repo: "/p", ref: "feature", branch: current },
    ]);
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "vcs.push", { repo: "/p", branch: "feature" });
  });

  it("keeps the branch shared by all repositories acting on the whole project", () => {
    const common = { name: "feature", remote: false, current: true, favorite: false, upstream: true };
    runItem(commonBranchMenu(common, ["/p", "/p/lib"], "feature"), "Update");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.log.branches.update", [
      { repo: "/p", ref: "feature", branch: common },
      { repo: "/p/lib", ref: "feature", branch: common },
    ]);
    runItem(commonBranchMenu(common, ["/p", "/p/lib"], "feature"), "Push…");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.push", { branch: "feature", repositories: ["/p", "/p/lib"] });
  });
});

it("compares a common remote branch in the full repository scope", () => {
  const common = { name: "origin/topic", remote: true, current: false, favorite: false, upstream: false };
  const repositories = ["/p", "/p/lib"];
  runItem(commonBranchMenu(common, repositories), "Compare with Current");
  expect(mocks.execute).toHaveBeenCalledWith("vcs.log.compareBranches", {
    name: "origin/topic",
    rev: "refs/remotes/origin/topic",
    repositories,
  });
});

it("groups six tag destinations and scopes the full remote name to its repository", () => {
  const remotes = ["origin", "upstream", "mirror", "fork", "publish/release", "backup"];
  const items = tagMenu("v1", undefined, { repo: "/p/lib", remotes });
  const push = items.find((item) => "label" in item && item.label === "Push Tag");
  if (!push || !("submenu" in push) || !push.submenu) throw new Error("Missing push destinations");
  expect(push.submenu).toHaveLength(6);
  runItem(push.submenu, "Push to publish/release");
  expect(mocks.execute).toHaveBeenCalledWith("vcs.pushTag", { tag: "v1", remote: "publish/release", repo: "/p/lib" });
});

describe("updateRepos", () => {
  it("updates one repository when the target names it", () => {
    expect(updateRepos({ repo: "/p/lib" })).toEqual(["/p/lib"]);
    expect(updateRepos({ repo: null })).toEqual([null]);
  });

  it("updates every repository of the project without a target", () => {
    expect(updateRepos({})).toEqual(["/p", "/p/lib"]);
  });
});
