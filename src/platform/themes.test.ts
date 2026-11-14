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
  themeGroups,
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
import { themeItems } from "@/workbench/quickSwitch";
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
  });

  it("keeps explicit editor schemes and per-scheme edits independent of UI palettes", () => {
    applyThemeAttributes("solarized-light");
    expect(schemeCss("solarized-dark", undefined)).toContain("--bg-editor: #002b36 !important");
    expect(schemeCss("theme-default", { "solarized-light": { keyword: { foreground: "#123456" } } })).toContain(
      "--syn-keyword: #123456 !important",
    );
    applyThemeAttributes("solarized-dark");
    expect(schemeCss("theme-default", { "solarized-light": { keyword: { foreground: "#123456" } } })).toBe("");
  });

  it("clears the palette for plugins and restores it when the plugin is removed", () => {
    const root = document.documentElement;
    applyThemeAttributes("solarized-dark", root);
    root.dataset.pluginThemeKind = "light";
    applyThemeAttributes("solarized-dark", root);
    expect(root.dataset.colorTheme).toBeUndefined();
    expect(root.dataset.theme).toBe("light");
    delete root.dataset.pluginThemeKind;
    applyThemeAttributes("solarized-dark", root);
    expect(root.dataset.colorTheme).toBe("solarized-dark");
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
    expect(themeSelectOptions(themeChoices(), ref).slice(-2)).toEqual([
      { value: "plugin:acme.night", label: "Acme", section: true },
      { value: ref, label: "Night" },
    ]);
    // Its tokens apply over the default of its kind.
    expect(resolveThemeId(a, false)).toBe("dark");

    remove();
    expect(isThemeAvailable(ref)).toBe(false);
    // Its plugin off: the base of the kind it had shows, and the pickers keep it listed.
    expect(resolveThemeId(a, false)).toBe("dark");
    expect(themeSelectOptions(themeChoices(), ref).slice(-2)).toMatchObject([
      { value: "plugin:acme.night", label: "acme.night", section: true },
      { value: ref, label: "night", detail: "Plugin not enabled" },
    ]);
    // Its plugin live but the theme gone (an update dropped it): listed under that plugin's heading.
    const stay = addContributedTheme({
      id: pluginThemeRef("acme.night", "dawn"),
      label: "Dawn",
      kind: "dark",
      origin: "Acme",
    });
    addContributedTheme({ id: pluginThemeRef("zeta.blue", "blue"), label: "Blue", kind: "dark", origin: "Zeta" });
    expect(
      themeSelectOptions(themeChoices(), ref)
        .slice(BUILTIN_THEMES.length)
        .map((o) => (o.section ? `[${o.label}]` : o.label)),
    ).toEqual(["[Acme]", "Dawn", "night", "[Zeta]", "Blue"]);
    stay();
  });

  it("are grouped by plugin: the built-in ones first, then each plugin's by name", () => {
    const theme = (plugin: string, id: string, label: string, origin: string) =>
      addContributedTheme({ id: pluginThemeRef(plugin, id), label, kind: "dark", origin });
    theme("intellij.dracula", "dracula", "Dracula", "Dracula Theme");
    theme("acme.night", "night", "Night", "Acme");
    theme("intellij.dracula", "alucard", "Dracula Alucard", "Dracula Theme");
    theme("acme.night", "dawn", "Dawn", "Acme");

    const groups = themeGroups();
    expect(groups.map((g) => [g.origin, g.themes.map((t) => t.label)])).toEqual([
      [undefined, BUILTIN_THEMES.map((t) => t.label)],
      ["Acme", ["Dawn", "Night"]],
      ["Dracula Theme", ["Dracula", "Dracula Alucard"]],
    ]);
    expect(themeChoices().map((t) => t.label)).toEqual(groups.flatMap((g) => g.themes.map((t) => t.label)));

    // Menus draw a line between the groups, as IDEA's Theme list.
    const items = themeItems("light");
    const lines = items.flatMap((item, i) => (item.kind === "separator" ? [i] : []));
    expect(lines).toEqual([BUILTIN_THEMES.length, BUILTIN_THEMES.length + 3]);
    expect(items.find((i) => i.kind !== "separator" && "checked" in i && i.checked)).toMatchObject({
      label: "Islands Light",
    });
    // Selects head each plugin's themes with its name.
    expect(
      themeSelectOptions(themeChoices())
        .slice(BUILTIN_THEMES.length)
        .map((o) => (o.section ? `[${o.label}]` : o.label)),
    ).toEqual(["[Acme]", "Dawn", "Night", "[Dracula Theme]", "Dracula", "Dracula Alucard"]);
  });

  it("parse only well-formed references", () => {
    expect(parsePluginThemeRef(ref)).toEqual({ pluginId: "acme.night", themeId: "night" });
    for (const bad of ["plugin:", "plugin:/night", "plugin:acme/", "acme/night", 3])
      expect(parsePluginThemeRef(bad)).toBeNull();
    expect(validateSettings({ appearance: { theme: "plugin:/x" } }).appearance.theme).toBe("light");
  });
});
