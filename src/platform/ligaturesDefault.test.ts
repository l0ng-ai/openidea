import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_EXTRA_DEFAULTS } from "./editorSettings";

const css = readFileSync("src/styles/global.css", "utf8");

describe("programming ligatures default (#2991)", () => {
  it("keeps editor.ligatures off by default", () => {
    expect(EDITOR_EXTRA_DEFAULTS.ligatures).toBe(false);
  });

  it("disables ligatures app-wide so mono previews match that default", () => {
    const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(root).toMatch(/font-variant-ligatures:\s*none/);
  });
});
