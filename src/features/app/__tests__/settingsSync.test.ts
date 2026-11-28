import { describe, expect, it } from "vitest";
import { syncedStorage, writeSyncedStorage } from "../settingsSync";

describe("Settings Sync storage", () => {
  it("splits IDE state by category and keeps project-scoped entries out", () => {
    expect(
      syncedStorage({
        "openidea.liveTemplates.v1": "[]",
        "openidea.fileTemplates.v1.project:/p": "{}",
        "openidea.macros.v1": "{}",
        "openidea.projectTree.options": "{}",
      }),
    ).toEqual({
      templates: { "openidea.liveTemplates.v1": "[]" },
      macros: { "openidea.macros.v1": "{}" },
      ui: { "openidea.projectTree.options": "{}" },
    });
  });

  it("replaces only the changed categories and never writes other keys", () => {
    localStorage.clear();
    localStorage.setItem("openidea.macros.v1", "old");
    localStorage.setItem("openidea.postfix.v1", "mine");
    localStorage.setItem("openidea.projectTree.options", "gone");
    writeSyncedStorage(
      { ui: { "openidea.vim.v1": "on", "openidea.recentProjects": "x" }, macros: { "openidea.macros.v1": "new" } },
      localStorage,
    );
    expect(localStorage.getItem("openidea.macros.v1")).toBe("new");
    expect(localStorage.getItem("openidea.postfix.v1")).toBe("mine");
    expect(localStorage.getItem("openidea.projectTree.options")).toBeNull();
    expect(localStorage.getItem("openidea.vim.v1")).toBe("on");
    expect(localStorage.getItem("openidea.recentProjects")).toBeNull();
  });
});
