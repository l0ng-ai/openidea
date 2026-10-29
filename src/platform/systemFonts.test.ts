import { describe, expect, it } from "vitest";
import { fontNames } from "./systemFonts";

const fonts = [
  { name: "menlo", monospaced: true },
  { name: "Arial", monospaced: false },
  { name: "Courier New", monospaced: true },
  { name: "Ångström Sans", monospaced: false },
];

describe("fontNames", () => {
  it("sorts installed families case- and accent-insensitively", () => {
    expect(fontNames(fonts)).toEqual(["Ångström Sans", "Arial", "Courier New", "menlo"]);
  });

  it("filters to monospaced families", () => {
    expect(fontNames(fonts, { monospacedOnly: true })).toEqual(["Courier New", "menlo"]);
  });

  it("always includes the extra names, spelled as given, without duplicates", () => {
    expect(fontNames(fonts, { monospacedOnly: true, include: ["JetBrains Mono", "Menlo", "Arial", " "] })).toEqual([
      "Arial",
      "Courier New",
      "JetBrains Mono",
      "Menlo",
    ]);
  });

  it("keeps the current family when nothing is installed", () => {
    expect(fontNames([], { include: ["Fira Code"] })).toEqual(["Fira Code"]);
  });
});
