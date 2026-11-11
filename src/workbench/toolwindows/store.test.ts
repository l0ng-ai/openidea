import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContext } from "@/platform/context";
import { actionToggled, executeAction, getAction } from "@/platform/actions";
import { registerToolWindow } from "../contributions";
import { installToolWindowActions } from "./actions";
import {
  activateToolWindow,
  hideActiveToolWindow,
  hideAllToolWindows,
  hideToolWindow,
  hasStripeButton,
  removeFromStripe,
  anchorOf,
  isToolWindowVisible,
  loadToolWindowLayout,
  moveToolWindow,
  installToolWindowLayoutSync,
  resizeActiveToolWindow,
  RESIZE_STEP,
  resetToolWindowPlacements,
  setToolWindowSplit,
  slotOfId,
  toggleMaximizeToolWindow,
  sanitizePlacements,
  resetToolWindowLayout,
  restoreMaximizedToolWindow,
  setFocusedToolWindow,
  setToolWindowSize,
  setToolWindowViewMode,
  showToolWindow,
  toggleToolWindow,
  toolWindowServiceImpl,
  useToolWindowLayout,
  viewModeOf,
} from "./store";

const Empty = () => null;
let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  resetToolWindowLayout();
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
    registerToolWindow({ id: "structure", title: "Structure", icon: "structure", anchor: "left", component: Empty }),
    registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: Empty }),
    registerToolWindow({ id: "problems", title: "Problems", icon: "problems", anchor: "bottom", component: Empty }),
  ];
  loadToolWindowLayout("/work/a");
});

afterEach(() => disposers.forEach((d) => d()));

describe("tool window semantics", () => {
  it("shows one window per anchor; showing another replaces it", () => {
    expect(isToolWindowVisible("project")).toBe(true);
    showToolWindow("structure");
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(isToolWindowVisible("project")).toBe(false);
    showToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(getContext()["toolWindow.terminal.visible"]).toBe(true);
    // previously shown windows stay mounted (keep-alive)
    expect(useToolWindowLayout.getState().mounted.has("project")).toBe(true);
  });

  it("toggle shows (requesting focus) and hides", () => {
    toggleToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(useToolWindowLayout.getState().focusRequest?.id).toBe("terminal");
    toggleToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(false);
  });

  it("activate: hidden → show, visible unfocused → focus, focused → hide", () => {
    activateToolWindow("problems");
    expect(isToolWindowVisible("problems")).toBe(true);
    const seq = useToolWindowLayout.getState().focusRequest!.seq;
    activateToolWindow("problems");
    expect(isToolWindowVisible("problems")).toBe(true);
    expect(useToolWindowLayout.getState().focusRequest!.seq).toBeGreaterThan(seq);
    setFocusedToolWindow("problems");
    expect(getContext().toolWindowFocus).toBe(true);
    expect(getContext().activeToolWindow).toBe("problems");
    activateToolWindow("problems");
    expect(isToolWindowVisible("problems")).toBe(false);
  });

  it("hide all stashes and restores; hide active hides the focused window", () => {
    showToolWindow("terminal");
    hideAllToolWindows();
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("terminal")).toBe(false);
    hideAllToolWindows();
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    setFocusedToolWindow("terminal");
    hideActiveToolWindow();
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("restores the maximized side through the shared Hide All toggle", () => {
    showToolWindow("terminal");
    toggleMaximizeToolWindow("terminal");
    const before = useToolWindowLayout.getState();
    hideAllToolWindows();
    expect(useToolWindowLayout.getState().maximized).toBeNull();
    hideAllToolWindows();
    expect(useToolWindowLayout.getState()).toMatchObject({ visible: before.visible, maximized: "bottom" });
  });

  it("resizes the active window by moving its inner edge", () => {
    showToolWindow("terminal");
    setFocusedToolWindow("terminal");
    const before = useToolWindowLayout.getState().sizes.bottom;
    resizeActiveToolWindow("up");
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(before + RESIZE_STEP);
    resizeActiveToolWindow("down");
    resizeActiveToolWindow("down");
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(before - RESIZE_STEP);
    resizeActiveToolWindow("left");
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(before - RESIZE_STEP);
    setFocusedToolWindow("project");
    const left = useToolWindowLayout.getState().sizes.left;
    resizeActiveToolWindow("right");
    expect(useToolWindowLayout.getState().sizes.left).toBe(left + RESIZE_STEP);
  });

  it("ignores unknown ids and hiding a window that isn't visible", () => {
    showToolWindow("nope");
    hideToolWindow("structure");
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("is exposed through the ToolWindowService", () => {
    toolWindowServiceImpl.show("terminal");
    expect(toolWindowServiceImpl.isVisible("terminal")).toBe(true);
    toolWindowServiceImpl.hide("terminal");
    expect(toolWindowServiceImpl.isVisible("terminal")).toBe(false);
  });
});

describe("tool window persistence", () => {
  it.each(["left", "right", "bottom"] as const)("preserves the %s layout through maximize and reload", (anchor) => {
    moveToolWindow("terminal", anchor);
    moveToolWindow("problems", `${anchor}-split`);
    showToolWindow("terminal");
    showToolWindow("problems");
    setToolWindowSize(anchor, 987);
    setToolWindowSplit(anchor, 0.63);
    const before = useToolWindowLayout.getState();
    toggleMaximizeToolWindow("terminal");
    setToolWindowSize(anchor, 111);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible("problems")).toBe(true);
    if (anchor !== "left") {
      expect(isToolWindowVisible("project")).toBe(false);
      expect(getContext()["toolWindow.project.visible"]).toBe(false);
    }
    toggleMaximizeToolWindow("terminal");
    expect(useToolWindowLayout.getState()).toMatchObject({
      visible: before.visible,
      sizes: before.sizes,
      splits: before.splits,
    });
    toggleMaximizeToolWindow("terminal");
    // Saving another layout choice while maximized must retain all the original anchors.
    setToolWindowSplit(anchor, 0.63);
    showToolWindow("terminal");
    loadToolWindowLayout("/work/a");
    expect(useToolWindowLayout.getState()).toMatchObject({
      visible: before.visible,
      sizes: before.sizes,
      splits: before.splits,
      maximized: null,
    });
  });

  it("restores other anchors on navigation, opening another side, or closing the maximized window", () => {
    showToolWindow("terminal");
    toggleMaximizeToolWindow("terminal");
    restoreMaximizedToolWindow();
    expect(isToolWindowVisible("project")).toBe(true);
    toggleMaximizeToolWindow("terminal");
    showToolWindow("project", true);
    expect(useToolWindowLayout.getState().maximized).toBeNull();
    toggleMaximizeToolWindow("terminal");
    hideToolWindow("terminal");
    expect(useToolWindowLayout.getState().maximized).toBeNull();
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("persists visible windows and sizes per project root", () => {
    showToolWindow("structure");
    showToolWindow("terminal");
    setToolWindowSize("bottom", 333);
    loadToolWindowLayout("/work/b");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(useToolWindowLayout.getState().sizes.bottom).not.toBe(333);
    loadToolWindowLayout("/work/a");
    expect(isToolWindowVisible("structure")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(useToolWindowLayout.getState().sizes.bottom).toBe(333);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("openidea.layout.v1:/work/c", "{not json");
    loadToolWindowLayout("/work/c");
    expect(isToolWindowVisible("project")).toBe(true);
  });
});

describe("tool window actions", () => {
  it("registers toolwindow.<id> and generic actions", async () => {
    const dispose = installToolWindowActions();
    expect(getAction("toolwindow.terminal")?.title).toBe("Terminal");
    expect(getAction("toolwindow.hideAll")).toBeDefined();
    await executeAction("toolwindow.terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    const late = registerToolWindow({ id: "git", title: "Git", icon: "branch", anchor: "bottom", component: Empty });
    expect(getAction("toolwindow.git")).toBeDefined();
    late();
    expect(getAction("toolwindow.git")).toBeUndefined();
    dispose();
    expect(getAction("toolwindow.terminal")).toBeUndefined();
  });

  it("a later registration with the same id replaces the earlier one", () => {
    const Real = () => null;
    const disposeReal = registerToolWindow({
      id: "project",
      title: "Project",
      icon: "folder",
      anchor: "left",
      component: Real,
    });
    disposers[0]!(); // the earlier (sample) disposer must not remove the replacement
    expect(isToolWindowVisible("project")).toBe(true);
    disposeReal();
  });
});

describe("tool window placement", () => {
  it("moves a window to another area, keeps it visible and persists", () => {
    showToolWindow("structure");
    moveToolWindow("structure", "right");
    expect(anchorOf("structure")).toBe("right");
    expect(useToolWindowLayout.getState().visible).toMatchObject({ left: null, right: "structure" });
    expect(getContext()["toolWindow.structure.visible"]).toBe(true);
    loadToolWindowLayout("/work/a");
    expect(anchorOf("structure")).toBe("right");
    expect(useToolWindowLayout.getState().visible.right).toBe("structure");
    loadToolWindowLayout("/work/b");
    expect(anchorOf("structure")).toBe("left");
  });

  it("orders windows within the target area", () => {
    moveToolWindow("terminal", "left", "project");
    const p = useToolWindowLayout.getState().placements;
    expect(p.terminal).toMatchObject({ anchor: "left", split: false });
    expect(p.terminal!.order!).toBeLessThan(p.project!.order!);
    moveToolWindow("terminal", "bottom");
    expect(anchorOf("terminal")).toBe("bottom");
  });

  it("restores the default layout", () => {
    moveToolWindow("project", "right-split");
    expect(useToolWindowLayout.getState().placements.project).toMatchObject({ anchor: "right", split: true });
    expect(slotOfId("project")).toBe("right-split");
    resetToolWindowPlacements();
    expect(slotOfId("project")).toBe("left");
  });

  it("sanitizes stored placements", () => {
    expect(
      sanitizePlacements({ a: { anchor: "top" }, b: { anchor: "bottom", order: 5, split: true }, c: null }),
    ).toEqual({
      b: { anchor: "bottom", order: 5, split: true },
    });
  });
});

describe("split areas", () => {
  beforeEach(() => {
    disposers.push(
      registerToolWindow({
        id: "bookmarks",
        title: "Bookmarks",
        icon: "bookmark",
        anchor: "left",
        secondary: true,
        component: Empty,
      }),
    );
  });

  it("shows one window per area, both areas of a side at once", () => {
    showToolWindow("bookmarks");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("bookmarks")).toBe(true);
    expect(useToolWindowLayout.getState().visible).toMatchObject({ left: "project", "left-split": "bookmarks" });
    showToolWindow("structure");
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("bookmarks")).toBe(true);
  });

  it("Move To places a window in any of the six areas", () => {
    showToolWindow("terminal");
    moveToolWindow("terminal", "bottom-split");
    expect(useToolWindowLayout.getState().visible).toMatchObject({ bottom: null, "bottom-split": "terminal" });
    showToolWindow("problems");
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible("problems")).toBe(true);
    moveToolWindow("bookmarks", "left");
    expect(slotOfId("bookmarks")).toBe("left");
    // An explicit primary placement on its own side overrides the contribution's split default.
    loadToolWindowLayout("/work/a");
    expect(slotOfId("bookmarks")).toBe("left");
    expect(isToolWindowVisible("terminal")).toBe(true);
  });

  it("keeps the side maximized while its other area shows a window", () => {
    showToolWindow("bookmarks");
    toggleMaximizeToolWindow("project");
    setFocusedToolWindow("bookmarks");
    hideToolWindow("bookmarks");
    expect(useToolWindowLayout.getState().maximized).toBe("left");
    expect(useToolWindowLayout.getState().focusRequest?.id).toBe("project");
    hideToolWindow("project");
    expect(useToolWindowLayout.getState().maximized).toBeNull();
  });

  it("hide all stashes and restores both areas", () => {
    showToolWindow("bookmarks");
    hideAllToolWindows();
    expect(isToolWindowVisible("bookmarks")).toBe(false);
    hideAllToolWindows();
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("bookmarks")).toBe(true);
  });

  it("persists the split ratio, clamped", () => {
    setToolWindowSplit("left", 0.3);
    setToolWindowSplit("bottom", 5);
    loadToolWindowLayout("/work/a");
    expect(useToolWindowLayout.getState().splits).toMatchObject({ left: 0.3, bottom: 0.9, right: 0.5 });
  });

  it("migrates a layout saved with one area per side", () => {
    localStorage.setItem(
      "openidea.layout.v1:/work/old",
      JSON.stringify({
        visible: { left: "bookmarks", right: "terminal", bottom: "problems" },
        sizes: { left: 300, right: 300, bottom: 200 },
        placements: {
          // Old "Right Bottom" stripe group: now the Right Bottom area.
          terminal: { anchor: "right", secondary: true, order: 10 },
          // Renumbered in the old bottom group with the contribution's flag: meaningless there.
          problems: { anchor: "bottom", secondary: true, order: 20 },
          bookmarks: { anchor: "left", order: 30 },
        },
      }),
    );
    loadToolWindowLayout("/work/old");
    expect(slotOfId("terminal")).toBe("right-split");
    expect(slotOfId("problems")).toBe("bottom");
    expect(slotOfId("bookmarks")).toBe("left-split");
    expect(isToolWindowVisible("bookmarks")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible("problems")).toBe(true);
    expect(useToolWindowLayout.getState().sizes.left).toBe(300);
    showToolWindow("project");
    expect(JSON.parse(localStorage.getItem("openidea.layout.v1:/work/old")!)).toMatchObject({
      v: 2,
      visible: { left: "project", "left-split": "bookmarks", "right-split": "terminal" },
    });
  });

  it("moves a late-registered window recorded in the wrong area to its own", () => {
    const sync = installToolWindowLayoutSync();
    localStorage.setItem("openidea.layout.v1:/work/late", JSON.stringify({ visible: { left: "late" } }));
    loadToolWindowLayout("/work/late");
    expect(useToolWindowLayout.getState().visible.left).toBe("late");
    disposers.push(
      registerToolWindow({ id: "late", title: "Late", icon: "x", anchor: "left", secondary: true, component: Empty }),
    );
    expect(useToolWindowLayout.getState().visible).toMatchObject({ left: null, "left-split": "late" });
    expect(getContext()["toolWindow.late.visible"]).toBe(true);
    sync();
  });

  it("clears maximized and restores other tool windows when a maximized plugin window unregisters", () => {
    const sync = installToolWindowLayoutSync();
    const disposeK8s = registerToolWindow({
      id: "plugin.k8s.view:kubernetes",
      title: "Kubernetes",
      icon: "cloud",
      anchor: "right",
      secondary: true,
      component: Empty,
    });
    showToolWindow("plugin.k8s.view:kubernetes", true);
    setFocusedToolWindow("plugin.k8s.view:kubernetes");
    toggleMaximizeToolWindow("plugin.k8s.view:kubernetes");
    expect(useToolWindowLayout.getState().maximized).toBe("right");
    expect(isToolWindowVisible("project")).toBe(false);
    expect(getContext()["toolWindow.project.visible"]).toBe(false);

    disposeK8s();

    expect(useToolWindowLayout.getState().maximized).toBeNull();
    expect(useToolWindowLayout.getState().focused).toBeNull();
    expect(useToolWindowLayout.getState().lastActive).toBeNull();
    expect(isToolWindowVisible("project")).toBe(true);
    expect(getContext()["toolWindow.project.visible"]).toBe(true);
    expect(getContext().toolWindowFocus).toBe(false);
    sync();
  });
});

describe("stripe buttons", () => {
  const find = {
    id: "find",
    title: "Find",
    icon: "search",
    anchor: "bottom" as const,
    component: Empty,
    stripe: "onUse" as const,
  };
  const buttons = () => useToolWindowLayout.getState().stripeButtons;

  it("adds an on-use window's button when opened and removes it on Hide, persisted per project", () => {
    disposers.push(registerToolWindow(find));
    expect(hasStripeButton(find, buttons())).toBe(false);
    showToolWindow("find");
    expect(hasStripeButton(find, buttons())).toBe(true);
    removeFromStripe("find");
    expect(isToolWindowVisible("find")).toBe(false);
    expect(hasStripeButton(find, buttons())).toBe(false);

    removeFromStripe("terminal");
    loadToolWindowLayout("/work/a");
    expect(buttons()).toEqual({ find: false, terminal: false });
    resetToolWindowPlacements();
    expect(buttons()).toEqual({});
  });
});

describe("view modes", () => {
  it("are remembered per window and project; Restore Default Layout docks and pins every window", () => {
    expect(viewModeOf("project")).toBe("dockPinned");
    setToolWindowViewMode("project", "undock");
    setToolWindowViewMode("terminal", "dockUnpinned");
    loadToolWindowLayout("/work/b");
    expect(viewModeOf("project")).toBe("dockPinned");
    loadToolWindowLayout("/work/a");
    expect(viewModeOf("project")).toBe("undock");
    expect(viewModeOf("terminal")).toBe("dockUnpinned");
    resetToolWindowPlacements();
    expect(useToolWindowLayout.getState().viewModes).toEqual({});
  });

  it("ignores unknown stored modes", () => {
    localStorage.setItem(
      "openidea.layout.v1:/work/c",
      JSON.stringify({ v: 2, viewModes: { project: "float", terminal: "undock", problems: 3 } }),
    );
    loadToolWindowLayout("/work/c");
    expect(useToolWindowLayout.getState().viewModes).toEqual({ terminal: "undock" });
  });

  it("unpinned and undocked windows hide when focus moves to the editor or another tool window", () => {
    setToolWindowViewMode("project", "dockUnpinned");
    setToolWindowViewMode("terminal", "undock");
    showToolWindow("terminal");
    setFocusedToolWindow("project");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(false);

    showToolWindow("terminal");
    setFocusedToolWindow("terminal");
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("terminal")).toBe(true);

    setFocusedToolWindow(null, true);
    expect(isToolWindowVisible("terminal")).toBe(false);
  });

  it("stay when focus goes to a popup or dialog; pinned windows never hide on focus", () => {
    setToolWindowViewMode("project", "dockUnpinned");
    showToolWindow("terminal");
    setFocusedToolWindow("project");
    setFocusedToolWindow(null);
    expect(isToolWindowVisible("project")).toBe(true);
    setFocusedToolWindow(null, true);
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("terminal")).toBe(true);
  });

  it("toolwindow.viewMode.* set the mode of the window an Options menu names, else of the active one", async () => {
    const dispose = installToolWindowActions();
    await executeAction("toolwindow.viewMode.undock", "terminal");
    expect(viewModeOf("terminal")).toBe("undock");

    setFocusedToolWindow("project");
    expect(actionToggled(getAction("toolwindow.viewMode.dockPinned"))).toBe(true);
    await executeAction("toolwindow.viewMode.dockUnpinned");
    expect(viewModeOf("project")).toBe("dockUnpinned");
    expect(actionToggled(getAction("toolwindow.viewMode.dockUnpinned"))).toBe(true);
    expect(actionToggled(getAction("toolwindow.viewMode.dockPinned"))).toBe(false);

    await executeAction("toolwindow.viewMode.dockPinned", "terminal");
    expect(useToolWindowLayout.getState().viewModes).toEqual({ project: "dockUnpinned" });
    dispose();
  });
});
