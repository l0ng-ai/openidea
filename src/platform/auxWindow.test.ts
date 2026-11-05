import { describe, expect, it } from "vitest";
import { auxiliaryWindow } from "./auxWindow";

describe("auxiliaryWindow", () => {
  it("reads the kind and parent from the label", () => {
    expect(auxiliaryWindow("settings-main")).toEqual({ kind: "settings", parent: "main" });
    expect(auxiliaryWindow("settings-project-2")).toEqual({ kind: "settings", parent: "project-2" });
    expect(auxiliaryWindow("comparison-main-0")).toEqual({ kind: "comparison", parent: "main" });
    expect(auxiliaryWindow("comparison-project-2-14")).toEqual({ kind: "comparison", parent: "project-2" });
    expect(auxiliaryWindow("deployment-project-2")).toEqual({ kind: "deployment", parent: "project-2" });
  });

  it("leaves project windows and malformed labels alone", () => {
    for (const label of ["", "main", "project-1", "settings-", "comparison-main", "comparison-main-x"]) {
      expect(auxiliaryWindow(label)).toBeNull();
    }
  });
});
