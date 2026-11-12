import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.execute,
}));

import { branchMenu, commonBranchMenu } from "../branchMenu";
import { updateBranch } from "../branchOps";
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
  useVcs.setState({ roots: ["/p", "/p/lib"], repo: "/p/lib" });
});

describe("current branch menu of one repository", () => {
  it("updates only the repository the menu belongs to", () => {
    runItem(branchMenu(current, "feature"), "Update");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.update", { repo: "/p/lib" });
  });

  it("pushes from the repository the menu belongs to", () => {
    runItem(branchMenu(current, "feature"), "Push…");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.push", { repo: "/p/lib" });
  });

  it("targets the primary repository when its menu is open", () => {
    useVcs.setState({ repo: null });
    runItem(branchMenu(current, "feature"), "Update");
    runItem(branchMenu(current, "feature"), "Push…");
    expect(mocks.execute).toHaveBeenNthCalledWith(1, "vcs.update", { repo: null });
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "vcs.push", { repo: null });
  });

  it("keeps the branch shared by all repositories acting on the whole project", () => {
    const common = { name: "feature", remote: false, current: true, favorite: false };
    runItem(commonBranchMenu(common, ["/p", "/p/lib"]), "Update");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.update");
  });
});

describe("Update Selected in the Git Log branches pane", () => {
  it("updates only the repository whose current branch is selected", async () => {
    useVcs.setState({ branches: [current] });
    await updateBranch("feature");
    expect(mocks.execute).toHaveBeenCalledWith("vcs.update", { repo: "/p/lib" });
  });
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
