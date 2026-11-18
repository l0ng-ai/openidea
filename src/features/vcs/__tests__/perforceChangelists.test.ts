import { describe, expect, it } from "vitest";
import type { OpenedFile, PendingChangelist } from "@/bindings";
import { DEFAULT_LIST_ID, perforceChange, perforceState } from "../changelists";
import { gitTabs, shownTab, stashTabOf, stashTabs } from "../gitTabs";

const opened = (path: string, change: number): OpenedFile => ({
  path,
  relPath: path.replace("/ws/", ""),
  depotFile: path.replace("/ws/", "//depot/"),
  action: "edit",
  change,
  fileType: "text",
  haveRev: 1,
  headRev: 1,
  unresolved: false,
  movedFrom: null,
  locked: false,
  otherOpen: [],
});

const pending = (number: number, description: string, files: string[]): PendingChangelist => ({
  number,
  description,
  timeMs: 0,
  files: files.map((f) => opened(f, number)),
  shelved: false,
});

describe("Perforce changelists as Commit window lists", () => {
  it("maps pending changelists to lists and their files to project-relative paths", () => {
    const state = perforceState(
      [
        pending(0, "", ["/ws/app/a.txt"]),
        pending(120, "feature work\n\nmore detail\nand more", ["/ws/app/src/b.txt", "/ws/other/c.txt"]),
        pending(121, "", []),
      ],
      "/ws/app",
      "120",
    );
    expect(state.lists).toEqual([
      { id: DEFAULT_LIST_ID, name: "Default", comment: "" },
      { id: "120", name: "feature work", comment: "more detail\nand more" },
      { id: "121", name: "Changelist 121", comment: "" },
    ]);
    // A file of the workspace outside the project keeps its absolute path.
    expect(state.files).toEqual({ "a.txt": DEFAULT_LIST_ID, "src/b.txt": "120", "/ws/other/c.txt": "120" });
    expect(state.active).toBe("120");
  });

  it("falls back to the default list when the active one was submitted", () => {
    expect(perforceState([pending(0, "", [])], "/ws", "120").active).toBe(DEFAULT_LIST_ID);
    expect(perforceState([], "/ws", "120").lists).toHaveLength(1);
  });

  it("reads the changelist number of a list id", () => {
    expect(perforceChange(DEFAULT_LIST_ID)).toBe(0);
    expect(perforceChange("120")).toBe(120);
  });
});

describe("tabs of a project with Perforce workspaces only", () => {
  const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);
  const input = { combine: false, shelfCount: 0, stashCount: 0, tab: "changes", noStash: true };

  it("has no Stash tab, combined or not, and keeps the Shelf tab", () => {
    expect(stashTabs(input)).toEqual([]);
    expect(stashTabs({ ...input, combine: true })).toEqual([]);
    expect(ids(stashTabs({ ...input, combine: true, shelfCount: 2 }))).toEqual(["shelf"]);
    expect(ids(gitTabs({ ...input, modal: true, logTabs: [] }))).toEqual(["changes", "log", "console", "worktrees"]);
  });

  it("shows the changes instead of a remembered Stash tab", () => {
    expect(stashTabOf("stashes", false, true)).toBe("changes");
    expect(stashTabOf("shelf", true, true)).toBe("shelf");
    const tabs = gitTabs({ ...input, modal: true, logTabs: [], tab: "stashes" });
    expect(shownTab("stashes", tabs, false, true)).toBe("log");
  });
});
