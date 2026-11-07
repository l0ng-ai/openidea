import { describe, expect, it } from "vitest";
import { formatPattern, formatTimestamp } from "@/platform/dateFormat";
import { resolveThemeId } from "@/workbench/theme";
import { applyAppearanceOptions, nextZoom, SMALL_TREE_INDENT } from "../appearanceRuntime";
import { validateSettings } from "../model/schema";
import { validateAppearanceExtras, validateNotifications } from "../model/behaviorSchema";

describe("appearance & behavior settings", () => {
  it("steps zoom within 50–300%", () => {
    expect(nextZoom(100, 1)).toBe(110);
    expect(nextZoom(100, -1)).toBe(90);
    expect(nextZoom(300, 1)).toBe(300);
    expect(nextZoom(50, -1)).toBe(50);
  });

  it("resolves Sync with OS to the preferred themes", () => {
    const a = { theme: "light", syncWithOs: true, preferredLightTheme: "light", preferredDarkTheme: "dark-hc" };
    expect(resolveThemeId(a, true)).toBe("light");
    expect(resolveThemeId(a, false)).toBe("dark-hc");
    expect(resolveThemeId({ theme: "system" }, false)).toBe("dark");
    expect(resolveThemeId({ theme: "dark" }, true)).toBe("dark");
    expect(validateAppearanceExtras({ theme: "system" }).syncWithOs).toBe(true);
  });

  it("keeps valid file icon theme options and drops or clamps the rest", () => {
    expect(validateAppearanceExtras({}).fileIconThemeOptions).toEqual({});
    const options = validateAppearanceExtras({
      fileIconThemeOptions: {
        "p/t": {
          groups: { tests: true, bad: "yes" },
          choices: { arrows: "plus", bad: 1 },
          hideFiles: true,
          hollowFolders: "x",
          hideUiIcons: true,
          hidePsiIcons: 1,
          monochrome: "#546E7A",
          saturation: 50,
          opacity: 1,
          iconSize: 20.4,
          rowHeight: 100,
          accent: "red",
        },
        "not a key": { hideFiles: true },
        "p/u": 5,
      },
    }).fileIconThemeOptions;
    expect(options).toEqual({
      "p/t": {
        groups: { tests: true },
        choices: { arrows: "plus" },
        hideFiles: true,
        hideFolders: false,
        hollowFolders: false,
        hideUiIcons: true,
        hidePsiIcons: false,
        monochrome: "#546E7A",
        saturation: 20,
        opacity: 10,
        iconSize: 20,
        rowHeight: 48,
        accent: null,
      },
    });
  });

  it("defaults Show tool window badges to on and honours the stored value", () => {
    expect(validateAppearanceExtras({}).showToolWindowBadges).toBe(true);
    expect(validateAppearanceExtras({ showToolWindowBadges: false }).showToolWindowBadges).toBe(false);
    expect(validateAppearanceExtras({ showToolWindowBadges: 1 }).showToolWindowBadges).toBe(true);
  });

  it("defaults Use smaller indents in trees to off and applies the indent variable", () => {
    expect(validateAppearanceExtras({}).smallTreeIndents).toBe(false);
    expect(validateAppearanceExtras({ smallTreeIndents: true }).smallTreeIndents).toBe(true);
    expect(validateAppearanceExtras({ smallTreeIndents: "on" }).smallTreeIndents).toBe(false);
    const root = document.createElement("div");
    applyAppearanceOptions(validateSettings({ appearance: { smallTreeIndents: true } }), root);
    expect(root.style.getPropertyValue("--tree-indent")).toBe(SMALL_TREE_INDENT);
    // Off (or a stored non-boolean) restores the default indents.
    applyAppearanceOptions(validateSettings({}), root);
    expect(root.style.getPropertyValue("--tree-indent")).toBe("");
    applyAppearanceOptions(validateSettings({ appearance: { smallTreeIndents: false } }), root);
    expect(root.style.getPropertyValue("--tree-indent")).toBe("");
  });

  it("keeps the UI fallback font empty by default and trims a stored one", () => {
    expect(validateAppearanceExtras({}).uiFontFallback).toBe("");
    expect(validateAppearanceExtras({ uiFontFallback: " 思源黑体 " }).uiFontFallback).toBe("思源黑体");
    expect(validateAppearanceExtras({ uiFontFallback: 5 }).uiFontFallback).toBe("");
  });

  it("applies and clears the UI fallback, and removes custom fonts when disabled", () => {
    const root = document.createElement("div");
    const settings = validateSettings({
      appearance: { useCustomFont: true, uiFontFamily: "Menlo", uiFontFallback: "Songti SC" },
    });
    applyAppearanceOptions(settings, root);
    expect(root.style.getPropertyValue("--font-ui")).toBe('"Menlo", "Songti SC", system-ui, sans-serif');
    settings.appearance.uiFontFallback = "";
    applyAppearanceOptions(settings, root);
    expect(root.style.getPropertyValue("--font-ui")).toBe('"Menlo", system-ui, sans-serif');
    settings.appearance.useCustomFont = false;
    applyAppearanceOptions(settings, root);
    expect(root.style.getPropertyValue("--font-ui")).toBe("");
  });

  it("formats dates with an override pattern and pretty dates", () => {
    const d = new Date(2026, 0, 5, 14, 7);
    expect(formatPattern(d, "dd.MM.yyyy")).toBe("05.01.2026");
    expect(formatPattern(d, "d MMM yy")).toBe("5 Jan 26");
    const o = { overrideSystem: true, pattern: "yyyy-MM-dd", use24Hour: false, pretty: false };
    expect(formatTimestamp(d.getTime(), d.getTime() + 1000, o)).toBe("2026-01-05 2:07 PM");
    expect(formatTimestamp(d.getTime(), d.getTime() + 5 * 60_000, { ...o, pretty: true })).toBe("5 min ago");
  });

  it("normalises notification groups", () => {
    expect(validateNotifications({ groups: { vcs: { display: "weird", log: false } }, sound: 1 })).toEqual({
      balloons: true,
      sound: false,
      groups: { vcs: { display: "balloon", log: false } },
    });
  });
});
