import { describe, expect, it } from "vitest";
import { joinPath, projectNameError } from "../NewProject";
import { exportedStorage } from "../projectActions";

describe("File › New Project…", () => {
  it("validates the folder name", () => {
    expect(projectNameError("demo")).toBeNull();
    expect(projectNameError("  ")).toBe("Enter a project name");
    expect(projectNameError("a/b")).not.toBeNull();
    expect(projectNameError("..")).not.toBeNull();
  });

  it("joins the location and name with the location's separator", () => {
    expect(joinPath("/Users/me/Projects", " demo ")).toBe("/Users/me/Projects/demo");
    expect(joinPath("/Users/me/", "demo")).toBe("/Users/me/demo");
    expect(joinPath("C:\\Users\\me", "demo")).toBe("C:\\Users\\me\\demo");
  });
});

describe("Manage IDE Settings › Export Settings…", () => {
  it("exports templates, macros, layouts and view options, not per-project state", () => {
    const data: Record<string, string> = {
      "openidea.liveTemplates.v1": "[]",
      "openidea.macros.v1": "{}",
      "openidea.toolWindowLayouts.v1": "{}",
      "openidea.projectTree.options": '{"singleClickOpen":true}',
      "openidea.projectTree.expanded:/p": "[]",
      "openidea.runAnything.history.v1:/p": "[]",
    };
    const keys = Object.keys(data);
    const storage = {
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
      getItem: (k: string) => data[k] ?? null,
    };
    expect(Object.keys(exportedStorage(storage)).sort()).toEqual([
      "openidea.liveTemplates.v1",
      "openidea.macros.v1",
      "openidea.projectTree.options",
      "openidea.toolWindowLayouts.v1",
    ]);
  });
});
