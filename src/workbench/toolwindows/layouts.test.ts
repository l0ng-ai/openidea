import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContext, setContext } from "@/platform/context";
import { executeAction } from "@/platform/actions";
import { registerToolWindow } from "../contributions";
import * as inputDialogs from "../inputDialogs";
import * as messages from "../messages";
import { installToolWindowActions } from "./actions";
import {
  _reloadLayouts,
  deleteLayout,
  layoutNames,
  renameLayout,
  restoreDefaultLayout,
  restoreLayout,
  saveLayout,
  useToolWindowLayouts,
} from "./layouts";
import {
  isToolWindowVisible,
  loadToolWindowLayout,
  resetToolWindowLayout,
  setToolWindowSize,
  setToolWindowViewMode,
  showToolWindow,
  useToolWindowLayout,
  viewModeOf,
} from "./store";

const Empty = () => null;
let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  _reloadLayouts();
  resetToolWindowLayout();
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
    registerToolWindow({ id: "structure", title: "Structure", icon: "structure", anchor: "left", component: Empty }),
    registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: Empty }),
    installToolWindowActions(),
  ];
  loadToolWindowLayout("/work/a");
});

afterEach(() => disposers.forEach((d) => d()));

describe("tool window layouts", () => {
  it("restores the current layout, and saves changes into it", async () => {
    setContext("projectOpen", true);
    setToolWindowSize("bottom", 400);
    saveLayout("Custom 1");
    setToolWindowSize("bottom", 200);
    await executeAction("layout.restoreCurrent");
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(400);

    expect(getContext().toolWindowLayoutActive).toBe(true);
    setToolWindowSize("bottom", 300);
    await executeAction("layout.saveCurrent");
    setToolWindowSize("bottom", 200);
    await executeAction("layout.restoreCurrent");
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(300);
    expect(layoutNames()).toEqual(["Custom 1"]);

    // With no active layout it is the default one.
    restoreDefaultLayout();
    expect(getContext().toolWindowLayoutActive).toBe(false);
    const defaultBottom = useToolWindowLayout.getState().sizes.bottom;
    setToolWindowSize("bottom", 350);
    await executeAction("layout.restoreCurrent");
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(defaultBottom);
    setContext("projectOpen", false);
  });

  it("saves and restores visible windows and sizes by name", () => {
    showToolWindow("structure");
    showToolWindow("terminal");
    setToolWindowSize("bottom", 400);
    saveLayout("Debugging");
    showToolWindow("project");
    setToolWindowSize("bottom", 200);

    expect(restoreLayout("Debugging")).toBe(true);
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(400);
    expect(useToolWindowLayouts.getState().active).toBe("Debugging");
    expect(restoreLayout("Missing")).toBe(false);
  });

  it("restores the default layout", () => {
    showToolWindow("terminal");
    restoreDefaultLayout();
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("saves view modes with a layout; the default layout docks and pins every window", () => {
    setToolWindowViewMode("project", "undock");
    saveLayout("Sliding");
    setToolWindowViewMode("project", "dockUnpinned");
    expect(restoreLayout("Sliding")).toBe(true);
    expect(viewModeOf("project")).toBe("undock");
    restoreDefaultLayout();
    expect(viewModeOf("project")).toBe("dockPinned");
  });

  it("replaces a layout of the same name, renames and deletes", () => {
    saveLayout("A");
    saveLayout("B");
    saveLayout("A");
    expect(layoutNames()).toEqual(["A", "B"]);
    expect(renameLayout("A", "B")).toBe(false);
    expect(renameLayout("A", " ")).toBe(false);
    expect(renameLayout("A", "C")).toBe(true);
    expect(layoutNames()).toEqual(["C", "B"]);
    expect(useToolWindowLayouts.getState().active).toBe("C");
    deleteLayout("C");
    expect(layoutNames()).toEqual(["B"]);
    expect(useToolWindowLayouts.getState().active).toBeNull();
  });

  it("persists across reloads and ignores malformed entries", () => {
    saveLayout("Kept");
    _reloadLayouts();
    expect(layoutNames()).toEqual(["Kept"]);
    localStorage.setItem(
      "openidea.toolWindowLayouts.v1",
      JSON.stringify({ layouts: [{ name: "" }, { nope: 1 }, { name: "X", layout: 5 }] }),
    );
    _reloadLayouts();
    expect(layoutNames()).toEqual(["X"]);
  });

  it("restores by name through the action (Window › Tool Window Layouts items)", async () => {
    expect(getContext().toolWindowLayoutsSaved).toBeFalsy();
    showToolWindow("terminal");
    saveLayout("Run");
    expect(getContext().toolWindowLayoutsSaved).toBe(true);
    restoreDefaultLayout();
    setContext("projectOpen", true);
    await executeAction("layout.restore", "Run");
    setContext("projectOpen", false);
    expect(isToolWindowVisible("terminal")).toBe(true);
  });

  it("renames and deletes the layout passed by its menu without opening the chooser", async () => {
    saveLayout("Focus");
    saveLayout("Review");
    const choose = vi.spyOn(inputDialogs, "chooseItem").mockResolvedValue(null);
    const prompt = vi.spyOn(inputDialogs, "promptInput").mockResolvedValue("Code review");
    const confirm = vi.spyOn(messages, "confirm").mockResolvedValue(true);
    try {
      await executeAction("layout.rename", "Review");
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ initial: "Review" }));
      expect(layoutNames()).toEqual(["Focus", "Code review"]);

      await executeAction("layout.delete", "Code review");
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Delete the layout 'Code review'?" }));
      expect(layoutNames()).toEqual(["Focus"]);
      expect(choose).not.toHaveBeenCalled();
    } finally {
      choose.mockRestore();
      prompt.mockRestore();
      confirm.mockRestore();
    }
  });
});
