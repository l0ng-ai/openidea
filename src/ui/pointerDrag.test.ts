import { describe, expect, it } from "vitest";
import { dropZoneAt, isOutsideWindow } from "./pointerDrag";

const viewport = { left: 0, top: 0, right: 1280, bottom: 800 };

describe("dropZoneAt", () => {
  const rect = { left: 100, top: 100, width: 400, height: 200 };
  it("picks the nearest edge within its outer quarter, else the middle", () => {
    expect(dropZoneAt(300, 200, rect)).toBe("center");
    expect(dropZoneAt(110, 200, rect)).toBe("left");
    expect(dropZoneAt(490, 200, rect)).toBe("right");
    expect(dropZoneAt(300, 110, rect)).toBe("top");
    expect(dropZoneAt(300, 290, rect)).toBe("bottom");
  });
});

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
