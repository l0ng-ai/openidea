/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { contrastRatio, isColorValue, readTokens } from "../theme/contrast";
import { BUILTIN_THEMES } from "@/platform/themes";

const css = readFileSync(`${process.cwd()}/src/styles/tokens.css`, "utf8");
const dark = readTokens(css, ":root");
const light = { ...dark, ...readTokens(css, ':root[data-theme="light"]') };
const hc = { ...dark, ...readTokens(css, ':root[data-theme="dark-hc"]') };

const TEXT = ["--fg-strong", "--fg-emphasis", "--fg", "--fg-secondary", "--fg-muted", "--fg-subtle"];
const SURFACES = ["--bg-app", "--bg-elev", "--bg-popup"];
const SYNTAX = [
  "--syn-keyword",
  "--syn-string",
  "--syn-type",
  "--syn-function",
  "--syn-comment",
  "--syn-annotation",
  "--syn-number",
  "--syn-punct",
  "--syn-variable",
  "--syn-property",
  "--syn-constant",
  "--syn-invalid",
  "--syn-inline-value",
];
const STATUS = ["--danger", "--warning", "--success", "--info", "--accent", "--link"];
const VCS_TEXT = ["--vcs-modified", "--vcs-added", "--vcs-deleted", "--vcs-untracked", "--vcs-conflict"];
const NON_TEXT = [
  "--fg-faint",
  "--fg-gutter",
  "--vcs-ignored",
  "--gutter-modified",
  "--gutter-added",
  "--gutter-deleted",
];

type Tokens = Record<string, string>;

function failures(tokens: Tokens, fgs: string[], bgs: string[], min: number): string[] {
  const out: string[] = [];
  for (const fg of fgs)
    for (const bg of bgs) {
      const ratio = contrastRatio(tokens[fg]!, tokens[bg]!);
      if (ratio < min) out.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
  return out;
}

describe("theme tokens", () => {
  it("light theme redefines every colour token of :root", () => {
    const own = readTokens(css, ':root[data-theme="light"]');
    const colourTokens = Object.entries(dark)
      .filter(([, v]) => isColorValue(v) && !v.includes("var("))
      .map(([k]) => k);
    expect(colourTokens.length).toBeGreaterThan(50);
    expect(colourTokens.filter((k) => !(k in own))).toEqual([]);
  });

  it("high-contrast dark redefines every plain colour token", () => {
    const own = readTokens(css, ':root[data-theme="dark-hc"]');
    const missing = Object.entries(dark)
      .filter(([k, v]) => isColorValue(v) && !v.includes("var(") && !k.startsWith("--shadow"))
      .map(([k]) => k)
      .filter((k) => !(k in own));
    expect(missing).toEqual([]);
  });

  // Light values are PyCharm Islands Light's own. Its text-secondary grey, brand blue
  // and status colours are ~4.3:1 on the #f7f8f9 dialog surface, comments /
  // metadata / inlay text ~3.4:1, and line numbers / change bars are decorative
  // (~2:1); the thresholds pin those values rather than WCAG@@OPENIDEAS@@.
  const LIGHT_STRONG_SURFACES = ["--bg-app", "--bg-popup"];

  it("light text meets WCAG AA on the editor / popup surfaces", () => {
    expect(failures(light, TEXT, LIGHT_STRONG_SURFACES, 4.5)).toEqual([]);
    expect(failures(light, TEXT, ["--bg-elev"], 4.2)).toEqual([]);
    expect(
      failures(light, ["--fg", "--fg-secondary"], ["--bg-selected", "--bg-hover", "--bg-selected-strong"], 4),
    ).toEqual([]);
    expect(failures(light, ["--fg-muted"], ["--bg-selected", "--bg-hover"], 3.5)).toEqual([]);
  });

  it("light syntax colours stay readable on the editor and current line", () => {
    const soft = ["--syn-comment", "--syn-annotation", "--syn-inline-value", "--syn-invalid"];
    const main = SYNTAX.filter((t) => !soft.includes(t));
    expect(failures(light, main, ["--bg-app", "--bg-current-line", "--bg-elev"], 4.5)).toEqual([]);
    expect(failures(light, soft, ["--bg-app", "--bg-current-line", "--bg-elev"], 3)).toEqual([]);
  });

  it("light status / VCS colours are readable", () => {
    expect(failures(light, [...STATUS, ...VCS_TEXT], LIGHT_STRONG_SURFACES, 4.5)).toEqual([]);
    expect(failures(light, [...STATUS, ...VCS_TEXT], ["--bg-elev"], 4.2)).toEqual([]);
    expect(failures(light, VCS_TEXT, ["--bg-selected"], 3.5)).toEqual([]);
    expect(failures(light, NON_TEXT, ["--bg-app", "--bg-elev"], 1.8)).toEqual([]);
    expect(contrastRatio(light["--fg-on-accent"]!, light["--accent"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light["--fg-tooltip"]!, light["--bg-tooltip"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark theme primary text meets 4.5:1", () => {
    expect(failures(dark, ["--fg-strong", "--fg", "--fg-secondary", "--fg-muted"], SURFACES, 4.5)).toEqual([]);
  });

  it("high-contrast dark reaches 7:1 for text and 4.5:1 for everything readable", () => {
    expect(failures(hc, ["--fg-strong", "--fg-emphasis", "--fg", "--fg-secondary", "--fg-muted"], SURFACES, 7)).toEqual(
      [],
    );
    expect(failures(hc, ["--fg-subtle", "--fg-faint", ...SYNTAX, ...STATUS, ...VCS_TEXT], SURFACES, 4.5)).toEqual([]);
    expect(contrastRatio(hc["--fg-on-accent"]!, hc["--accent"]!)).toBeGreaterThanOrEqual(7);
  });

  it("parses rules with selector lists", () => {
    const t = readTokens("a, :root[x] { --a: #fff; /* c */ --b: 1px }", ":root[x]");
    expect(t).toEqual({ "--a": "#fff", "--b": "1px" });
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
  });
});

/**
 * Tokens the palette themes (Solarized, One) take from their light / dark base
 * on purpose: colours the user assigns (project and data source colours), the
 * platform's caption close and macOS window buttons, the tint strength, and
 * the selection foreground, whose base default preserves syntax colours.
 */
const INHERITED_FROM_BASE =
  /^--(project-color-|db-color-|caption-close-|fg-caption-close-|tint-strength$|fg-editor-selection$)/;

describe("palette themes", () => {
  const ISLANDS = ["light", "dark", "dark-hc"];
  const palettes = BUILTIN_THEMES.filter((t) => !ISLANDS.includes(t.id));
  const shared = readTokens(css, ":root[data-color-theme]");
  // Every themeable token (the Islands Light block lists them all) and every plain colour of :root.
  const required = [
    ...new Set([
      ...Object.keys(readTokens(css, ':root[data-theme="light"]')),
      ...Object.entries(dark)
        .filter(([, v]) => isColorValue(v) && !v.includes("var("))
        .map(([k]) => k),
    ]),
  ];

  it("have a tokens.css block for every palette theme id, and no other", () => {
    const blocks = [...css.matchAll(/:root\[data-color-theme="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
    expect([...new Set(blocks)].sort()).toEqual(palettes.map((t) => t.id).sort());
    expect(palettes.length).toBeGreaterThanOrEqual(2);
  });

  it.each(palettes)("$id defines every token or inherits it from its $kind base on purpose", ({ id, kind }) => {
    // A failure here means tokens.css gained a token: map it in the :root[data-color-theme]
    // block (or the theme's own), or add it to INHERITED_FROM_BASE if the base's value is right.
    const own = { ...shared, ...readTokens(css, `:root[data-color-theme="${id}"]`) };
    expect(required.length).toBeGreaterThan(200);
    expect(required.filter((k) => !(k in own) && !INHERITED_FROM_BASE.test(k))).toEqual([]);
    const base = kind === "light" ? light : dark;
    expect(required.filter((k) => INHERITED_FROM_BASE.test(k) && !(k in base))).toEqual([]);
    // Every palette role the shared mapping uses is set by the theme.
    const refs = Object.values(own)
      .join(" ")
      .matchAll(/var\((--palette-[a-z0-9-]+)/g);
    const roles = new Set([...refs].map((m) => m[1]!));
    expect([...roles].filter((r) => !(r in own))).toEqual([]);
    for (const t of ["--chart-series", "--bg-frame", "--fg-muted", "--accent", "--ansi-red", "--syn-keyword"])
      expect(own[t], `${id} ${t}`).toBeTruthy();
  });
});
