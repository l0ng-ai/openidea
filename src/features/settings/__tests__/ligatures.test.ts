import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_EXTRA_DEFAULTS } from "@/platform/editorSettings";
import { applyLigatures } from "../appearanceRuntime";

const css = readFileSync("src/styles/global.css", "utf8");

describe("programming ligatures outside the editor (#2991)", () => {
  it("keeps them off by default for every mono preview", () => {
    expect(EDITOR_EXTRA_DEFAULTS.ligatures).toBe(false);
    expect(css.match(/:root\s*\{([^}]*)\}/)?.[1]).toMatch(/font-variant-ligatures:\s*none/);
    expect(css.match(/\.mono\s*\{([^}]*)\}/)?.[1]).not.toMatch(/font-variant-ligatures/);
  });

  it("turns them on with Enable ligatures", () => {
    expect(css.match(/:root\[data-ligatures\]\s*\{([^}]*)\}/)?.[1]).toMatch(/font-variant-ligatures:\s*normal/);
    const root = document.createElement("div");
    applyLigatures({ editor: { ligatures: true } }, root);
    expect(root.dataset.ligatures).toBe("");
    applyLigatures({ editor: { ligatures: false } }, root);
    expect(root.dataset.ligatures).toBeUndefined();
    applyLigatures({}, root);
    expect(root.dataset.ligatures).toBeUndefined();
  });
});
