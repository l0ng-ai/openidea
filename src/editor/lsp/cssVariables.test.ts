import { afterEach, describe, expect, it, vi } from "vitest";
import type { CssVariable } from "@/platform/ipc";
import { cssVariableAt, cssVariablePrefix, swatchColor, variableHoverMarkdown, variableOptions } from "./cssVariables";

const at = (path: string, line: number) => ({
  path,
  range: { start: { line, col: 2 }, end: { line, col: 6 } },
  uri: null,
});
const v = (name: string, value: string | null, path: string, line = 0): CssVariable => ({
  name,
  value,
  location: at(path, line),
});

describe("var() completion context", () => {
  it("answers inside var( with the name typed so far", () => {
    expect(cssVariablePrefix(".a { color: var(")).toBe("");
    expect(cssVariablePrefix(".a { color: var( --ac")).toBe("--ac");
    expect(cssVariablePrefix("  margin: calc(var(-")).toBe("-");
    expect(cssVariablePrefix(".a { color: var(--a) ")).toBeNull();
    expect(cssVariablePrefix(".a { color: avar(")).toBeNull();
    expect(cssVariablePrefix(".a { color: re")).toBeNull();
  });

  it("finds the var(--name) under a column", () => {
    const line = "  border: 1px solid var(--line, red) var(--x);";
    expect(cssVariableAt(line, line.indexOf("--line") + 2)).toEqual({ name: "--line", from: 24, to: 30 });
    expect(cssVariableAt(line, line.indexOf("--x") + 3)?.name).toBe("--x");
    expect(cssVariableAt(line, 3)).toBeNull();
    expect(cssVariableAt("  --line: red;", 4)).toBeNull();
  });
});

describe("custom property options", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists each name once, the document's own declaration first and boosted", () => {
    vi.stubGlobal("CSS", { supports: (_p: string, value: string) => /^#|^rgb/.test(value) });
    const options = variableOptions(
      [
        v("--bg", "#fff", "/p/a.css"),
        v("--bg", "#000", "/p/theme/dark.css"),
        v("--gap", "4px 8px", "/p/theme/light.css"),
        v("--ring", "var(--bg)", "/p/theme/light.css"),
      ],
      "/p/a.css",
    );
    expect(options).toEqual([
      { label: "--bg", type: "variable", boost: 10, typeText: "#fff", swatch: "#fff" },
      { label: "--gap", type: "variable", boost: 0, typeText: "4px 8px" },
      { label: "--ring", type: "variable", boost: 0, typeText: "var(--bg)" },
    ]);
  });

  it("shows a swatch only for color values", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    expect(swatchColor("red !important")).toBe("red");
    expect(swatchColor("var(--bg)")).toBeNull();
    expect(swatchColor("inherit")).toBeNull();
    expect(swatchColor(null)).toBeNull();
    vi.stubGlobal("CSS", { supports: () => false });
    expect(swatchColor("4px")).toBeNull();
  });

  it("hovers every declaration of the name with its file", () => {
    const vars = [v("--bg", "#fff", "/p/theme/light.css", 1), v("--bg", "#000", "/p/theme/dark.css", 4)];
    expect(variableHoverMarkdown("--bg", vars)).toBe(
      "```css\n--bg: #fff; /* light.css:2 */\n--bg: #000; /* dark.css:5 */\n```",
    );
    expect(variableHoverMarkdown("--fg", vars)).toBeNull();
  });
});
