import { describe, expect, it } from "vitest";
import { findTextOccurrences } from "./occurrences";

describe("text occurrence boundaries", () => {
  it("preserves whole-word matching, whitespace normalization and adjacent matches", () => {
    const text = "ab + c $b+c b + cd b+c b + c";
    expect(findTextOccurrences(text, 0, text.length, "b + c")).toEqual([
      { from: 19, to: 22 },
      { from: 23, to: 28 },
    ]);
  });

  it("finds valid occurrences overlapping a rejected suffix match", () => {
    const text = "ab + b + b";
    expect(findTextOccurrences(text, 0, text.length, "b + b")).toEqual([{ from: 5, to: 10 }]);
  });

  it("advances through zero-length matches", () => {
    expect(findTextOccurrences("ab", 0, 2, "")).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 2 },
    ]);
  });

  it("keeps punctuation-led expressions and scope-relative boundaries", () => {
    expect(findTextOccurrences("x(a) x(a)", 0, 9, "(a)")).toEqual([
      { from: 1, to: 4 },
      { from: 6, to: 9 },
    ]);
    expect(findTextOccurrences("ab", 1, 2, "b")).toEqual([{ from: 1, to: 2 }]);
  });
});
