import { describe, expect, it } from "vitest";
import { iclsColor } from "./iclsColor";

describe("iclsColor", () => {
  it("reads values the way IntelliJ's scheme reader does", () => {
    const cases: Array<[string | null | undefined, string | undefined]> = [
      ["a9b7c6", "#a9b7c6"],
      ["#A9B7C6", "#a9b7c6"],
      ["0xa9b7c6", "#a9b7c6"],
      [" #a9b7c6 ", "#a9b7c6"],
      ["a9b7c680", "#a9b7c680"],
      ["#a9b7c680", "#a9b7c680"],
      // Short values are a number with its leading zeros dropped.
      ["0", "#000000"],
      ["ff", "#0000ff"],
      ["abc", "#000abc"],
      // IntelliJ reads neither of these as a colour.
      ["#abc", undefined],
      ["#ff", undefined],
      ["1234567", undefined],
      ["red", undefined],
      ["", undefined],
      [null, undefined],
      [undefined, undefined],
    ];
    expect(cases.map(([v]) => iclsColor(v))).toEqual(cases.map(([, c]) => c));
  });
});
