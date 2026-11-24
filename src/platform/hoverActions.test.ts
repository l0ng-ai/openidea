import { describe, expect, it } from "vitest";
import { hoverActionsAt, setHoverActions } from "./hoverActions";
import type { HoverAction } from "./ipc";

const action = (line: number, startLine: number, endLine: number, label: string): HoverAction => ({
  line,
  startLine,
  endLine,
  icon: "run",
  label,
  tooltip: label,
  command: "run",
  argument: null,
});

describe("hover action context-menu store", () => {
  it("lists the actions whose inclusive line range holds the caret", () => {
    setHoverActions(7, [
      { plugin: "p", action: action(0, 0, 2, "outer") },
      { plugin: "q", action: action(5, 4, 8, "inner") },
    ]);
    expect(hoverActionsAt(7, 1).map((e) => e.action.label)).toEqual(["outer"]);
    expect(hoverActionsAt(7, 6).map((e) => e.action.label)).toEqual(["inner"]);
    expect(hoverActionsAt(7, 9)).toEqual([]);
    setHoverActions(7, []);
    expect(hoverActionsAt(7, 1)).toEqual([]);
  });
});
