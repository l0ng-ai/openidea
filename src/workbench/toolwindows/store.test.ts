import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContext } from "@/platform/context";
import { executeAction, getAction } from "@/platform/actions";
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
  setFocusedToolWindow,
  setToolWindowSize,
  showToolWindow,
  toggleToolWindow,
  toolWindowServiceImpl,
  useToolWindowLayout,
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
    hideToolWindow("bookmarks");
    expect(useToolWindowLayout.getState().maximized).toBe("left");
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
