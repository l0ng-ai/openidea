import { afterEach, describe, expect, it, vi } from "vitest";
import { getAction, isActionEnabled } from "@/platform/actions";
import { provideProjectViewSelection } from "@/workbench/contributions";
import { registerVcsActions } from "../actions";

const mocks = vi.hoisted(() => ({ compare: vi.fn() }));
vi.mock("../comparePaths", () => ({ comparePathsWithRevision: mocks.compare, showDirectoryWorkingDiff: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("compare action context", () => {
  it("is enabled for Git folder selections and uses project selection in menu/Search Everywhere", async () => {
    const unregister = registerVcsActions();
    const dispose = provideProjectViewSelection(() => ["/workspace/client", "/workspace/server"]);
    try {
      const action = getAction("vcs.compareWithBranch")!;
      expect(isActionEnabled(action, { vcsAvailable: true, projectViewFocus: true })).toBe(true);
      await action.run({ arg: undefined, ctx: { vcsAvailable: true } });
      expect(mocks.compare).toHaveBeenCalledWith(["/workspace/client", "/workspace/server"]);
      await action.run({ arg: { path: "/workspace/client/a.ts" }, ctx: { vcsAvailable: true } });
      expect(mocks.compare).toHaveBeenLastCalledWith(["/workspace/client/a.ts"]);
    } finally {
      dispose();
      unregister();
    }
  });
});
