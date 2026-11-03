import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  addContributedTheme,
  BUILTIN_THEMES,
  isBuiltinTheme,
  isThemeAvailable,
  parsePluginThemeRef,
  pluginThemeRef,
  themeChoices,
  themeKind,
  useContributedThemes,
} from "./themes";
import { _setSchemeSource, effectiveScheme, schemeCss, schemeTokens, themeScheme } from "./colorScheme";
import {
  applyThemeAttributes,
  resolveTheme,
  resolveThemeChoice,
  resolveThemeId,
  themeSelectOptions,
} from "@/workbench/theme";
import { validateSettings } from "@/features/settings/model/schema";
import { applyPluginTheme } from "@/features/plugins/bridge";

const css = readFileSync("src/styles/tokens.css", "utf8");
_setSchemeSource(css);
afterEach(() => {
  applyPluginTheme(null);
  delete document.documentElement.dataset.colorTheme;
  delete document.documentElement.dataset.contrast;
});

describe("built-in palettes", () => {
  it.each(BUILTIN_THEMES)("preserves $id through validation and system resolution", ({ id, kind }) => {
    const a = { theme: id, preferredLightTheme: id, preferredDarkTheme: id };
    expect(validateSettings({ appearance: a }).appearance).toMatchObject(a);
    expect(resolveThemeId(a, false)).toBe(id);
    expect(resolveTheme(id, false)).toBe(kind);
    expect(resolveThemeId({ ...a, syncWithOs: true }, true)).toBe(id);
    expect(resolveThemeId({ ...a, theme: "system" }, false)).toBe(id);
    applyThemeAttributes(id);
    expect(document.documentElement.dataset.theme).toBe(kind);
    expect(themeScheme()).toBe(id);
    expect(effectiveScheme(id)).toBe(id);
    expect(schemeCss("theme-default", undefined)).toBe("");
    expect(schemeTokens(id).get("--bg-editor")).not.toContain("var(");
  });

  it("rejects unknown ids and retains legacy fallbacks", () => {
    expect(isBuiltinTheme("not-a-theme")).toBe(false);
    expect(resolveThemeId({ theme: "bad" }, true)).toBe("light");
    expect(resolveThemeId({ theme: "system", preferredDarkTheme: "bad" }, false)).toBe("dark");
    expect(themeKind("solarized-light")).toBe("light");
  });

  // Token coverage of every palette theme: settings/__tests__/contrast.test.ts.
  it("resolves editor scheme tokens from the palettes", () => {
    expect(schemeTokens("solarized-light").get("--bg-editor")).toBe("#fdf6e3");
    expect(schemeTokens("solarized-dark").get("--bg-editor")).toBe("#002b36");
    expect(schemeTokens("solarized-dark").get("--syn-string")).toBe("#2aa198");
    expect(schemeTokens("solarized-light").get("--ansi-bright-blue")).toBe("#839496");
    expect(schemeTokens("one-light").get("--syn-keyword")).toBe("hsl(301, 63%, 40%)");
    expect(schemeTokens("one-dark").get("--syn-string")).toBe("hsl(95, 38%, 62%)");
  });

  it("keeps explicit editor schemes and per-scheme edits independent of UI palettes", () => {
    applyThemeAttributes("solarized-light");
    expect(schemeCss("one-dark", undefined)).toContain("--bg-editor: hsl(220, 13%, 18%) !important");
    expect(schemeCss("theme-default", { "solarized-light": { keyword: { foreground: "#123456" } } })).toContain(
      "--syn-keyword: #123456 !important",
    );
    applyThemeAttributes("one-light");
    expect(schemeCss("theme-default", { "solarized-light": { keyword: { foreground: "#123456" } } })).toBe("");
  });

  it("clears the palette for plugins and restores it when the plugin is removed", () => {
    const root = document.documentElement;
    applyThemeAttributes("one-dark", root);
    root.dataset.pluginThemeKind = "light";
    applyThemeAttributes("one-dark", root);
    expect(root.dataset.colorTheme).toBeUndefined();
    expect(root.dataset.theme).toBe("light");
    delete root.dataset.pluginThemeKind;
    applyThemeAttributes("one-dark", root);
    expect(root.dataset.colorTheme).toBe("one-dark");
    applyThemeAttributes("dark-hc", root);
    expect(root.dataset.colorTheme).toBeUndefined();
    expect(root.dataset.contrast).toBe("high");
    applyThemeAttributes("solarized-dark", root);
    expect(root.dataset.contrast).toBeUndefined();
  });
});

describe("plugin themes", () => {
  const ref = pluginThemeRef("acme.night", "night");
  afterEach(() => {
    useContributedThemes.setState({ themes: [] });
    localStorage.removeItem("openidea.themeKinds");
  });

  it("are settings values like the built-in ones, in every picker while their plugin is live", () => {
    const a = { theme: ref, preferredLightTheme: "light", preferredDarkTheme: ref };
    expect(validateSettings({ appearance: a }).appearance).toMatchObject(a);
    expect(resolveThemeChoice(a, false)).toBe(ref);
    expect(resolveThemeChoice({ ...a, syncWithOs: true }, false)).toBe(ref);
    expect(resolveThemeChoice({ ...a, syncWithOs: true }, true)).toBe("light");

    const remove = addContributedTheme({ id: ref, label: "Night", kind: "dark", origin: "Acme" });
    expect(isThemeAvailable(ref)).toBe(true);
    expect(themeChoices().at(-1)).toMatchObject({ id: ref, label: "Night" });
    expect(themeSelectOptions(themeChoices(), ref).at(-1)).toEqual({ value: ref, label: "Night", detail: "Acme" });
    // Its tokens apply over the default of its kind.
    expect(resolveThemeId(a, false)).toBe("dark");

    remove();
    expect(isThemeAvailable(ref)).toBe(false);
    // Its plugin off: the base of the kind it had shows, and the pickers keep it listed.
    expect(resolveThemeId(a, false)).toBe("dark");
    expect(themeSelectOptions(themeChoices(), ref).at(-1)).toMatchObject({ value: ref, label: "night" });
  });

  it("parse only well-formed references", () => {
    expect(parsePluginThemeRef(ref)).toEqual({ pluginId: "acme.night", themeId: "night" });
    for (const bad of ["plugin:", "plugin:/night", "plugin:acme/", "acme/night", 3])
      expect(parsePluginThemeRef(bad)).toBeNull();
    expect(validateSettings({ appearance: { theme: "plugin:/x" } }).appearance.theme).toBe("light");
  });
});
