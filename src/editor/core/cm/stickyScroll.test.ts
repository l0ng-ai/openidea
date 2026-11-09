import { describe, expect, it } from "vitest";
import { selectedSpan } from "./stickyScroll";

describe("selectedSpan", () => {
  // the sticky line `def run():` at 100..110
  it("is null when no range covers the line", () => {
    expect(selectedSpan([{ from: 0, to: 50 }], 100, 110)).toBeNull();
    expect(selectedSpan([{ from: 105, to: 105 }], 100, 110)).toBeNull();
    // a selection that ends at the line's start selects nothing on it
    expect(selectedSpan([{ from: 40, to: 100 }], 100, 110)).toBeNull();
  });

  it("covers the whole line and runs past it for a selection through the line", () => {
    expect(selectedSpan([{ from: 0, to: 500 }], 100, 110)).toEqual({ start: 0, end: 10, pastEnd: true });
  });

  it("covers part of the line", () => {
    expect(selectedSpan([{ from: 104, to: 107 }], 100, 110)).toEqual({ start: 4, end: 7, pastEnd: false });
    expect(selectedSpan([{ from: 104, to: 300 }], 100, 110)).toEqual({ start: 4, end: 10, pastEnd: true });
    expect(selectedSpan([{ from: 20, to: 103 }], 100, 110)).toEqual({ start: 0, end: 3, pastEnd: false });
  });
});
