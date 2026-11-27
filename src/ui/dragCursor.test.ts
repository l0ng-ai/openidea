import { afterEach, describe, expect, it } from "vitest";
import { lockDragCursor } from "./dragCursor";

const surfaces = () => [...document.querySelectorAll<HTMLElement>("[data-drag-cursor-surface]")];
const cursors = () => surfaces().map((el) => el.style.cursor);

afterEach(() => document.dispatchEvent(new Event("pointercancel")));

describe("lockDragCursor", () => {
  it("holds the cursor until the drag ends", () => {
    const release = lockDragCursor("col-resize");
    expect(cursors()).toEqual(["col-resize"]);

    release();
    expect(cursors()).toEqual([]);
  });

  it("ignores a repeated release", () => {
    const release = lockDragCursor("row-resize");
    release();
    release();
    expect(cursors()).toEqual([]);
  });

  it("restores an outer drag after a nested one ends", () => {
    const outer = lockDragCursor("col-resize");
    const inner = lockDragCursor("nwse-resize");
    expect(cursors()).toEqual(["col-resize", "nwse-resize"]);

    inner();
    expect(cursors()).toEqual(["col-resize"]);

    outer();
    expect(cursors()).toEqual([]);
  });

  it("releases when the pointer goes up outside the handle", () => {
    lockDragCursor("col-resize");
    document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(cursors()).toEqual([]);
  });
});
