import { describe, expect, it } from "vitest";
import { isOutsideWindow } from "./pointerDrag";

const viewport = { left: 0, top: 0, right: 1280, bottom: 800 };

describe("isOutsideWindow", () => {
  it("treats the viewport interior as inside (issue #454: drag a tab out)", () => {
    expect(isOutsideWindow(viewport, 640, 400)).toBe(false);
    expect(isOutsideWindow(viewport, 0, 0)).toBe(false);
    expect(isOutsideWindow(viewport, 1279, 799)).toBe(false);
  });

  it("treats every side of the viewport as outside", () => {
    expect(isOutsideWindow(viewport, -1, 400)).toBe(true);
    expect(isOutsideWindow(viewport, 1280, 400)).toBe(true);
    expect(isOutsideWindow(viewport, 640, -1)).toBe(true);
    expect(isOutsideWindow(viewport, 640, 800)).toBe(true);
  });
});
