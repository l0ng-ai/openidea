import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), update: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.execute,
}));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runBranchUpdates: mocks.update,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));

import { branchMenu, commonBranchMenu } from "../branchMenu";
import { branchUpdateSummary, updateBranches } from "../branchOps";
import { getAction } from "@/platform/actions";
import { registerLogPaneActions, useBranchesPane } from "../logPaneActions";
import type { RepoBranchUpdate } from "../ops";
import { useVcs } from "../store";

const branch = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: `origin/${name}`,
  ahead: 0,
  behind: 0,
  lastCommitMs: null,
  ...opts,
});
const target = (name: string, repo?: string, opts: Partial<Branch> = {}) => ({
  ref: name,
  repo,
  branch: branch(name, opts),
});
const result = (branch: string, status: RepoBranchUpdate["status"], repo: string | null = "/p", message?: string) => ({
  branch,
  status,
  repo,
  message: message ?? null,
});

beforeEach(() => {
  vi.resetAllMocks();
  useVcs.setState({ root: "/p", roots: ["/p"], repo: "/p", branches: [] });
  useBranchesPane.setState({ selected: [] });
  mocks.update.mockResolvedValue([]);
});

describe("Update Selected", () => {
  it("updates every selected local branch in one run, grouped by repository", async () => {
    await updateBranches([
      target("a", "/p"),
      target("b", "/p/lib"),
      target("origin/c", "/p", { remote: true }),
      target("d", "/p", { current: true }),
    ]);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect([...mocks.update.mock.calls[0]![0]]).toEqual([
      ["/p", ["a", "d"]],
      ["/p/lib", ["b"]],
    ]);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("uses the selected repository for targets without one", async () => {
    useVcs.setState({ repo: "/p/lib" });
    await updateBranches([target("a"), target("b")]);
    expect([...mocks.update.mock.calls[0]![0]]).toEqual([["/p/lib", ["a", "b"]]]);
  });

  it("updates the project's repository like Update Project for the current branch alone", async () => {
    await updateBranches([target("main", "/p/lib", { current: true })]);
    expect(mocks.execute).toHaveBeenCalledWith("vcs.update", { repo: "/p/lib" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("offers Update Selected in the context menu of a multi-selection", () => {
    const selected = [target("a", "/p"), target("b", "/p")];
    const items = branchMenu(selected[0]!.branch, "main", () => {}, selected);
    const item = items.find((i) => "label" in i && i.label === "Update Selected");
    expect(item).toBeDefined();
    expect(items.some((i) => "label" in i && i.label === "Update")).toBe(false);
    if (item && "run" in item) item.run?.();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("keeps Update for one branch and disables it without a tracked branch", () => {
    const items = branchMenu(branch("a", { upstream: null }), "main", () => {}, [target("a", "/p")]);
    const item = items.find((i) => "label" in i && i.label === "Update");
    expect(item && "disabled" in item && item.disabled).toBe(true);
  });

  it("acts on the whole pane selection from the toolbar", async () => {
    const dispose = registerLogPaneActions();
    useBranchesPane.setState({ selected: [target("a", "/p"), target("b", "/p")] });
    await getAction("vcs.log.branches.update")!.run({ arg: undefined, ctx: {} } as never);
    expect([...mocks.update.mock.calls[0]![0]]).toEqual([["/p", ["a", "b"]]]);
    dispose();
  });
});

describe("branchUpdateSummary", () => {
  it("names the updated branches and why the others were not updated", () => {
    const summary = branchUpdateSummary([
      result("a", "updated"),
      result("b", "updated"),
      result("c", "upToDate"),
      result("d", "notFastForward"),
      result("e", "noUpstream"),
      result("f", "failed", "/p", "refusing to fetch into branch"),
    ]);
    expect(summary.level).toBe("warning");
    expect(summary.title).toBe("Updated 2 branches");
    expect(summary.lines).toEqual([
      "Updated: a, b",
      "Already up-to-date: c",
      "Not updated, cannot be fast-forwarded: d",
      "Not updated, no tracked branch: e",
      "Failed to update f: refusing to fetch into branch",
    ]);
  });

  it("says when everything was already up-to-date", () => {
    const summary = branchUpdateSummary([result("a", "upToDate"), result("b", "upToDate")]);
    expect(summary).toEqual({
      level: "info",
      title: "Selected branches are up-to-date",
      lines: ["Already up-to-date: a, b"],
    });
  });

  it("reports a selection nothing could be done for as a warning", () => {
    const summary = branchUpdateSummary([result("a", "notFastForward")]);
    expect(summary.level).toBe("warning");
    expect(summary.title).toBe("No branches were updated");
  });

  it("names the repository of each branch when they come from several", () => {
    const summary = branchUpdateSummary([result("main", "updated", "/p"), result("main", "updated", "/p/lib")]);
    expect(summary.title).toBe("Updated 2 branches");
    expect(summary.lines).toEqual(["Updated: p: main, lib: main"]);
  });
});

describe("branch common to several repositories", () => {
  it("updates it in every repository at once", () => {
    const common = { name: "feature", remote: false, current: false, favorite: false };
    const items = commonBranchMenu(common, ["/p", "/p/lib"]);
    const item = items.find((i) => "label" in i && i.label === "Update");
    if (item && "run" in item) item.run?.();
    expect([...mocks.update.mock.calls[0]![0]]).toEqual([
      ["/p", ["feature"]],
      ["/p/lib", ["feature"]],
    ]);
  });
});
