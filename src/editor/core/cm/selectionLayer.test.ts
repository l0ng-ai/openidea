import { describe, expect, it } from "vitest";
import { RectangleMarker } from "@codemirror/view";
import { fillRowEnds, growToLineBoxes, snapMarkers, widenToRightEdge } from "./selectionLayer";

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

describe("growToLineBoxes", () => {
  const C = "cm-selectionBackground";
  const box = (m: RectangleMarker) => [m.left, m.top, m.width, m.height];
  const rows20 = (y: number) => ({ top: Math.floor(y / 20) * 20, bottom: Math.floor(y / 20) * 20 + 20 });

  it("grows the first and last rows of a selection to their line boxes", () => {
    // 20px rows, 16px glyph boxes: CodeMirror leaves 2px above the first row and below the last.
    const markers = [
      new RectangleMarker(C, 40, 2, 100, 16), // first row
      new RectangleMarker(C, 2, 18, 500, 24), // rows in between
      new RectangleMarker(C, 2, 42, 30, 16), // last row
    ];
    expect(growToLineBoxes(markers, C, rows20).map(box)).toEqual([
      [40, 0, 100, 18],
      [2, 18, 500, 24],
      [2, 42, 30, 18],
    ]);
  });

  it("uses the line boxes when CodeMirror has already met two adjacent rows in the middle", () => {
    // two lines: CodeMirror stretches both to the 20px boundary, so the rectangles are 18px, not glyph-high
    const markers = [new RectangleMarker(C, 40, 2, 100, 18), new RectangleMarker(C, 2, 20, 30, 18)];
    expect(growToLineBoxes(markers, C, rows20).map(box)).toEqual([
      [40, 0, 100, 20],
      [2, 20, 30, 20],
    ]);
  });

  it("grows a single-row selection both ways", () => {
    expect(growToLineBoxes([new RectangleMarker(C, 40, 22, 60, 16)], C, rows20).map(box)).toEqual([[40, 20, 60, 20]]);
  });
});

describe("fillRowEnds", () => {
  const C = "cm-selectionBackground";
  const box = (m: RectangleMarker) => [m.left, m.top, m.width, m.height];

  it("fills a row the selection runs past from where its rectangles stop to the edge (a folded first line)", () => {
    const markers = [
      new RectangleMarker(C, 2, 0, 110, 20), // `import asyncio`, then the fold placeholder
      new RectangleMarker(C, 2, 20, 514, 40), // the rows below, already to the edge
    ];
    const rows = [
      { top: 0, bottom: 20 },
      { top: 20, bottom: 40 },
    ];
    expect(fillRowEnds(markers, C, rows, 516).map(box)).toEqual([
      [2, 0, 110, 20],
      [2, 20, 514, 40],
      [112, 0, 404, 20],
    ]);
  });

  it("does not count the rectangle below that only reaches into a row's leading", () => {
    // a folded first row, then CodeMirror's block for the rows below starting at its glyph bottom (18)
    const markers = [new RectangleMarker(C, 2, 0, 110, 20), new RectangleMarker(C, 2, 18, 514, 42)];
    expect(fillRowEnds(markers, C, [{ top: 0, bottom: 20 }], 516).map(box)).toEqual([
      [2, 0, 110, 20],
      [2, 18, 514, 42],
      [112, 0, 404, 20],
    ]);
  });

  it("matches the height of the row's own rectangle", () => {
    // CodeMirror's block for the rows below starts at 18, so this row's rectangle (and the fill) ends there
    const markers = [new RectangleMarker(C, 2, 0, 110, 18), new RectangleMarker(C, 2, 18, 514, 42)];
    expect(box(fillRowEnds(markers, C, [{ top: 0, bottom: 20 }], 516)[2]!)).toEqual([112, 0, 404, 18]);
  });

  it("leaves rows with no rectangle alone", () => {
    expect(fillRowEnds([], C, [{ top: 0, bottom: 20 }], 516)).toEqual([]);
  });
});
