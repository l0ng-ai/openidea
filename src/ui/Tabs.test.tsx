import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  dropIndex,
  revealHorizontally,
  revealVertically,
  TabStripRegistry,
  Tabs,
  type TabItem,
  type TabStripHandle,
  type TabsDnd,
} from "./Tabs";
import { setDragRequiresAlt } from "./pointerDrag";
import styles from "./Tabs.module.css";

describe("dropIndex", () => {
  it("finds the insertion index from tab midpoints", () => {
    const rects = [
      { left: 0, top: 0, width: 100, height: 24 },
      { left: 100, top: 0, width: 50, height: 24 },
    ];
    expect(dropIndex(10, 12, rects)).toBe(0);
    expect(dropIndex(60, 12, rects)).toBe(1);
    expect(dropIndex(130, 12, rects)).toBe(2);
    expect(dropIndex(500, 12, rects)).toBe(2);
    // Above or below the tabs still counts as their row.
    expect(dropIndex(60, -5, rects)).toBe(1);
    expect(dropIndex(60, 40, rects)).toBe(1);
    expect(dropIndex(10, 12, [])).toBe(0);
  });

  it("follows wrapped rows", () => {
    const rects = [
      { left: 0, top: 0, width: 100, height: 24 },
      { left: 100, top: 0, width: 100, height: 24 },
      { left: 0, top: 26, width: 100, height: 24 },
    ];
    expect(dropIndex(180, 12, rects)).toBe(2);
    expect(dropIndex(20, 30, rects)).toBe(2);
    expect(dropIndex(150, 30, rects)).toBe(3);
    expect(dropIndex(150, 25, rects)).toBe(2);
  });
});

describe("revealHorizontally", () => {
  const el = (left: number, right: number, scrollLeft = 0) =>
    ({ scrollLeft, getBoundingClientRect: () => ({ left, right }) }) as unknown as HTMLElement;

  it("scrolls right until the whole tab (incl. close button) is visible", () => {
    const scroller = el(0, 500, 100);
    revealHorizontally(scroller, el(400, 560));
    expect(scroller.scrollLeft).toBe(160);
  });
  it("scrolls left for a tab cut off on the left", () => {
    const scroller = el(0, 500, 300);
    revealHorizontally(scroller, el(-50, 100));
    expect(scroller.scrollLeft).toBe(250);
  });
  it("aligns the left edge of a tab wider than the strip", () => {
    const scroller = el(0, 300, 0);
    revealHorizontally(scroller, el(200, 700));
    expect(scroller.scrollLeft).toBe(200);
  });
  it("leaves a fully visible tab alone", () => {
    const scroller = el(0, 500, 40);
    revealHorizontally(scroller, el(100, 200));
    expect(scroller.scrollLeft).toBe(40);
  });
});

describe("revealVertically", () => {
  it("scrolls a column of tabs just enough to show the tab", () => {
    const el = (top: number, bottom: number, scrollTop = 0) =>
      ({ scrollTop, getBoundingClientRect: () => ({ top, bottom }) }) as unknown as HTMLElement;
    const scroller = el(0, 300, 50);
    revealVertically(scroller, el(290, 314));
    expect(scroller.scrollTop).toBe(64);
    revealVertically(scroller, el(-20, 4));
    expect(scroller.scrollTop).toBe(44);
  });
});

describe("Tabs interactions", () => {
  const items = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C", closable: false },
  ];

  it("Alt+click on a close button closes the other tabs", () => {
    const onClose = vi.fn();
    const onCloseOthers = vi.fn();
    render(<Tabs items={items} activeId="a" onSelect={() => {}} onClose={onClose} onCloseOthers={onCloseOthers} />);
    const close = screen.getAllByRole("button", { name: "Close Tab" })[1]!;
    fireEvent.click(close, { altKey: true });
    expect(onCloseOthers).toHaveBeenCalledWith("b");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith("b");
  });

  it("Shift+left-click closes an editor tab without selecting it", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<Tabs items={items} activeId="a" onSelect={onSelect} onClose={onClose} closeOnShiftClick />);
    fireEvent.click(screen.getByRole("tab", { name: "B" }), { shiftKey: true, detail: 1 });
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Shift+click only closes closable tabs", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<Tabs items={items} activeId="a" onSelect={onSelect} onClose={onClose} closeOnShiftClick />);
    fireEvent.click(screen.getByRole("tab", { name: "C" }), { shiftKey: true, detail: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("keeps Shift+click selection where the strip does not opt in", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<Tabs items={items} activeId="a" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "B" }), { shiftKey: true, detail: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("does not treat a keyboard click with Shift held as a close", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<Tabs items={items} activeId="a" onSelect={onSelect} onClose={onClose} closeOnShiftClick />);
    fireEvent.click(screen.getByRole("tab", { name: "B" }), { shiftKey: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("lets a container close the selected tab when it is closable", () => {
    const handles: TabStripHandle[] = [];
    const register = (h: TabStripHandle) => (handles.push(h), () => void handles.splice(handles.indexOf(h), 1));
    const onClose = vi.fn();
    const ui = (activeId: string) => (
      <TabStripRegistry.Provider value={register}>
        <Tabs items={items} activeId={activeId} onSelect={() => {}} onClose={onClose} />
      </TabStripRegistry.Provider>
    );
    const { rerender, unmount } = render(ui("b"));
    expect(handles[0]!.closeSelected()).toBe(true);
    expect(onClose).toHaveBeenCalledWith("b");
    rerender(ui("c"));
    expect(handles[0]!.closeSelected()).toBe(false);
    unmount();
    expect(handles).toHaveLength(0);
  });

  it("a vertical strip moves with ↑/↓, shows actions above the tabs and has no overflow dropdown", () => {
    const onSelect = vi.fn();
    render(
      <Tabs
        items={items}
        activeId="a"
        onSelect={onSelect}
        orientation="vertical"
        aria-label="Vertical"
        trailing={<button type="button">Actions</button>}
      />,
    );
    const list = screen.getByRole("tablist", { name: "Vertical" });
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    const [first] = screen.getAllByRole("tab");
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(first!, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    const actions = screen.getByRole("button", { name: "Actions" });
    expect(actions.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show Hidden Tabs" })).toBeNull();
  });
});

describe("Tabs drag & drop", () => {
  const TYPE = "application/x-test-tab";
  let hit: Element | null;
  beforeEach(() => {
    hit = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    // Tabs are 100px wide in display order (`order` while a drag previews a move).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const strip = this.parentElement;
      if (strip?.getAttribute("role") !== "tablist") return new DOMRect(0, 0, 1000, 600);
      const slot = this.style.order === "" ? [...strip.children].indexOf(this) : Number(this.style.order);
      return new DOMRect(slot * 100, 0, 100, 24);
    });
    setDragRequiresAlt(() => false);
  });
  afterEach(() => vi.restoreAllMocks());

  function Strip({ label, initial, onDrop }: { label: string; initial: string[]; onDrop?: TabsDnd["onDrop"] }) {
    const [ids, setIds] = useState(initial);
    const items: TabItem[] = ids.map((id) => ({ id, label: id }));
    const dnd: TabsDnd = {
      type: TYPE,
      payload: (id) => id,
      onDrop:
        onDrop ??
        ((id, index) =>
          setIds((list) => {
            const from = list.indexOf(id);
            const rest = list.filter((it) => it !== id);
            rest.splice(index > from ? index - 1 : index, 0, id);
            return rest;
          })),
    };
    return <Tabs aria-label={label} items={items} activeId={ids[0]!} onSelect={() => {}} dnd={dnd} />;
  }

  const strip = (label: string) => screen.getByRole("tablist", { name: label });
  const tab = (label: string, name: string) => within(strip(label)).getByRole("tab", { name }).parentElement!;
  // Labels in display order, the way the strip lays them out.
  const shown = (label: string) =>
    within(strip(label))
      .getAllByRole("tab")
      .map((b) => b.parentElement!)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((el) => el.textContent);
  const pointer = (el: Element | Window, type: string, x: number) =>
    fireEvent(
      el,
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: 12,
      }),
    );

  it("moves the other tabs out of the way while a tab is dragged, like IDEA (#1052)", () => {
    render(<Strip label="Terminal sessions" initial={["Local", "Local (2)", "Local (3)"]} />);
    const dragged = tab("Terminal sessions", "Local");
    pointer(within(dragged).getByRole("tab"), "pointerdown", 50);
    hit = strip("Terminal sessions");
    pointer(window, "pointermove", 60);
    expect(dragged).toHaveClass(styles.dragging!);
    const ghost = document.body.lastElementChild as HTMLElement;
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost.style.position).toBe("fixed");
    expect(shown("Terminal sessions")).toEqual(["Local", "Local (2)", "Local (3)"]);

    // Past the neighbour's midpoint the slot moves; it stays until the pointer crosses back.
    pointer(window, "pointermove", 160);
    expect(shown("Terminal sessions")).toEqual(["Local (2)", "Local", "Local (3)"]);
    pointer(window, "pointermove", 120);
    expect(shown("Terminal sessions")).toEqual(["Local (2)", "Local", "Local (3)"]);
    expect(document.querySelector(`.${styles.dropBefore}, .${styles.dropAfter}`)).toBeNull();

    pointer(window, "pointerup", 120);
    expect(shown("Terminal sessions")).toEqual(["Local (2)", "Local", "Local (3)"]);
    expect(
      within(strip("Terminal sessions"))
        .getAllByRole("tab")
        .map((b) => b.textContent),
    ).toEqual(["Local (2)", "Local", "Local (3)"]);
    expect(tab("Terminal sessions", "Local")).not.toHaveClass(styles.dragging!);
    expect(document.body.lastElementChild).not.toBe(ghost);
  });

  it("puts the slot back when the pointer leaves the strip and drops nothing on Escape", () => {
    const onDrop = vi.fn();
    render(<Strip label="Tabs" initial={["a", "b", "c"]} onDrop={onDrop} />);
    pointer(within(tab("Tabs", "a")).getByRole("tab"), "pointerdown", 50);
    hit = strip("Tabs");
    pointer(window, "pointermove", 260);
    expect(shown("Tabs")).toEqual(["b", "c", "a"]);
    hit = null;
    pointer(window, "pointermove", 260);
    expect(shown("Tabs")).toEqual(["a", "b", "c"]);
    hit = strip("Tabs");
    pointer(window, "pointermove", 260);
    fireEvent.keyDown(window, { key: "Escape" });
    pointer(window, "pointerup", 260);
    expect(onDrop).not.toHaveBeenCalled();
    expect(shown("Tabs")).toEqual(["a", "b", "c"]);
  });

  it("marks the insertion point for a tab dragged in from another strip", () => {
    const onDrop = vi.fn();
    render(
      <>
        <Strip label="Left" initial={["a", "b"]} />
        <Strip label="Right" initial={["c", "d"]} onDrop={onDrop} />
      </>,
    );
    pointer(within(tab("Left", "a")).getByRole("tab"), "pointerdown", 50);
    hit = strip("Right");
    pointer(window, "pointermove", 20);
    expect(tab("Right", "c")).toHaveClass(styles.dropBefore!);
    expect(shown("Right")).toEqual(["c", "d"]);
    expect(shown("Left")).toEqual(["a", "b"]);
    pointer(window, "pointermove", 180);
    expect(tab("Right", "d")).toHaveClass(styles.dropAfter!);
    pointer(window, "pointerup", 180);
    expect(onDrop).toHaveBeenCalledWith("a", 2);
  });
});
