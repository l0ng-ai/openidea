import { describe, expect, it } from "vitest";
import { DEFAULT_FIND_OPTIONS, findInLines, MAX_MATCHES, type FindOptions } from "./find";

const lines = (...texts: string[]) => texts.map((text, i) => ({ id: i + 1, text }));
const opts = (extra: Partial<FindOptions> = {}): FindOptions => ({ ...DEFAULT_FIND_OPTIONS, ...extra });

describe("findInLines", () => {
  it("finds every occurrence on every line, ignoring case by default", () => {
    expect(findInLines(lines("alpha beta", "gamma Beta", "BETA again"), "beta", opts()).matches).toEqual([
      { line: 0, lineId: 1, start: 6, end: 10 },
      { line: 1, lineId: 2, start: 6, end: 10 },
      { line: 2, lineId: 3, start: 0, end: 4 },
    ]);
  });

  it("matches case only when asked", () => {
    expect(findInLines(lines("beta Beta BETA"), "Beta", opts({ caseSensitive: true })).matches).toEqual([
      { line: 0, lineId: 1, start: 5, end: 9 },
    ]);
  });

  it("keeps whole words only", () => {
    expect(findInLines(lines("cat concatenate cat."), "cat", opts({ wholeWord: true })).matches).toEqual([
      { line: 0, lineId: 1, start: 0, end: 3 },
      { line: 0, lineId: 1, start: 16, end: 19 },
    ]);
  });

  it("treats a literal query literally", () => {
    const matches = findInLines(lines("a.b axb a.b"), "a.b", opts()).matches;
    expect(matches.map((m) => m.start)).toEqual([0, 8]);
  });

  it("uses a regular expression when asked", () => {
    expect(findInLines(lines("beta betta b3ta"), "b.ta", opts({ regex: true })).matches).toHaveLength(2);
  });

  it("applies whole words to regular expression matches", () => {
    expect(findInLines(lines("cat concatenate cat"), "c.t", opts({ regex: true, wholeWord: true })).matches).toEqual([
      { line: 0, lineId: 1, start: 0, end: 3 },
      { line: 0, lineId: 1, start: 16, end: 19 },
    ]);
  });

  it("reports an invalid regular expression instead of throwing", () => {
    expect(findInLines(lines("anything"), "(", opts({ regex: true }))).toEqual({
      matches: [],
      overflow: false,
      invalid: true,
    });
  });

  it("skips empty regular expression matches", () => {
    expect(findInLines(lines("abc"), "x*", opts({ regex: true })).matches).toEqual([]);
  });

  it("caps the matches and reports the overflow", () => {
    const result = findInLines(lines("x x x x"), "x", opts(), 2);
    expect(result.matches).toHaveLength(2);
    expect(result.overflow).toBe(true);
  });

  it("has no overflow when the cap is exact", () => {
    expect(findInLines(lines("x x"), "x", opts(), 2)).toMatchObject({ overflow: false });
    expect(findInLines(lines("x x"), "x", opts(), MAX_MATCHES).matches).toHaveLength(2);
  });

  it("returns nothing for an empty query", () => {
    expect(findInLines(lines("a b"), " ", opts({ regex: false })).matches).toHaveLength(1);
    expect(findInLines(lines("text"), "", opts()).matches).toEqual([]);
  });
});
