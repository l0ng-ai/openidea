import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ATTRIBUTES,
  CLEAR_COLOR,
  _setSchemeSource,
  resolvedAttribute,
  schemeAfterThemeChange,
  schemeCss,
  schemeTokens,
} from "./colorScheme";
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
    const dark = schemeTokens("dark");
    expect(dark.get("--syn-python-builtin")).toBe("#8888c6");
    expect(dark.get("--syn-python-predefined-definition")).toBe("#b200b2");
    expect(dark.get("--syn-python-predefined-usage")).toBe("#b200b2");
    expect(dark.get("--syn-python-instance-attribute")).toBe("#bcbec4");
    expect(dark.get("--syn-python-fstring")).toBe("#a5c261");
    expect(dark.get("--syn-python-bytes")).toBe("#a5c261");
  });

  it.each(["light", "dark"] as const)("inherits new doc tokens for older %s custom schemes", (parent) => {
    const customs = { "custom-old": { name: "Old", parent, attributes: {} } };
    for (const id of ["docCommentTag", "docCommentTagValue", "docCommentMarkup"])
      expect(resolvedAttribute("custom-old", id, customs)).toEqual(resolvedAttribute(parent, id));
  });

  it("gives PHP variables and function calls their own colours, as PhpStorm (#1532)", () => {
    expect(schemeTokens("dark").get("--syn-php-variable")).toBe("#c77dbb");
    expect(schemeTokens("dark").get("--syn-php-function-call")).toBe("#56a8f5");
    expect(schemeTokens("light").get("--syn-php-variable")).toBe("#871094");
    expect(schemeTokens("light").get("--syn-php-function-call")).toBe("#00627a");
    const css = readFileSync("src/styles/tokens.css", "utf8");
    expect(css).toMatch(/\.cm-editor\[data-language="PHP"\] \{\s*--syn-variable: var\(--syn-php-variable\);/);
    // An imported PHP_VAR still wins: language overrides are emitted for the same element, !important.
    const imported = schemeCss(
      "theme-default",
      { dark: { "php.identifier": { foreground: "#48d8ee" } } },
      document.documentElement,
    );
    expect(imported).toMatch(/\.cm-editor\[data-language="PHP"\] \{\n {2}--syn-variable: #48d8ee !important;/);
  });

  it("offers a Go scheme page and scopes its overrides to Go editors", () => {
    expect(ATTRIBUTES.find((a) => a.id === "go.constant")?.path).toEqual(["Go"]);
    const css = schemeCss("dark", { dark: { "go.constant": { foreground: "#224466" } } });
    expect(css).toContain('.cm-editor[data-language="Go"]');
    expect(css).toContain("--syn-constant: #224466 !important");
  });

  it("resolves scheme attribute state and editor defaults", () => {
    expect(resolvedAttribute("light", "lineComment")).toMatchObject({
      foreground: "#8c8c8c",
      italic: true,
    });
    expect(resolvedAttribute("dark", "lineComment")).toMatchObject({
      foreground: "#7a7e85",
      italic: false,
    });
    expect(resolvedAttribute("dark", "mdHeading")).toMatchObject({ bold: true });

    const customs = {
      "custom-test": {
        name: "Test",
        parent: "dark" as const,
        attributes: {
          todo: { foreground: "#139839", background: "#101010", bold: true, italic: false, effect: "wave" as const },
        },
      },
    };
    expect(resolvedAttribute("custom-test", "todo", customs)).toMatchObject({
      foreground: "#139839",
      background: "#101010",
      bold: true,
      italic: false,
      effect: "wave",
    });
  });

  it("resolves package references from the editor foreground and emits their overrides", () => {
    for (const theme of ["light", "dark", "dark-hc"] as const) {
      expect(resolvedAttribute(theme, "packageReference").foreground).toBe(schemeTokens(theme).get("--fg-editor"));
    }
    const css = schemeCss("dark", { dark: { packageReference: { foreground: "#446688", italic: true } } });
    expect(css).toContain("--syn-namespace: #446688 !important");
    expect(css).toContain("--syn-namespace-italic: italic !important");
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
    const cleared = schemeCss("theme-default", { light: { keyword: { background: CLEAR_COLOR } } }, root);
    expect(cleared).toContain("--syn-keyword-bg: transparent !important");
    const upright = schemeCss("theme-default", { light: { staticSymbol: { italic: false } } }, root);
    expect(upright).toContain("--syn-static-italic: normal !important");
    const pythonItalic = schemeCss("theme-default", { light: { pyStaticSymbol: { italic: true } } }, root);
    expect(pythonItalic).toContain("--syn-python-static-italic: italic !important");
  });

  it("applies an explicit scheme over a plugin theme of the same base", () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    root.dataset.pluginTheme = "theme-one/one-dark";
    try {
      // "Theme default" keeps the plugin theme's own editor colours.
      expect(schemeCss("theme-default", undefined, root)).toBe("");
      expect(schemeCss("dark", undefined, root)).toContain("--syn-keyword: #cf8e6d !important");
      delete root.dataset.pluginTheme;
      expect(schemeCss("dark", undefined, root)).toBe("");
    } finally {
      delete root.dataset.pluginTheme;
    }
  });

  it("re-applies the scheme when a plugin theme of the same base is selected", async () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    const previous = useProject.getState().settings;
    useProject.setState({ settings: { editor: { colorScheme: "dark" } } as unknown as Settings });
    const dispose = installColorScheme();
    const sheet = () => document.getElementById("openidea-editor-color-scheme")?.textContent ?? "";
    try {
      expect(sheet()).toBe("");
      root.dataset.pluginTheme = "theme-one/one-dark";
      await Promise.resolve();
      expect(sheet()).toContain("--syn-keyword: #cf8e6d !important");
    } finally {
      dispose();
      delete root.dataset.pluginTheme;
      useProject.setState({ settings: previous });
    }
  });

  it("switches a chosen scheme of the other kind back to the theme's own when the theme turns light or dark", async () => {
    expect(schemeAfterThemeChange("one-dark", "light")).toBe("theme-default");
    expect(schemeAfterThemeChange("solarized-light", "light")).toBeNull();
    expect(schemeAfterThemeChange("theme-default", "light")).toBeNull();
    const customs = { "custom-night": { name: "Night", parent: "dark" as const, attributes: {} } };
    expect(schemeAfterThemeChange("custom-night", "light", customs)).toBe("theme-default");
    expect(schemeAfterThemeChange("custom-night", "dark", customs)).toBeNull();

    const root = document.documentElement;
    root.dataset.theme = "dark";
    const previous = useProject.getState().settings;
    const scheme = () => useProject.getState().settings?.editor?.colorScheme;
    useProject.setState({ settings: { editor: { colorScheme: "one-dark" } } as unknown as Settings });
    const dispose = installColorScheme();
    try {
      root.dataset.theme = "light";
      await Promise.resolve();
      expect(scheme()).toBe("theme-default");
      // A dark scheme chosen under the light theme stays until the theme changes again.
      useProject.setState({ settings: { editor: { colorScheme: "dark" } } as unknown as Settings });
      root.dataset.colorTheme = "solarized-light";
      await Promise.resolve();
      expect(scheme()).toBe("dark");
      root.dataset.theme = "dark";
      await Promise.resolve();
      expect(scheme()).toBe("dark");
      // A scheme chosen in the same change as the theme (one Apply) goes with it.
      await new Promise((r) => setTimeout(r));
      useProject.setState({ settings: { editor: { colorScheme: "solarized-dark" } } as unknown as Settings });
      root.dataset.theme = "light";
      await Promise.resolve();
      expect(scheme()).toBe("solarized-dark");
      // A later theme change on its own still switches it back.
      await new Promise((r) => setTimeout(r));
      root.dataset.theme = "dark";
      await Promise.resolve();
      root.dataset.theme = "light";
      await Promise.resolve();
      expect(scheme()).toBe("theme-default");
    } finally {
      dispose();
      delete root.dataset.colorTheme;
      useProject.setState({ settings: previous });
    }
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
    expect([root.style.getPropertyValue("--fw-code"), root.style.getPropertyValue("--fw-code-bold")]).toEqual([
      "300",
      "800",
    ]);
    useProject.setState({ settings: { editor: {} } as unknown as Settings });
    expect([root.style.getPropertyValue("--fw-code"), root.style.getPropertyValue("--fw-code-bold")]).toEqual([
      "400",
      "700",
    ]);
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
    const v = validateEditorExtras({
      tabs: { tabLimit: "x", placement: "none" },
      codeStyle: { languages: { go: { useTab: true } } },
    });
    expect(v.tabs.tabLimit).toBe(30);
    expect(v.tabs.placement).toBe("none");
    expect(v.codeStyle.languages.go).toEqual({ useTab: true });
    expect(v.general.softWrapFiles).toContain("*.md");
  });
});
