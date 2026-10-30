import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Tree, type TreeReorder } from "./Tree";
import { setDragRequiresAlt } from "./pointerDrag";

interface Node {
  id: string;
  children?: Node[];
}

let hit: Element | null;
beforeEach(() => {
  hit = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = Number(this.dataset.row ?? 0) * 24;
    return new DOMRect(0, top, 400, this.dataset.row === undefined ? 600 : 24);
  });
  setDragRequiresAlt(() => false);
});
afterEach(() => {
  vi.restoreAllMocks();
  setDragRequiresAlt(() => false);
});

function Harness({ enabled = true }: { enabled?: boolean }) {
  const [roots, setRoots] = useState<Node[]>([
    { id: "group", children: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    { id: "other", children: [{ id: "d" }] },
  ]);
  const [activated, setActivated] = useState("");
  const reorder: TreeReorder<Node> = {
    canMove: (source, target) => !source.children && !target.children,
    move: (source, target, position) =>
      setRoots((list) =>
        list.map((group) => {
          if (!group.children?.some((n) => n.id === source.id)) return group;
          const children = group.children.filter((n) => n.id !== source.id);
          children.splice(children.findIndex((n) => n.id === target.id) + (position === "after" ? 1 : 0), 0, source);
          return { ...group, children };
        }),
      ),
  };
  return (
    <>
      <Tree
        roots={roots}
        getKey={(n) => n.id}
        getLabel={(n) => n.id}
        getChildren={(n) => n.children}
        isExpandable={(n) => !!n.children}
        defaultExpanded={["group", "other"]}
        rowClassName={(n) => (n.id === "b" ? "custom-row" : undefined)}
        reorder={enabled ? reorder : undefined}
        onActivate={(n) => setActivated(n.id)}
        aria-label="Reorder"
      />
      <output>{activated}</output>
    </>
  );
}

const row = (name: string, tree = screen.getByRole("tree")) => within(tree).getByRole("treeitem", { name });
const labels = () =>
  within(screen.getByRole("tree"))
    .getAllByRole("treeitem")
    .map((el) => el.textContent);
const pointer = (el: Element | Window, type: string, y: number, altKey = false) =>
  fireEvent(el, new MouseEvent(type, { bubbles: true, button: 0, clientX: 30, clientY: y, altKey }));
function drag(source: HTMLElement, target: HTMLElement, after = false, alt = false) {
  pointer(source, "pointerdown", source.getBoundingClientRect().top + 12, alt);
  hit = target;
  const y = target.getBoundingClientRect().top + (after ? 20 : 2);
  pointer(window, "pointermove", y, alt);
  pointer(window, "pointerup", y, alt);
}

describe("Tree pointer reordering", () => {
  it("moves a sibling before or after its target, preserving its selected identity", () => {
    render(<Harness />);
    fireEvent.mouseDown(row("b"));
    drag(row("b"), row("a"));
    expect(labels()).toEqual(["group", "b", "a", "c", "other", "d"]);
    expect(row("b")).toHaveAttribute("aria-selected", "true");
    expect(row("b")).toHaveClass("custom-row");
    drag(row("b"), row("c"), true);
    expect(labels()).toEqual(["group", "a", "c", "b", "other", "d"]);
  });

  it("does not reorder across parents or when the feature is absent", () => {
    const { rerender } = render(<Harness />);
    drag(row("a"), row("d"));
    expect(labels()).toEqual(["group", "a", "b", "c", "other", "d"]);
    rerender(<Harness enabled={false} />);
    drag(row("b"), row("a"));
    expect(labels()).toEqual(["group", "a", "b", "c", "other", "d"]);
  });

  it("cancels with Escape or pointercancel and never activates after a drag", () => {
    render(<Harness />);
    for (const cancel of ["Escape", "pointercancel"]) {
      pointer(row("b"), "pointerdown", 60);
      hit = row("a");
      pointer(window, "pointermove", 26);
      if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else pointer(window, "pointercancel", 26);
      pointer(window, "pointerup", 26);
      expect(labels()).toEqual(["group", "a", "b", "c", "other", "d"]);
    }
    drag(row("b"), row("a"));
    fireEvent.doubleClick(row("b"));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("honors Alt-only dragging and cleans up when unmounted mid-drag", () => {
    setDragRequiresAlt(() => true);
    const { unmount } = render(<Harness />);
    drag(row("b"), row("a"));
    expect(labels()).toEqual(["group", "a", "b", "c", "other", "d"]);
    drag(row("b"), row("a"), false, true);
    expect(labels()).toEqual(["group", "b", "a", "c", "other", "d"]);
    pointer(row("b"), "pointerdown", 36, true);
    hit = row("c");
    pointer(window, "pointermove", 74, true);
    unmount();
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
    hit = null;
    pointer(window, "pointerup", 74, true);
  });

  it("registers the current container after empty states and async loading", () => {
    const move = vi.fn();
    const props = {
      getKey: (n: Node) => n.id,
      getLabel: (n: Node) => n.id,
      getChildren: (n: Node) => n.children,
      isExpandable: () => false,
      empty: "Nothing",
      reorder: { canMove: () => true, move },
    };
    const { rerender } = render(<Tree {...props} roots={[]} />);
    for (let i = 0; i < 2; i++) {
      rerender(<Tree {...props} roots={[{ id: "a" }, { id: "b" }]} />);
      drag(row("b"), row("a"));
      expect(move).toHaveBeenCalledTimes(i + 1);
      rerender(<Tree {...props} roots={[]} />);
    }
  });

  it("scrolls at the edge and stops scrolling when cancelled", () => {
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => {
      frame = fn;
      return 1;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    render(<Harness />);
    const tree = screen.getByRole("tree");
    Object.defineProperties(tree, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 600 },
    });
    pointer(row("b"), "pointerdown", 60);
    hit = row("c");
    pointer(window, "pointermove", 590);
    act(() => frame?.(0));
    expect(tree.scrollTop).toBe(8);
    act(() => frame?.(16));
    expect(tree.scrollTop).toBe(16);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).toHaveBeenCalledWith(1);
    act(() => frame?.(32));
    expect(tree.scrollTop).toBe(16);
  });

  it("does not accept a drag from another tree with matching keys", () => {
    render(
      <>
        <Harness />
        <Harness />
      </>,
    );
    const trees = screen.getAllByRole("tree");
    drag(row("b", trees[0]!), row("a", trees[1]!));
    expect(
      within(trees[0]!)
        .getAllByRole("treeitem")
        .map((el) => el.textContent),
    ).toEqual(["group", "a", "b", "c", "other", "d"]);
    expect(
      within(trees[1]!)
        .getAllByRole("treeitem")
        .map((el) => el.textContent),
    ).toEqual(["group", "a", "b", "c", "other", "d"]);
  });
});
