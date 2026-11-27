/** Applies `data-theme` and the accent colour from appearance settings. */
import { useEffect, useSyncExternalStore } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  baseTheme,
  isBuiltinTheme,
  isThemeChoiceId,
  parsePluginThemeRef,
  previewPluginTheme,
  themeChoices,
  themeKind,
  useContributedThemes,
  type BuiltinThemeId,
  type ThemeChoice,
  type ThemeChoiceId,
} from "@/platform/themes";
import { resolveTokenColor, toHex } from "@/platform/cssColor";
import type { SelectOption } from "@/ui";

export type ThemeSetting = ThemeChoiceId | "system";
/** PyCharm's brand blue: the accent both Islands themes ship with. */
export const DEFAULT_ACCENT = "#3871e1";
/** Accent presets (Settings › Appearance, Welcome › Customize); the first is the Islands default. */
export const ACCENT_PRESETS = [
  { value: DEFAULT_ACCENT, label: "Blue" },
  { value: "#24a394", label: "Teal" },
  { value: "#955ae0", label: "Purple" },
  { value: "#e08855", label: "Orange" },
] as const;
/** Accents that mean "use the theme's own" (the current default and the pre-Islands one). */
const THEME_ACCENTS = new Set([DEFAULT_ACCENT, "#8fa5d6"]);

/** Session override used when settings can't be persisted (no backend). */
export const useThemeOverride = create<{ theme: ThemeSetting | null }>(() => ({ theme: null }));

const media = () =>
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

export function subscribeScheme(cb: () => void) {
  const m = media();
  m?.addEventListener?.("change", cb);
  return () => m?.removeEventListener?.("change", cb);
}

export const prefersLight = () => !!media()?.matches;

interface AppearanceLike {
  theme?: string;
  syncWithOs?: boolean;
  preferredLightTheme?: string;
  preferredDarkTheme?: string;
}

/**
 * The theme in effect as the settings name it: the chosen theme, or with
 * "Sync with OS" (legacy `theme = "system"`) the preferred light / dark theme
 * for the OS mode. A plugin theme (`plugin:<id>/<theme>`) is returned as is.
 */
export function resolveThemeChoice(a: AppearanceLike | undefined, systemLight: boolean): ThemeChoiceId {
  const concrete = (v: string | undefined, d: "dark" | "light") => (isThemeChoiceId(v) ? v : d);
  if (a?.syncWithOs || a?.theme === "system")
    return systemLight ? concrete(a?.preferredLightTheme, "light") : concrete(a?.preferredDarkTheme, "dark");
  return concrete(a?.theme, "light");
}

/**
 * Concrete built-in theme id: the one chosen, or the base of a chosen plugin
 * theme (its light / dark default, which also shows while its plugin is off).
 */
export function resolveThemeId(a: AppearanceLike | undefined, systemLight: boolean): BuiltinThemeId {
  const sync = !!(a?.syncWithOs || a?.theme === "system");
  return baseTheme(resolveThemeChoice(a, systemLight), sync && !systemLight ? "dark" : "light");
}

/** `dark-hc` resolves to `dark` plus `data-contrast="high"`. */
export function resolveTheme(setting: string | undefined, systemLight: boolean): "dark" | "light" {
  return themeKind(resolveThemeId({ theme: setting }, systemLight));
}

const ACCENT_RE = /^#[0-9a-f]{3,8}$/i;

export function useApplyTheme() {
  const appearance = useProject((s) => s.settings?.appearance);
  const override = useThemeOverride((s) => s.theme);
  const systemLight = useSyncExternalStore(subscribeScheme, prefersLight, () => false);
  // A plugin theme's kind is known once its plugin is live.
  useContributedThemes((s) => s.themes);
  const id = override
    ? resolveThemeId({ theme: override }, systemLight)
    : resolveThemeId(appearance as AppearanceLike | undefined, systemLight);
  const accent = appearance?.accent;

  // Until settings arrive, keep the theme public/boot.js restored rather than the light default.
  const pending = !override && !appearance;
  useEffect(() => {
    const root = document.documentElement;
    if (pending && root.dataset.theme) return;
    applyThemeAttributes(id, root);
    // Each theme ships its own accent; only a deliberate choice overrides it.
    const custom = !!accent && ACCENT_RE.test(accent) && !THEME_ACCENTS.has(accent.toLowerCase());
    if (custom) root.style.setProperty("--accent", accent);
    else root.style.removeProperty("--accent");
    syncWindowBackground();
  }, [pending, id, accent]);
}

/**
 * Sets `data-theme` / `data-contrast` / `data-color-theme` (the palette themes
 * over a light / dark base, tokens.css) for a built-in theme id. While a plugin
 * theme is active (`data-plugin-theme-kind`), its light / dark base wins.
 */
export function applyThemeAttributes(id: BuiltinThemeId, root: HTMLElement = document.documentElement) {
  const pluginKind = root.dataset.pluginThemeKind;
  if (pluginKind === "light" || pluginKind === "dark") {
    delete root.dataset.colorTheme;
    root.dataset.theme = pluginKind;
    delete root.dataset.contrast;
    return;
  }
  if (id === "light" || id === "dark" || id === "dark-hc") delete root.dataset.colorTheme;
  else root.dataset.colorTheme = id;
  root.dataset.theme = themeKind(id);
  if (id === "dark-hc") root.dataset.contrast = "high";
  else delete root.dataset.contrast;
}

/**
 * The frame colour as Tauri's `[r, g, b, a]` (0–255). Tauri parses neither
 * `hsl()` nor `color-mix()`, which themes may use, so it is resolved here.
 */
export function windowBackgroundColor(
  root: HTMLElement = document.documentElement,
): [number, number, number, number] | null {
  const c = resolveTokenColor("--bg-frame", root);
  if (!c) return null;
  const [r, g, b, a] = c;
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)];
}

/** The frame colour as `#rrggbb[aa]`, for native window commands that take a string. */
export function windowBackgroundHex(root: HTMLElement = document.documentElement): string | null {
  const c = resolveTokenColor("--bg-frame", root);
  return c ? toHex(c) : null;
}

/** localStorage key read by public/boot.js. */
export const STARTUP_THEME_KEY = "openidea.theme";

/**
 * Remembers the theme for public/boot.js, which applies it to the next window
 * before any stylesheet loads: the light / dark base, and the resolved frame,
 * text and accent colours its splash is painted in.
 */
export function rememberStartupTheme(root: HTMLElement = document.documentElement) {
  const hex = (name: string) => {
    const c = resolveTokenColor(name, root);
    return c ? toHex(c) : undefined;
  };
  try {
    localStorage.setItem(
      STARTUP_THEME_KEY,
      JSON.stringify({
        theme: root.dataset.theme,
        contrast: root.dataset.contrast,
        colorTheme: root.dataset.colorTheme,
        frame: hex("--bg-frame"),
        fg: hex("--fg-muted"),
        accent: hex("--accent"),
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

/**
 * Where a live resize outruns the page, the native window and the webview (WebView2's default
 * background) show their own colours; match both to the frame. The webview one is only set at
 * window creation otherwise, so a theme switched later left it light. Also remembers the theme
 * for the next window's start-up.
 */
export function syncWindowBackground() {
  if (!previewing) rememberStartupTheme();
  if (!isTauri()) return;
  const color = windowBackgroundColor();
  if (!color) return;
  getCurrentWebviewWindow()
    .setBackgroundColor(color)
    .catch(() => {});
}

export function currentTheme(): "dark" | "light" {
  return themeKind(currentThemeId());
}

/** Themes offered by the theme pickers and quick switch menus: built-in, then plugins'. */
export function useThemeChoices(): ThemeChoice[] {
  const contributed = useContributedThemes((s) => s.themes);
  return themeChoices(contributed);
}

/** The concrete built-in theme in effect (`dark-hc` kept distinct; a plugin theme's base). */
export function currentThemeId(): BuiltinThemeId {
  const override = useThemeOverride.getState().theme;
  return override
    ? resolveThemeId({ theme: override }, prefersLight())
    : resolveThemeId(useProject.getState().settings?.appearance as AppearanceLike | undefined, prefersLight());
}

/** The theme in effect as selected: built-in or a plugin's. */
export function currentThemeChoice(): ThemeChoiceId {
  const override = useThemeOverride.getState().theme;
  return override
    ? resolveThemeChoice({ theme: override }, prefersLight())
    : resolveThemeChoice(useProject.getState().settings?.appearance as AppearanceLike | undefined, prefersLight());
}

/** A previewed theme is not the next start-up's (`rememberStartupTheme`). */
let previewing = false;

export async function setTheme(next: ThemeSetting) {
  // A theme chosen while previewed is the next start-up's.
  previewing = false;
  useThemeOverride.setState({ theme: next });
  if (!isTauri()) return;
  try {
    let settings = await call(commands.settingsSet("global", "appearance.theme", JSON.stringify(next)));
    // An explicit choice ends "Sync with OS", as in IDEA.
    if (settings.appearance?.syncWithOs)
      settings = await call(commands.settingsSet("global", "appearance.syncWithOs", "false"));
    useProject.setState({ settings });
    useThemeOverride.setState({ theme: null });
  } catch {
    /* keep the session override */
  }
}

/**
 * Shows `id` in this window without selecting it (Quick Switch's instant
 * theme switch); `null` shows the selected theme again. Nothing is saved and
 * other windows keep theirs.
 */
export function previewTheme(id: ThemeChoiceId | null) {
  previewing = id !== null;
  if (id === null) {
    previewPluginTheme("selected");
    applyThemeAttributes(currentThemeId());
  } else if (isBuiltinTheme(id)) {
    previewPluginTheme(null);
    applyThemeAttributes(id);
  } else {
    previewPluginTheme(id);
  }
  syncWindowBackground();
}

export async function toggleTheme() {
  await setTheme(currentTheme() === "dark" ? "light" : "dark");
}

/** The plugin named beside a contributed theme, unless the theme carries its name already. */
export function originDetail(t: { label: string; origin?: string }): string | undefined {
  return t.origin && t.origin !== t.label ? t.origin : undefined;
}

/**
 * Options for a theme picker: built-in themes, then plugins' (with the plugin
 * named beside them). A selected plugin theme whose plugin is off stays listed.
 */
/** The themes for a picker: each plugin's under a heading with its name (`choices` in `themeGroups` order). */
export function themeSelectOptions(choices: readonly ThemeChoice[], selected?: string): SelectOption<ThemeChoiceId>[] {
  const options: SelectOption<ThemeChoiceId>[] = [];
  let group: string | undefined;
  for (const c of choices) {
    const pluginId = parsePluginThemeRef(c.id)?.pluginId;
    if (pluginId && pluginId !== group)
      options.push({ value: `plugin:${pluginId}`, label: c.origin ?? pluginId, section: true });
    group = pluginId;
    // Under its plugin's heading a theme needs no origin.
    options.push({ value: c.id, label: c.label });
  }
  const missing = parsePluginThemeRef(selected);
  if (missing && !options.some((o) => o.value === selected)) {
    // Under its own plugin's heading, not the last one listed.
    const option = { value: selected as ThemeChoiceId, label: missing.themeId, detail: "Plugin not enabled" };
    const heading = options.findIndex((o) => o.section && o.value === `plugin:${missing.pluginId}`);
    if (heading < 0)
      options.push({ value: `plugin:${missing.pluginId}`, label: missing.pluginId, section: true }, option);
    else {
      let end = heading + 1;
      while (end < options.length && !options[end]!.section) end++;
      options.splice(end, 0, option);
    }
  }
  return options;
}
