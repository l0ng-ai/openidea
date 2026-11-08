import { describe, expect, it } from "vitest";
import { RectangleMarker } from "@codemirror/view";
import { snapMarkers, widenToRightEdge } from "./selectionLayer";

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

describe("widenToRightEdge", () => {
  const C = "cm-selectionBackground";
  const box = (m: RectangleMarker) => [m.left, m.top, m.width, m.height];

  it("widens the rectangles that run past a line end to the editor's right edge", () => {
    const markers = [
      new RectangleMarker(C, 120, 0, 380, 18), // first line, from column 10 past its end
      new RectangleMarker(C, 2, 18, 498, 36), // the lines in between
    ];
    expect(widenToRightEdge(markers, C, 500, 16).map(box)).toEqual([
      [120, 0, 396, 18],
      [2, 18, 514, 36],
    ]);
  });

  it("keeps rectangles that end inside a line", () => {
    const markers = [new RectangleMarker(C, 2, 54, 40, 18), new RectangleMarker(C, 80, 0, 60, 18)];
    expect(widenToRightEdge(markers, C, 500, 16).map(box)).toEqual([
      [2, 54, 40, 18],
      [80, 0, 60, 18],
    ]);
  });
});
