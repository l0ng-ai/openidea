import { describe, expect, it } from "vitest";
import { matchesLine, matchingActions, type PlacedHoverAction } from "./hoverActions";

function action(line: number, endLine: number, label: string): PlacedHoverAction {
  return {
    plugin: "test",
    action: {
      line,
      startLine: line,
      endLine,
      icon: "run",
      label,
      tooltip: label,
      command: "run",
      argument: null,
    },
  };
}

describe("inline editor actions", () => {
  it("matches lines inside a method range including the declaration line", () => {
    const outer = action(5, 12, "outer");
    expect(matchesLine(outer.action, 5)).toBe(true);
    expect(matchesLine(outer.action, 9)).toBe(true);
    expect(matchesLine(outer.action, 12)).toBe(true);
    expect(matchesLine(outer.action, 4)).toBe(false);
    expect(matchesLine(outer.action, 13)).toBe(false);
  });

  it("prefers the innermost overlapping range", () => {
    const outer = action(5, 20, "outer");
    const inner = action(8, 10, "inner");
    expect(matchingActions([outer, inner], 9).map((a) => a.action.label)).toEqual(["inner"]);
    expect(matchingActions([outer, inner], 15).map((a) => a.action.label)).toEqual(["outer"]);
    expect(matchingActions([outer, inner], 30)).toEqual([]);
  });
});
