import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContext, setContext } from "@/platform/context";
import { executeAction } from "@/platform/actions";
import { registerToolWindow } from "../contributions";
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
});
