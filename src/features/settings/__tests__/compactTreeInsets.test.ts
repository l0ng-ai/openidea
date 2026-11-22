/// <reference types="node" />
/**
 * Compact mode must match JetBrains' Islands `*.compact` theme keys
 * (ManyIslandsDark.theme.json). In OpenIDEA the metrics live in two tokens.css
 * blocks: `:root` holds the normal value, `:root[data-compact]` the compact
 * override, and components read them through `var(--…, fallback)`. Swing `arc`
 * is a diameter, so the radii here are half of the theme's arc.
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

describe("compact combo box matches JetBrains ComboBox keys", () => {
  it("steps the radius 4px → 2px (Component.arc 8, ComboBox.arc.compact 4) and the label padding 9/6 → 6/6", () => {
    expect(normal["--radius-combo"]).toBe("4px");
    expect(compact["--radius-combo"]).toBe("2px");
    expect(normal["--combo-pad-start"]).toBe("9px");
    expect(normal["--combo-pad-end"]).toBe("6px");
    expect(compact["--combo-pad-start"]).toBe("6px");
    expect(compact["--combo-pad-end"]).toBe("6px");
  });
});

describe("compact editor tabs match JetBrains EditorTabs.tabInsets", () => {
  it("steps the tab pill's inline padding 8px → 6px", () => {
    expect(normal["--tab-pad-x"]).toBe("8px");
    expect(compact["--tab-pad-x"]).toBe("6px");
  });
});

describe("compact radii match JetBrains arc keys", () => {
  it("steps toolbar and stripe button radii 6px → 4px (MainToolbar.Button.arc, Button.ToolWindow.arc 12 → 8)", () => {
    expect(normal["--radius-toolbar-button"]).toBe("6px");
    expect(compact["--radius-toolbar-button"]).toBe("4px");
  });

  it("steps the control radius 4px → 3px (Component.arc 8 → 6)", () => {
    expect(normal["--radius-control"]).toBe("4px");
    expect(compact["--radius-control"]).toBe("3px");
  });
});
