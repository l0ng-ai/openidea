/** Applies `data-theme` and the accent colour from appearance settings. */
import { useEffect, useSyncExternalStore } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";

export type ThemeSetting = "dark" | "light" | "system" | "dark-hc";
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

function subscribeScheme(cb: () => void) {
  const m = media();
  m?.addEventListener?.("change", cb);
  return () => m?.removeEventListener?.("change", cb);
}

const prefersLight = () => !!media()?.matches;

interface AppearanceLike {
  theme?: string;
  syncWithOs?: boolean;
  preferredLightTheme?: string;
  preferredDarkTheme?: string;
}

/**
 * Concrete theme id: the chosen theme, or with "Sync with OS" (legacy
 * `theme = "system"`) the preferred light / dark theme for the OS mode.
 */
export function resolveThemeId(a: AppearanceLike | undefined, systemLight: boolean): "dark" | "light" | "dark-hc" {
  const concrete = (v: string | undefined, d: "dark" | "light") => (v === "dark" || v === "light" || v === "dark-hc" ? v : d);
  if (a?.syncWithOs || a?.theme === "system")
    return systemLight ? concrete(a?.preferredLightTheme, "light") : concrete(a?.preferredDarkTheme, "dark");
  return concrete(a?.theme, "light");
}

/** `dark-hc` resolves to `dark` plus `data-contrast="high"`. */
export function resolveTheme(setting: string | undefined, systemLight: boolean): "dark" | "light" {
  return resolveThemeId({ theme: setting }, systemLight) === "light" ? "light" : "dark";
}

const ACCENT_RE = /^#[0-9a-f]{3,8}$/i;

export function useApplyTheme() {
  const appearance = useProject((s) => s.settings?.appearance);
  const override = useThemeOverride((s) => s.theme);
  const systemLight = useSyncExternalStore(subscribeScheme, prefersLight, () => false);
  const id = override
    ? resolveThemeId({ theme: override }, systemLight)
    : resolveThemeId(appearance as AppearanceLike | undefined, systemLight);
  const theme = id === "light" ? "light" : "dark";
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
    try {
      localStorage.setItem("openidea.theme", JSON.stringify({ theme, contrast: root.dataset.contrast }));
    } catch {
      /* storage unavailable */
    }
    syncWindowBackground();
  }, [pending, theme, id, accent]);
}

/**
 * Sets `data-theme` / `data-contrast` for a built-in theme id. While a plugin
 * theme is active (`data-plugin-theme-kind`), its light / dark base wins.
 */
export function applyThemeAttributes(id: "dark" | "light" | "dark-hc", root: HTMLElement = document.documentElement) {
  const pluginKind = root.dataset.pluginThemeKind;
  if (pluginKind === "light" || pluginKind === "dark") {
    root.dataset.theme = pluginKind;
    delete root.dataset.contrast;
    return;
  }
  root.dataset.theme = id === "light" ? "light" : "dark";
  if (id === "dark-hc") root.dataset.contrast = "high";
  else delete root.dataset.contrast;
}

/**
 * Where a live resize outruns the page, the native window and the webview (WebView2's default
 * background) show their own colours; match both to the frame. The webview one is only set at
 * window creation otherwise, so a theme switched later left it light.
 */
export function syncWindowBackground() {
  if (!isTauri()) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bg-frame").trim();
  if (!color) return;
  getCurrentWebviewWindow()
    .setBackgroundColor(color)
    .catch(() => {});
}

export function currentTheme(): "dark" | "light" {
  return currentThemeId() === "light" ? "light" : "dark";
}

/** Themes offered by quick switch menus, in IDEA's order. */
export const THEME_CHOICES: ReadonlyArray<{ id: "light" | "dark" | "dark-hc"; label: string }> = [
  { id: "light", label: "Islands Light" },
  { id: "dark", label: "Islands Dark" },
  { id: "dark-hc", label: "High Contrast" },
];

/** The concrete theme in effect (`dark-hc` kept distinct). */
export function currentThemeId(): "dark" | "light" | "dark-hc" {
  const override = useThemeOverride.getState().theme;
  return override
    ? resolveThemeId({ theme: override }, prefersLight())
    : resolveThemeId(useProject.getState().settings?.appearance as AppearanceLike | undefined, prefersLight());
}

export async function setTheme(next: ThemeSetting) {
  useThemeOverride.setState({ theme: next });
  if (!isTauri()) return;
  try {
    let settings = await call(commands.settingsSet("global", "appearance.theme", JSON.stringify(next)));
    // An explicit choice ends "Sync with OS", as in IDEA.
    if (settings.appearance?.syncWithOs) settings = await call(commands.settingsSet("global", "appearance.syncWithOs", "false"));
    useProject.setState({ settings });
    useThemeOverride.setState({ theme: null });
  } catch {
    /* keep the session override */
  }
}

export async function toggleTheme() {
  await setTheme(currentTheme() === "dark" ? "light" : "dark");
}
