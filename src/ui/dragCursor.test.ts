import { afterEach, describe, expect, it } from "vitest";
import { lockDragCursor } from "./dragCursor";

const html = document.documentElement;

afterEach(() => {
  html.removeAttribute("data-drag-cursor");
  html.style.removeProperty("--drag-cursor");
});

describe("lockDragCursor", () => {
  it("holds the cursor until the drag ends", () => {
    const release = lockDragCursor("ew-resize");
    expect(html.getAttribute("data-drag-cursor")).toBe("");
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("ew-resize");

    release();
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("");
  });

  it("ignores a repeated release", () => {
    const release = lockDragCursor("ns-resize");
    release();
    release();
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
  });

  it("restores an outer drag after a nested one ends", () => {
    const outer = lockDragCursor("ew-resize");
    const inner = lockDragCursor("nwse-resize");
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("nwse-resize");

    inner();
    expect(html.getAttribute("data-drag-cursor")).toBe("");
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("ew-resize");

    outer();
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
  });

  it("releases when the pointer goes up outside the handle", () => {
    lockDragCursor("ew-resize");
    document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(html.hasAttribute("data-drag-cursor")).toBe(false);
    expect(html.style.getPropertyValue("--drag-cursor")).toBe("");
  });
});
