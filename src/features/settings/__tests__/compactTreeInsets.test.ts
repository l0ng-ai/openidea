/// <reference types="node" />
/**
 * Compact mode must match JetBrains' Islands `Tree.border` insets: the normal
 * left/right padding is 12px and compact is 8px (ManyIslandsDark.theme.json
 * `Tree.border` "4,12,4,12" / `Tree.border.compact` "2,8,2,8"). In OpenIDEA
 * that padding is split into the island gap plus the tree inset, so both must
 * step 6→4 together.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readTokens } from "../theme/contrast";

const css = readFileSync(`${process.cwd()}/src/styles/tokens.css`, "utf8");
const normal = readTokens(css, ":root");
const compact = readTokens(css, ":root[data-compact]");

const px = (v: string | undefined) => Number.parseFloat(v ?? "");

describe("compact tree insets match JetBrains Tree.border", () => {
  it("steps the tree inset and island gap from 6px to 4px", () => {
    expect(normal["--tree-inset"]).toBe("6px");
    expect(compact["--tree-inset"]).toBe("4px");
    expect(normal["--island-gap"]).toBe("6px");
    expect(compact["--island-gap"]).toBe("4px");
  });

  it("adds up to JetBrains' 12px normal and 8px compact horizontal padding", () => {
    expect(px(normal["--island-gap"]) + px(normal["--tree-inset"])).toBe(12);
    expect(px(compact["--island-gap"]) + px(compact["--tree-inset"])).toBe(8);
  });
});
