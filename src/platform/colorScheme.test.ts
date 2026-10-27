import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { _setSchemeSource, schemeCss, schemeTokens } from "./colorScheme";
import { fontWeightVars, validateEditorExtras } from "./editorSettings";
import type { Settings } from "./ipc";
import { useProject } from "./project";
import { installColorScheme } from "@/editor/core/colorSchemeRuntime";

describe("color schemes", () => {
  beforeAll(() => _setSchemeSource(readFileSync("src/styles/tokens.css", "utf8")));
  it("reads resolved scheme tokens from tokens.css", () => {
    expect(schemeTokens("light").get("--syn-keyword")).toBe("#0033b3");
    expect(schemeTokens("dark").get("--syn-keyword")).toBe("#cf8e6d");
    expect(schemeTokens("light").get("--bg-editor")).not.toMatch(/var\(/);
  });

  it("emits scheme and override declarations", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    expect(schemeCss("theme-default", undefined, root)).toBe("");
    const dark = schemeCss("dark", undefined, root);
    expect(dark).toContain("--syn-keyword: #cf8e6d !important");
    const over = schemeCss("theme-default", { light: { keyword: { foreground: "#ff0000", bold: true } } }, root);
    expect(over).toContain("--syn-keyword: #ff0000 !important");
    // Explicit Bold / regular follow Typography Settings' bold / main weight.
    expect(over).toContain("--syn-keyword-bold: var(--fw-code-bold, 700) !important");
    const regular = schemeCss("theme-default", { light: { keyword: { bold: false } } }, root);
    expect(regular).toContain("--syn-keyword-bold: var(--fw-code, 400) !important");
    const upright = schemeCss("theme-default", { light: { staticSymbol: { italic: false } } }, root);
    expect(upright).toContain("--syn-static-italic: normal !important");
    const pythonItalic = schemeCss("theme-default", { light: { pyStaticSymbol: { italic: true } } }, root);
    expect(pythonItalic).toContain("--syn-python-static-italic: italic !important");
  });

  it("keeps editor weights out of the schemes", () => {
    for (const id of ["light", "dark", "dark-hc"] as const) {
      expect(schemeTokens(id).has("--fw-code")).toBe(false);
      expect(schemeTokens(id).has("--syn-keyword-bold")).toBe(false);
    }
    // Dark schemes bold matched braces with the configured bold weight, even under the light theme.
    expect(schemeTokens("dark").get("--matched-brace-weight")).toBe("var(--fw-code-bold)");
    expect(schemeTokens("light").get("--matched-brace-weight")).toBe("inherit");
    const root = document.documentElement;
    root.dataset.theme = "light";
    expect(schemeCss("dark", undefined, root)).toContain("--matched-brace-weight: var(--fw-code-bold) !important");
  });

  it("sets the configured weights on the root and follows settings changes", () => {
    const root = document.documentElement;
    useProject.setState({ settings: { editor: { fontWeight: 300, boldFontWeight: 800 } } as unknown as Settings });
    const dispose = installColorScheme();
    expect([root.style.getPropertyValue("--fw-code"), root.style.getPropertyValue("--fw-code-bold")]).toEqual(["300", "800"]);
    useProject.setState({ settings: { editor: {} } as unknown as Settings });
    expect([root.style.getPropertyValue("--fw-code"), root.style.getPropertyValue("--fw-code-bold")]).toEqual(["400", "700"]);
    dispose();
    expect(root.style.getPropertyValue("--fw-code")).toBe("");
  });

  it("validates Typography Settings weights", () => {
    const d = validateEditorExtras({});
    expect([d.fontWeight, d.boldFontWeight]).toEqual([400, 700]);
    const v = validateEditorExtras({ fontWeight: 349, boldFontWeight: 1200 });
    expect([v.fontWeight, v.boldFontWeight]).toEqual([350, 900]);
    expect(validateEditorExtras({ fontWeight: "bold" }).fontWeight).toBe(400);
    expect(fontWeightVars(500, undefined)).toEqual({ "--fw-code": "500", "--fw-code-bold": "700" });
    expect(fontWeightVars(450, 650)).toEqual({ "--fw-code": "450", "--fw-code-bold": "650" });
  });

  it("coerces editor settings to their defaults' shape", () => {
    const v = validateEditorExtras({ tabs: { tabLimit: "x", placement: "none" }, codeStyle: { languages: { go: { useTab: true } } } });
    expect(v.tabs.tabLimit).toBe(30);
    expect(v.tabs.placement).toBe("none");
    expect(v.codeStyle.languages.go).toEqual({ useTab: true });
    expect(v.general.softWrapFiles).toContain("*.md");
  });
});
