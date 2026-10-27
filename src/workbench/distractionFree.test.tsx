import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { executeAction, getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { bindingsFor, installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { registerStatusItem, registerToolWindow } from "./contributions";
import { clearNotifications, useNotifications } from "./notificationStore";
import { notificationActions } from "./Notifications";
import {
  DISTRACTION_FREE_ACTION,
  DISTRACTION_FREE_HINT_KEY,
  distractionFreeHint,
  distractionFreeWidth,
  installDistractionFree,
  isDistractionFree,
  resetDistractionFree,
  setDistractionFree,
  useDistractionFree,
} from "./distractionFree";
import {
  hideAllToolWindows,
  isToolWindowVisible,
  loadToolWindowLayout,
  resetToolWindowLayout,
  showToolWindow,
  useToolWindowLayout,
} from "./toolwindows/store";

const Empty = () => null;
let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetToolWindowLayout();
  resetDistractionFree();
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
    registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: Empty }),
    registerToolWindow({ id: "structure", title: "Structure", icon: "structure", anchor: "right", component: Empty }),
  ];
  loadToolWindowLayout("/work/df");
  showToolWindow("terminal");
});

afterEach(() => {
  disposers.reverse().forEach((d) => d());
  resetDistractionFree();
  useKeymap.setState({ overrides: {} });
});

const savedVisible = () => JSON.parse(localStorage.getItem("openidea.layout.v1:/work/df")!).visible;

describe("distraction free mode", () => {
  it("toggles with one action whose title flips Enter / Exit, publishing a context key", async () => {
    disposers.push(installDistractionFree());
    expect(getAction(DISTRACTION_FREE_ACTION)?.title).toBe("Enter Distraction Free Mode");
    expect(getContext().distractionFree).toBe(false);
    await executeAction(DISTRACTION_FREE_ACTION);
    expect(isDistractionFree()).toBe(true);
    expect(getContext().distractionFree).toBe(true);
    expect(getAction(DISTRACTION_FREE_ACTION)?.title).toBe("Exit Distraction Free Mode");
    await executeAction(DISTRACTION_FREE_ACTION);
    expect(isDistractionFree()).toBe(false);
    expect(getAction(DISTRACTION_FREE_ACTION)?.title).toBe("Enter Distraction Free Mode");
  });

  it("hides tool windows and restores the previous layout on exit", () => {
    setDistractionFree(true);
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("terminal")).toBe(false);
    // A window opened meanwhile (by shortcut) is gone again after exit.
    showToolWindow("structure");
    expect(isToolWindowVisible("structure")).toBe(true);
    setDistractionFree(false);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible("structure")).toBe(false);
  });

  it("persists the layout to restore, not the hidden one", () => {
    setDistractionFree(true);
    showToolWindow("structure");
    expect(savedVisible()).toMatchObject({ left: "project", bottom: "terminal", right: null });
    // Leaving the mode (now or after a restart) loads the normal layout.
    resetDistractionFree();
    resetToolWindowLayout();
    loadToolWindowLayout("/work/df");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
  });

  it("does not disturb Hide All Tool Windows", () => {
    setDistractionFree(true);
    hideAllToolWindows();
    setDistractionFree(false);
    expect(useToolWindowLayout.getState().stashed).toBeNull();
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("survives an app restart and re-applies to a newly loaded project", () => {
    setDistractionFree(true);
    expect(localStorage.getItem("openidea.distractionFree")).toBe("1");
    // Restart: fresh module, layout and session state; only localStorage remains.
    sessionStorage.clear();
    useDistractionFree.setState({ active: false });
    resetToolWindowLayout();
    disposers.push(installDistractionFree());
    expect(isDistractionFree()).toBe(true);
    loadToolWindowLayout("/work/df");
    expect(isToolWindowVisible("project")).toBe(false);
    setDistractionFree(false);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(localStorage.getItem("openidea.distractionFree")).toBeNull();
  });

  it("is unbound in the IntelliJ keymap (⌃⌘D is macOS Look Up) and Escape does not exit", () => {
    disposers.push(installDistractionFree());
    expect(bindingsFor(DISTRACTION_FREE_ACTION)).toEqual([]);
    disposers.push(installKeyboardDispatcher(window));
    const press = (code: string, init: KeyboardEventInit) =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init }));
      });
    press("KeyD", { key: "d", ctrlKey: true, metaKey: true });
    expect(isDistractionFree()).toBe(false);
    setDistractionFree(true);
    press("Escape", { key: "Escape" });
    expect(isDistractionFree()).toBe(true);
    setDistractionFree(false);
  });

  describe("exit hint", () => {
    const hint = () => useNotifications.getState().items.find((n) => n.key === DISTRACTION_FREE_HINT_KEY);
    beforeEach(() => clearNotifications());

    it("tells how to leave the mode on entering, with an Exit action, and expires on exit", () => {
      setDistractionFree(true);
      expect(hint()?.balloon).toBe(true);
      expect(hint()?.body).toBe(distractionFreeHint());
      expect(distractionFreeHint()).toContain("View | Appearance | Exit Distraction Free Mode");
      // Unbound toggle (IntelliJ keymap): Find Action with its shortcut is the keyboard way out.
      expect(distractionFreeHint()).toMatch(/Find Action \(.+\)/);
      hint()!
        .actions!.find((a) => a.label === "Exit Distraction Free Mode")!
        .run();
      expect(isDistractionFree()).toBe(false);
      expect(hint()?.balloon ?? false).toBe(false);
    });

    it("names the toggle's own shortcut when it has one", () => {
      useKeymap.setState({ overrides: { [DISTRACTION_FREE_ACTION]: ["Ctrl+Alt+Z"] } });
      expect(distractionFreeHint()).not.toContain("Find Action");
    });

    it("shows again after a restart in the mode, once the project frame loads", () => {
      setDistractionFree(true);
      clearNotifications();
      useDistractionFree.setState({ active: false });
      resetToolWindowLayout();
      disposers.push(installDistractionFree());
      expect(isDistractionFree()).toBe(true);
      expect(hint()).toBeUndefined();
      loadToolWindowLayout("/work/df");
      expect(hint()?.balloon).toBe(true);
    });

    it("offers Don't Show Again once, scoped to its own notification group", () => {
      setDistractionFree(true);
      const labels = notificationActions(hint()!).map((a) => a.label);
      expect(labels.filter((l) => l === "Don't Show Again")).toHaveLength(1);
      expect(hint()!.group).toBe("distractionFree");
    });

    it("stays off once its group shows no popup", () => {
      const settings = useProject.getState().settings;
      useProject.setState({
        settings: { ...settings, notifications: { groups: { distractionFree: { display: "none" } } } } as never,
      });
      try {
        setDistractionFree(true);
        expect(hint()?.balloon ?? false).toBe(false);
      } finally {
        useProject.setState({ settings });
      }
    });
  });

  it("clamps the text width setting", () => {
    expect(distractionFreeWidth(undefined)).toBe(80);
    expect(distractionFreeWidth(100.4)).toBe(100);
    expect(distractionFreeWidth(3)).toBe(20);
    expect(distractionFreeWidth(Number.NaN)).toBe(80);
  });
});

describe("distraction free shell", () => {
  it("hides stripes, status bar and main toolbar contents, keeping the drag region", async () => {
    const { Workbench } = await import("./Workbench");
    disposers.push(
      registerStatusItem({ id: "t.status", align: "left", priority: 0, component: () => <span>status-x</span> }),
    );
    act(() => useProject.setState({ project: { root: "/work/df", name: "df-demo", isGit: false, settings: {} } }));
    const { unmount } = render(<Workbench />);
    expect(await screen.findByText("df-demo")).toBeInTheDocument();
    expect(screen.getByText("status-x")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();

    act(() => setDistractionFree(true));
    expect(screen.queryByText("df-demo")).toBeNull();
    expect(screen.queryByText("status-x")).toBeNull();
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search Everywhere" })).toBeNull();
    const bar = document.querySelector("header[data-titlebar='bare']");
    expect(bar).toHaveAttribute("data-tauri-drag-region");

    act(() => setDistractionFree(false));
    expect(screen.getByText("df-demo")).toBeInTheDocument();
    expect(screen.getByText("status-x")).toBeInTheDocument();
    unmount();
    useProject.setState({ project: null });
  });
});
