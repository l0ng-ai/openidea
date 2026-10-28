import { describe, expect, it } from "vitest";
import { hoveredLine } from "./runToCursor";

describe("inlay Run to Cursor", () => {
  const line = { number: 3, text: "    foo()" };
  it("targets a non-blank line when hovering its first characters", () => {
    expect(hoveredLine(100, 8, 100, line)).toBe(2);
    expect(hoveredLine(100, 8, 132, line)).toBe(2);
  });
  it("ignores the pointer further right, left of the text, and blank lines", () => {
    expect(hoveredLine(100, 8, 133, line)).toBeNull();
    expect(hoveredLine(100, 8, 99, line)).toBeNull();
    expect(hoveredLine(100, 8, 104, { number: 4, text: "   " })).toBeNull();
  });
});
