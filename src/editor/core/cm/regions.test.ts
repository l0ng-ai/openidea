import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { customRegions, regionMarker, regionNameAt } from "./regions";

describe("regionMarker", () => {
  it.each([
    ["//region Accessors", "Accessors"],
    ["  // region Accessors", "Accessors"],
    ["#region Setup", "Setup"],
    ["# region Setup", "Setup"],
    ["//#region Setup", "Setup"],
    ['// <editor-fold desc="Getters">', "Getters"],
    ['<!-- <editor-fold desc="Head"> -->', "Head"],
    ["/* region Block */", "Block"],
    ["//region", ""],
  ])("start %s", (line, name) => {
    expect(regionMarker(line)).toEqual({ start: true, name });
  });

  it.each(["//endregion", "# endregion", "#endregion", "// </editor-fold>", "<!-- </editor-fold> -->"])(
    "end %s",
    (line) => {
      expect(regionMarker(line)).toEqual({ start: false });
    },
  );

  it.each(["const region = 1;", "// the region below", "regions.push(x)"])("not a marker: %s", (line) => {
    expect(regionMarker(line)).toBeNull();
  });
});

describe("customRegions", () => {
  it("matches nested markers and drops unclosed ones", () => {
    const doc = Text.of(["//region A", "//region B", "x", "//endregion", "//endregion", "//region C"]);
    expect(customRegions(doc)).toEqual([
      { name: "A", startLine: 1, endLine: 5 },
      { name: "B", startLine: 2, endLine: 4 },
    ]);
  });
});

describe("regionNameAt", () => {
  it("names a fold starting at a start marker", () => {
    const state = EditorState.create({ doc: "  //region Fields\nint a;\n//endregion" });
    expect(regionNameAt(state, 2)).toBe("Fields");
    expect(regionNameAt(state, 5)).toBeNull();
  });
});
