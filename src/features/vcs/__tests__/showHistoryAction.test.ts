import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openLog = vi.hoisted(() => vi.fn());

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ activePath: () => "/repo/active.ts" }),
  toolWindowService: () => ({ show: () => undefined }),
}));
vi.mock("../logStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logStore")>()),
  openLogTab: openLog,
}));

import { executeAction } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { clearProjectViewLead, provideProjectViewSelection, setProjectViewLead } from "@/workbench/contributions";
import { registerVcsActions } from "../actions";

let unregister: () => void;
let disposeSelection: () => void;
let paths: string[];

function selectRoot() {
  paths = ["/repo"];
  setProjectViewLead({ path: "/repo", dir: true });
}

beforeEach(() => {
  openLog.mockClear();
  paths = [];
  disposeSelection = provideProjectViewSelection(() => paths);
  setContext("vcsAvailable", true);
  setContext("projectViewFocus", false);
  setContext("editorFocus", false);
  unregister = registerVcsActions();
});

afterEach(() => {
  unregister();
  disposeSelection();
  clearProjectViewLead();
  for (const key of ["vcsAvailable", "projectViewFocus", "editorFocus"]) clearContext(key);
});

describe("Show History for File", () => {
  it("uses the selected project root when the tree has the lead without keyboard focus", async () => {
    selectRoot();
    await executeAction("vcs.showHistory");
    expect(openLog).toHaveBeenCalledWith("history", "/repo");
  });

  it("uses the focused editor even if the tree still has a lead", async () => {
    selectRoot();
    setContext("editorFocus", true);
    await executeAction("vcs.showHistory");
    expect(openLog).toHaveBeenCalledWith("history", "/repo/active.ts");
  });

  it("uses the active file after a tab switch clears the lead while the tree keeps its selection", async () => {
    selectRoot();
    clearProjectViewLead();
    await executeAction("vcs.showHistory");
    expect(openLog).toHaveBeenCalledWith("history", "/repo/active.ts");
  });

  it("uses the selected project root while the tree has keyboard focus without a lead", async () => {
    paths = ["/repo"];
    setContext("projectViewFocus", true);
    await executeAction("vcs.showHistory");
    expect(openLog).toHaveBeenCalledWith("history", "/repo");
  });

  it("keeps an explicit path ahead of the Project view's selection", async () => {
    selectRoot();
    await executeAction("vcs.showHistory", ["/repo/file.ts"]);
    expect(openLog).toHaveBeenCalledWith("history", "/repo/file.ts");
  });

  it("falls back to the active file without a Project view selection", async () => {
    await executeAction("vcs.showHistory");
    expect(openLog).toHaveBeenCalledWith("history", "/repo/active.ts");
  });
});
