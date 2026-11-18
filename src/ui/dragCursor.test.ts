import { afterEach, describe, expect, it } from "vitest";
import { lockDragCursor } from "./dragCursor";

const html = document.documentElement;

afterEach(() => {
  html.removeAttribute("data-drag-cursor");
  html.style.removeProperty("--drag-cursor");
});

describe("lockDragCursor", () => {
  it("holds the cursor until the drag ends", () => {
    const release = lockDragCursor("col-resize");
    expect(html.getAttribute("data-drag-cursor")).toBe("");
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("col-resize");

    release();
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("");
  });

  it("ignores a repeated release", () => {
    const release = lockDragCursor("row-resize");
    release();
    release();
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
  });

  it("restores an outer drag after a nested one ends", () => {
    const outer = lockDragCursor("col-resize");
    const inner = lockDragCursor("nwse-resize");
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("nwse-resize");

    inner();
    expect(html.getAttribute("data-drag-cursor")).toBe("");
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("col-resize");

    outer();
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
  });

  it("releases when the pointer goes up outside the handle", () => {
    lockDragCursor("col-resize");
    document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("");
  });
});
