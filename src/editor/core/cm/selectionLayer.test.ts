import { describe, expect, it } from "vitest";
import { BlockType, RectangleMarker, type BlockInfo } from "@codemirror/view";
import {
  alignLeftEdges,
  dropInsetSlivers,
  cutOutGaps,
  fillGaps,
  fillRowEnds,
  growToLineBoxes,
  snapMarkers,
  textBlock,
  textBlocks,
  widenToRightEdge,
} from "./selectionLayer";

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
      [40, 0, 100, 20],
      [2, 20, 500, 20],
      [2, 40, 30, 20],
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

  it("keeps a single-row selection on its own row when glyphs are taller than the line height", () => {
    // 22px rows, 24px glyph box (e.g. 18px JetBrains Mono with default 22px line height):
    // top (258.12) sits in the row above (237..259) and bottom (281.88) in the row below (281..303).
    const rows22 = (y: number) => {
      const idx = Math.floor((y - 237) / 22);
      return { top: 237 + idx * 22, bottom: 237 + (idx + 1) * 22 };
    };
    const markers = [new RectangleMarker(C, 167, 258.12, 98, 23.76)];
    expect(growToLineBoxes(markers, C, rows22).map(box)).toEqual([[167, 259, 98, 22]]);
  });

  it("aligns multi-row selections without overlap or bleed when glyphs are taller than the line height", () => {
    // 20px rows, 24px glyph boxes (-2px half-leading on each side).
    const twoRows = [new RectangleMarker(C, 40, -2, 100, 24), new RectangleMarker(C, 2, 18, 30, 24)];
    expect(growToLineBoxes(twoRows, C, rows20).map(box)).toEqual([
      [40, 0, 100, 20],
      [2, 20, 30, 20],
    ]);

    const threeRows = [
      new RectangleMarker(C, 40, -2, 100, 24),
      new RectangleMarker(C, 2, 22, 500, 16),
      new RectangleMarker(C, 2, 38, 30, 24),
    ];
    expect(growToLineBoxes(threeRows, C, rows20).map(box)).toEqual([
      [40, 0, 100, 20],
      [2, 20, 500, 20],
      [2, 40, 30, 20],
    ]);
  });

  it("drops zero-width trailing sentinel markers without stretching onto the next row", () => {
    // Selecting a whole line ending at column 0 of the next row emits a 0-width marker on that next row.
    const markers = [new RectangleMarker(C, 2, 18, 500, 24), new RectangleMarker(C, 2, 38, 0, 24)];
    expect(growToLineBoxes(markers, C, rows20).map(box)).toEqual([[2, 20, 500, 20]]);
  });

  it("preserves widget boundaries when the selection starts or ends on a block widget", () => {
    // Widget at 0..30, text line at 30..50, text line at 50..70 (glyphs 52..68).
    const rows = (y: number) =>
      y < 30
        ? { top: 0, bottom: 30 }
        : rows20(y - 10) && {
            top: 30 + Math.floor((y - 30) / 20) * 20,
            bottom: 50 + Math.floor((y - 30) / 20) * 20,
          };
    const markers = [new RectangleMarker(C, 2, 30, 500, 22), new RectangleMarker(C, 2, 52, 30, 16)];
    expect(growToLineBoxes(markers, C, rows, { first: false, last: true }).map(box)).toEqual([
      [2, 30, 500, 20],
      [2, 50, 30, 20],
    ]);
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

describe("textBlock / textBlocks", () => {
  const block = (top: number, height: number, type: BlockInfo["type"], from = 0, to = 10) =>
    ({ from, to, top, height, bottom: top + height, type, length: to - from }) as unknown as BlockInfo;
  // A line with a code lens above it: one block whose type lists the widget, then the text.
  const lens = block(100, 14, BlockType.WidgetBefore, 20, 20);
  const text = block(114, 20, BlockType.Text, 20, 40);
  const line = block(100, 34, [lens, text], 20, 40);

  it("takes the text row out of a line that carries a block widget", () => {
    expect(textBlock(line, 120)).toBe(text);
    // A point over the lens still resolves to the line's text, not to the lens.
    expect(textBlock(line, 105)).toBe(text);
  });

  it("returns plain lines as they are", () => {
    const plain = block(0, 20, BlockType.Text);
    expect(textBlock(plain, 5)).toBe(plain);
  });

  it("lists the text rows of the visible lines, lenses left out", () => {
    const plain = block(0, 20, BlockType.Text, 0, 10);
    const widget = block(20, 30, BlockType.WidgetRange, 10, 12);
    expect(textBlocks([plain, widget, line])).toEqual([plain, text]);
  });
});

describe("cutOutGaps", () => {
  const C = "cm-selectionBackground";
  const box = (m: RectangleMarker) => [m.left, m.top, m.width, m.height];

  it("leaves the code lens above the line a selection ends at the start of unpainted", () => {
    // A selected line (0-20), then CodeMirror's rectangle down to the next line's text (20-34) over its lens.
    const markers = [new RectangleMarker(C, 0, 0, 300, 20), new RectangleMarker(C, 0, 20, 300, 14)];
    expect(cutOutGaps(markers, C, [{ top: 20, bottom: 34 }]).map(box)).toEqual([[0, 0, 300, 20]]);
  });

  it("splits a rectangle that runs across a lens into the rows above and below it", () => {
    const markers = [new RectangleMarker(C, 0, 0, 300, 60)];
    expect(cutOutGaps(markers, C, [{ top: 20, bottom: 34 }]).map(box)).toEqual([
      [0, 0, 300, 20],
      [0, 34, 300, 26],
    ]);
  });

  it("keeps rectangles away from any widget as they are", () => {
    const m = new RectangleMarker(C, 10, 40, 100, 20);
    expect(cutOutGaps([m], C, [{ top: 20, bottom: 34 }])[0]).toBe(m);
  });
});

describe("fillGaps", () => {
  const C = "cm-selectionBackground";
  const box = (m: RectangleMarker) => [m.left, m.top, m.width, m.height];

  it("paints a code lens the selection runs through whole, from the text's left to the right edge", () => {
    // Rows above and below the lens, with the lens (20-34) already cut out of CodeMirror's rectangles.
    const rows = [new RectangleMarker(C, 0, 0, 300, 20), new RectangleMarker(C, 0, 34, 60, 20)];
    expect(fillGaps(rows, C, [{ top: 20, bottom: 34 }], 0, 300).map(box)).toEqual([
      [0, 0, 300, 20],
      [0, 34, 60, 20],
      [0, 20, 300, 14],
    ]);
  });

  it("adds nothing without gaps", () => {
    const rows = [new RectangleMarker(C, 0, 0, 300, 20)];
    expect(fillGaps(rows, C, [], 0, 300)).toEqual(rows);
  });
});

describe("alignLeftEdges", () => {
  const C = "sel";
  it("moves rectangles at the real line start to the rounded one and keeps their right edges", () => {
    const out = alignLeftEdges(
      [new RectangleMarker(C, 40.5, 0, 100, 20), new RectangleMarker(C, 40, 20, 300, 20)],
      C,
      40.5,
      40,
    );
    expect(out.map((m) => [m.left, m.left + m.width!])).toEqual([
      [40, 140.5],
      [40, 340],
    ]);
  });

  it("leaves rectangles that start elsewhere, and everything when the inset is whole", () => {
    const m = new RectangleMarker(C, 80, 0, 50, 20);
    expect(alignLeftEdges([m], C, 40.5, 40)).toEqual([m]);
    const at = new RectangleMarker(C, 40, 0, 50, 20);
    expect(alignLeftEdges([at], C, 40, 40)).toEqual([at]);
  });
});

describe("dropInsetSlivers", () => {
  const C = "sel";
  it("drops rectangles covering only the inset before the text", () => {
    const row = new RectangleMarker(C, 40, 0, 300, 20);
    expect(dropInsetSlivers([row, new RectangleMarker(C, 40, 20, 0.5, 20)], 40, 40.5)).toEqual([row]);
  });

  it("leaves the middle rows whole when dropped after growing the rows", () => {
    // Rows of 20px; the selection runs from row 0 to the start of row 3, where CodeMirror draws a sliver.
    const rowAt = (y: number) => ({ top: Math.floor(y / 20) * 20, bottom: Math.floor(y / 20) * 20 + 20 });
    const drawn = [
      new RectangleMarker(C, 60, 2, 280, 16),
      new RectangleMarker(C, 40, 18, 300, 44),
      new RectangleMarker(C, 40, 62, 0.5, 16),
    ];
    const out = dropInsetSlivers(growToLineBoxes(drawn, C, rowAt), 40, 40.5);
    expect(out.map((m) => [m.top, m.top + m.height])).toEqual([
      [0, 20],
      [20, 60],
    ]);
  });

  it("keeps rectangles that reach into the text or start elsewhere", () => {
    const into = new RectangleMarker(C, 40, 0, 8, 20);
    const mid = new RectangleMarker(C, 80, 0, 0.5, 20);
    expect(dropInsetSlivers([into, mid], 40, 40.5)).toEqual([into, mid]);
  });
});
