import { describe, expect, it } from "vitest";
import { RectangleMarker } from "@codemirror/view";
import { snapMarkers } from "./selectionLayer";

describe("snapMarkers", () => {
  it("makes stacked selection rectangles share their edge exactly", () => {
    // Middle piece's bottom (top + height) and the last line's top differ by float error around x.25.
    const middle = new RectangleMarker("cm-selectionBackground", 6, 26.249999999, 500, 22.000000002);
    const last = new RectangleMarker("cm-selectionBackground", 6, 48.25, 40, 22);
    const [a, b] = snapMarkers([middle, last], "cm-selectionBackground", 2) as [RectangleMarker, RectangleMarker];
    expect(a.top + a.height).toBe(b.top);
  });

  it("snaps edges to device pixels and keeps horizontal geometry", () => {
    const m = snapMarkers([new RectangleMarker("x", 6.3, 10.3, 100, 21.9)], "x", 2)[0]!;
    expect(m.top).toBe(10.5);
    expect(m.top + m.height).toBe(32);
    expect(m.left).toBe(6.3);
    expect(m.width).toBe(100);
  });
});
