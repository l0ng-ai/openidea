import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { useWindowGroup } from "@/platform/windowGroups";
import { setDragRequiresAlt } from "@/ui";
import { useContextMenuStore } from "@/ui/Menu";
import { projectColorVars } from "./projectColor";
import { setTabColorOverride } from "./tabColors";
import { projectTabDropTarget, WindowGroupTabs } from "./WindowGroupTabs";
import styles from "./WindowGroupTabs.module.css";

vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.mocked(executeAction).mockClear();
  localStorage.clear();
  useWindowGroup.setState({
    tabs: [
      { label: "main", name: "Frontend", root: "/front", current: true },
      { label: "project-1", name: "Backend", root: "/back", current: false },
    ],
  });
});

it("switches and closes the intended project with mouse and keyboard", () => {
  render(<WindowGroupTabs />);
  const first = screen.getByRole("tab", { name: "Frontend" });
  expect(first).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Backend" })).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "project-1");
  fireEvent.click(screen.getByRole("button", { name: "Close Backend" }));
  expect(executeAction).toHaveBeenLastCalledWith("window.closeTab", "project-1");
  fireEvent.click(first);
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "main");
});

it("removes the tab row when the group dissolves", () => {
  useWindowGroup.setState({ tabs: [] });
  render(<WindowGroupTabs />);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

it("offers closing the other tabs and those on either side of the clicked tab", () => {
  useWindowGroup.setState({
    tabs: [
      { label: "main", name: "Frontend", root: "/front", current: true },
      { label: "project-1", name: "Backend", root: "/back", current: false },
      { label: "project-2", name: "Docs", root: "/docs", current: false },
    ],
  });
  render(<WindowGroupTabs />);
  const menuFor = (name: string) => {
    fireEvent.contextMenu(screen.getByRole("tab", { name }));
    const items = useContextMenuStore.getState().menu!.items;
    return (label: string) =>
      items.find((i) => "label" in i && i.label === label) as { disabled?: boolean; run?: () => unknown };
  };
  const first = menuFor("Frontend");
  expect(first("Close Tabs to the Left").disabled).toBe(true);
  expect(first("Close Tabs to the Right").disabled).toBe(false);
  const middle = menuFor("Backend");
  void middle("Close Other Tabs").run?.();
  expect(executeAction).toHaveBeenLastCalledWith("window.closeOtherTabs", "project-1");
  void middle("Close Tabs to the Left").run?.();
  expect(executeAction).toHaveBeenLastCalledWith("window.closeTabsToLeft", "project-1");
  expect(menuFor("Docs")("Close Tabs to the Right").disabled).toBe(true);
});

it("moves any tab to a new window from its own arrow, without selecting it first", () => {
  render(<WindowGroupTabs />);
  fireEvent.click(screen.getByRole("button", { name: "Move Backend to New Window" }));
  expect(executeAction).toHaveBeenLastCalledWith("window.detachTab", "project-1");
  expect(executeAction).not.toHaveBeenCalledWith("window.selectTab", "project-1");
});

it("offers Move Tab to New Window for every tab in its context menu", () => {
  render(<WindowGroupTabs />);
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Backend" }));
  const item = useContextMenuStore
    .getState()
    .menu!.items.find((i) => "label" in i && i.label === "Move Tab to New Window") as {
    disabled?: boolean;
    run?: () => unknown;
  };
  expect(item.disabled).toBeUndefined();
  void item.run?.();
  expect(executeAction).toHaveBeenLastCalledWith("window.detachTab", "project-1");
});

it("offers Tab Color… in the context menu", () => {
  render(<WindowGroupTabs />);
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Backend" }));
  const item = useContextMenuStore
    .getState()
    .menu!.items.find((i) => "label" in i && i.label === "Change Project Color…") as {
    run?: () => unknown;
  };
  void item.run?.();
  expect(executeAction).toHaveBeenLastCalledWith("window.setTabColor", "project-1");
});

it("tints only tabs with a stored colour override", () => {
  setTabColorOverride("/back", "#112233");
  render(<WindowGroupTabs />);
  const front = screen.getByRole("tab", { name: "Frontend" }).parentElement!;
  const back = screen.getByRole("tab", { name: "Backend" }).parentElement!;
  expect(front.style.getPropertyValue("--project-color")).toBe(projectColorVars("Frontend")["--project-color"]);
  expect(front.hasAttribute("data-tinted")).toBe(false);
  expect(back.style.getPropertyValue("--project-color")).toBe("#112233");
  expect(back.hasAttribute("data-tinted")).toBe(true);
});

describe("WindowGroupTabs drag reordering", () => {
  let hit: Element | null;
  const pointer = (el: Element | Window, type: string, x: number, y = 15, extra: MouseEventInit = {}) =>
    fireEvent(
      el,
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
        ...extra,
      }),
    );

  beforeEach(() => {
    hit = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    setDragRequiresAlt(() => false);
    useWindowGroup.setState({
      tabs: [
        { label: "a", name: "Alpha", root: "/a", current: true },
        { label: "b", name: "Beta", root: "/b", current: false },
        { label: "c", name: "Gamma", root: "/c", current: false },
      ],
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      if (parent?.getAttribute("role") === "tablist") {
        const index = [...parent.children].indexOf(this);
        return new DOMRect(index * 202, 0, 200, 30);
      }
      return new DOMRect(0, 0, 606, 30);
    });
  });

  afterEach(() => {
    setDragRequiresAlt(() => false);
    vi.restoreAllMocks();
  });

  it("ignores no-op slots adjacent to the dragged tab and maps insertion points to target indices", () => {
    expect(projectTabDropTarget(0, 0)).toBeNull();
    expect(projectTabDropTarget(0, 1)).toBeNull();
    expect(projectTabDropTarget(0, 2)).toBe(1);
    expect(projectTabDropTarget(0, 3)).toBe(2);
    expect(projectTabDropTarget(2, 0)).toBe(0);
    expect(projectTabDropTarget(2, 1)).toBe(1);
    expect(projectTabDropTarget(2, 2)).toBeNull();
    expect(projectTabDropTarget(2, 3)).toBeNull();
  });

  it("shows a ghost and accent insertion marker while dragging, and commits the new order on drop", () => {
    render(<WindowGroupTabs />);
    const tablist = screen.getByRole("tablist");
    const alpha = screen.getByRole("tab", { name: "Alpha" }).parentElement!;
    const gamma = screen.getByRole("tab", { name: "Gamma" }).parentElement!;

    hit = tablist;
    pointer(screen.getByRole("tab", { name: "Alpha" }), "pointerdown", 100);
    // Still within Alpha's own position: dimmed source + ghost, but no noisy insertion line.
    pointer(window, "pointermove", 120);
    expect(alpha).toHaveClass(styles.dragging!);
    expect(tablist).toHaveAttribute("data-dragging", "");
    expect(document.querySelector(`.${styles.dropBefore}, .${styles.dropAfter}`)).toBeNull();
    const ghostContext = document.body.lastElementChild as HTMLElement;
    expect(ghostContext.firstElementChild).toHaveAttribute("aria-hidden", "true");

    // Past Beta's midpoint: insertion line appears before Gamma.
    pointer(window, "pointermove", 350);
    expect(gamma).toHaveClass(styles.dropBefore!);
    expect(gamma).not.toHaveClass(styles.dropAfter!);

    // Past Gamma's midpoint: insertion line moves to the trailing edge of Gamma.
    pointer(window, "pointermove", 550);
    expect(gamma).not.toHaveClass(styles.dropBefore!);
    expect(gamma).toHaveClass(styles.dropAfter!);

    pointer(window, "pointerup", 550);
    // Swallows the click following pointerup so dragging never triggers a tab switch.
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction).toHaveBeenCalledWith("window.reorderTabs", ["b", "c", "a"]);
    expect(useWindowGroup.getState().tabs.map((t) => t.label)).toEqual(["b", "c", "a"]);
    expect(tablist).not.toHaveAttribute("data-dragging");
    expect(ghostContext.isConnected).toBe(false);
  });

  it("clears the marker when leaving the bar and cancels on Escape", () => {
    render(<WindowGroupTabs />);
    const tablist = screen.getByRole("tablist");
    const gamma = screen.getByRole("tab", { name: "Gamma" }).parentElement!;

    hit = tablist;
    pointer(screen.getByRole("tab", { name: "Alpha" }), "pointerdown", 100);
    pointer(window, "pointermove", 350);
    expect(gamma).toHaveClass(styles.dropBefore!);

    hit = null;
    pointer(window, "pointermove", 350, 200);
    expect(gamma).not.toHaveClass(styles.dropBefore!);

    hit = tablist;
    pointer(window, "pointermove", 350);
    expect(gamma).toHaveClass(styles.dropBefore!);
    fireEvent.keyDown(window, { key: "Escape" });
    pointer(window, "pointerup", 350);
    expect(executeAction).not.toHaveBeenCalled();
    expect(gamma).not.toHaveClass(styles.dropBefore!);
    expect(useWindowGroup.getState().tabs.map((t) => t.label)).toEqual(["a", "b", "c"]);
  });

  it("ignores reordered macOS taps and respects dragRequiresAlt", () => {
    render(<WindowGroupTabs />);
    const tablist = screen.getByRole("tablist");
    hit = tablist;

    pointer(screen.getByRole("tab", { name: "Alpha" }), "pointerdown", 100);
    pointer(window, "pointermove", 350, 15, { buttons: 0 });
    expect(tablist).not.toHaveAttribute("data-dragging");

    setDragRequiresAlt(() => true);
    pointer(screen.getByRole("tab", { name: "Alpha" }), "pointerdown", 100, 15, { altKey: false });
    pointer(window, "pointermove", 350, 15);
    expect(tablist).not.toHaveAttribute("data-dragging");

    pointer(screen.getByRole("tab", { name: "Alpha" }), "pointerdown", 100, 15, { altKey: true });
    pointer(window, "pointermove", 350, 15);
    expect(tablist).toHaveAttribute("data-dragging", "");
    pointer(window, "pointerup", 350, 15);
    expect(executeAction).toHaveBeenCalledWith("window.reorderTabs", ["b", "a", "c"]);
  });
});
