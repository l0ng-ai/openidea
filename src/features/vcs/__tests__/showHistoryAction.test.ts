import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openLog = vi.hoisted(() => vi.fn());
const project = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ activePath: () => "/repo/active.ts" }),
  projectViewSelection: () => project.paths,
  toolWindowService: () => ({ show: () => undefined }),
}));
vi.mock("../logStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logStore")>()),
  openLogTab: openLog,
}));

import { getAction } from "@/platform/actions";
import { registerVcsActions } from "../actions";

let unregister: () => void;

beforeEach(() => {
  openLog.mockClear();
  project.paths = [];
  unregister = registerVcsActions();
});

afterEach(() => unregister());

describe("Show History for File", () => {
  it("uses the Project view's selection after the tree loses focus", async () => {
    project.paths = ["/repo/dir"];
    await getAction("vcs.showHistory")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
    expect(openLog).toHaveBeenCalledWith("history", "/repo/dir");
  });

  it("keeps an explicit path ahead of the Project view's selection", async () => {
    project.paths = ["/repo/dir"];
    await getAction("vcs.showHistory")!.run({ arg: ["/repo/file.ts"], ctx: { vcsAvailable: true } });
    expect(openLog).toHaveBeenCalledWith("history", "/repo/file.ts");
  });

  it("falls back to the active file without a Project view selection", async () => {
    await getAction("vcs.showHistory")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
    expect(openLog).toHaveBeenCalledWith("history", "/repo/active.ts");
  });
});
