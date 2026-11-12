import { describe, expect, it } from "vitest";
import { auxiliaryWindow } from "./auxWindow";
import capability from "../../src-tauri/capabilities/default.json";
import bridgeCapability from "../../src-tauri/capabilities/e2e.json";

describe("auxiliaryWindow", () => {
  it("reads the kind and parent from the label", () => {
    expect(auxiliaryWindow("settings-main")).toEqual({ kind: "settings", parent: "main" });
    expect(auxiliaryWindow("settings-project-2")).toEqual({ kind: "settings", parent: "project-2" });
    expect(auxiliaryWindow("comparison-main-0")).toEqual({ kind: "comparison", parent: "main" });
    expect(auxiliaryWindow("comparison-project-2-14")).toEqual({ kind: "comparison", parent: "project-2" });
    expect(auxiliaryWindow("diff-main-0")).toEqual({ kind: "diff", parent: "main" });
    expect(auxiliaryWindow("diff-project-2-14")).toEqual({ kind: "diff", parent: "project-2" });
    expect(auxiliaryWindow("deployment-project-2")).toEqual({ kind: "deployment", parent: "project-2" });
  });

  it.each(["settings", "comparison", "diff", "deployment"])("grants %s windows permission to close", (kind) => {
    expect(capability.windows).toContain(`${kind}-*`);
    expect(bridgeCapability.windows).toContain(`${kind}-*`);
    expect(capability.permissions).toContain("core:window:allow-close");
    expect(capability.permissions).toContain("core:window:allow-destroy");
  });

  it("leaves project windows and malformed labels alone", () => {
    for (const label of ["", "main", "project-1", "settings-", "comparison-main", "comparison-main-x"]) {
      expect(auxiliaryWindow(label)).toBeNull();
    }
  });
});
