import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { dropIndex, revealHorizontally, revealVertically, TabStripRegistry, Tabs, type TabStripHandle } from "./Tabs";

describe("dropIndex", () => {
  it("finds the insertion index from tab midpoints", () => {
    const rects = [
      { left: 0, width: 100 },
      { left: 100, width: 50 },
    ];
    expect(dropIndex(10, rects)).toBe(0);
    expect(dropIndex(60, rects)).toBe(1);
    expect(dropIndex(130, rects)).toBe(2);
    expect(dropIndex(500, rects)).toBe(2);
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
