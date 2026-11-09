import { describe, expect, it } from "vitest";
import { selectedSpans } from "./stickyScroll";

describe("selectedSpans", () => {
  // the sticky line `def run():` at 100..110
  it("is empty when no range covers the line", () => {
    expect(selectedSpans([{ from: 0, to: 50 }], 100, 110)).toEqual([]);
    expect(selectedSpans([{ from: 105, to: 105 }], 100, 110)).toEqual([]);
    // a selection that ends at the line's start selects nothing on it
    expect(selectedSpans([{ from: 40, to: 100 }], 100, 110)).toEqual([]);
  });

  it("covers the whole line and runs past it for a selection through the line", () => {
    expect(selectedSpans([{ from: 0, to: 500 }], 100, 110)).toEqual([{ start: 0, end: 10, pastEnd: true }]);
  });

  it("covers part of the line", () => {
    expect(selectedSpans([{ from: 104, to: 107 }], 100, 110)).toEqual([{ start: 4, end: 7, pastEnd: false }]);
    expect(selectedSpans([{ from: 104, to: 300 }], 100, 110)).toEqual([{ start: 4, end: 10, pastEnd: true }]);
    expect(selectedSpans([{ from: 20, to: 103 }], 100, 110)).toEqual([{ start: 0, end: 3, pastEnd: false }]);
  });
});

describe("disjoint sticky selections", () => {
  it("keeps gaps between selected occurrences", () => {
    expect(
      selectedSpans(
        [
          { from: 101, to: 103 },
          { from: 107, to: 109 },
        ],
        100,
        110,
      ),
    ).toEqual([
      { start: 1, end: 3, pastEnd: false },
      { start: 7, end: 9, pastEnd: false },
    ]);
  });
});
