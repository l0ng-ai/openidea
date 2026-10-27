import { describe, expect, it } from "vitest";
import { pageLabels } from "../pages/registry";
import { parentPath } from "../pages/runTargets";

describe("Run Targets page", () => {
  it("is found by its fields", () => {
    expect(pageLabels("build.runTargets")).toEqual(
      expect.arrayContaining(["SSH configuration", "Project folder on target", "Python interpreter"]),
    );
  });

  it("walks up remote folders", () => {
    expect(parentPath("/home/me/app")).toBe("/home/me");
    expect(parentPath("/home/")).toBe("/");
    expect(parentPath("~/app")).toBe("~");
    expect(parentPath("~")).toBeNull();
    expect(parentPath("/")).toBeNull();
  });
});
