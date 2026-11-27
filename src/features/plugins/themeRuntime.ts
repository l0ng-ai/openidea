/**
 * Editor-free plugin theme application and UI contribution projection, shared
 * between the workbench bridge and the Settings window.
 */
import type { ActiveTheme } from "@/bindings";
import { useI18n } from "@/platform/i18n";
import { useProducerNames } from "@/platform/inspections";
import { useProject } from "@/platform/project";
import {
  isThemeAvailable,
  parsePluginThemeRef,
  providePluginThemePreview,
  useContributedThemes,
} from "@/platform/themes";
import {
  applyThemeAttributes,
  currentThemeChoice,
  currentThemeId,
  subscribeScheme,
  syncWindowBackground,
  useThemeOverride,
  windowBackgroundHex,
} from "@/workbench/theme";
import { pluginsBackend } from "./backend";
import { loadPluginCatalogs, localizeContributions, usePluginCatalogs } from "./pluginText";
import { clearUiContributions, syncUiContributions } from "./projection";
import { selectPluginTheme, usePlugins } from "./store";

/** Keeps the projected UI contributions in line with the plugin list. */
export function syncPluginProjection(onPluginsChanged?: () => void): () => void {
  const apply = () => {
    const s = usePlugins.getState();
    syncUiContributions(localizeContributions(s.ui, usePluginCatalogs.getState().catalogs), s.plugins);
    // Their problems are listed by name in Settings › Inspections.
    useProducerNames.setState({
      names: new Map(
        s.plugins.flatMap((p): [string, string][] => [
          [`plugin:${p.id}`, p.name],
          [`plugin-provider:${p.id}`, p.name],
        ]),
      ),
    });
  };
  const loadCatalogs = () => void loadPluginCatalogs(usePlugins.getState().ui, useI18n.getState().locale);
  apply();
  loadCatalogs();
  const unsubscribe = [
    usePlugins.subscribe((s, prev) => {
      if (s.ui !== prev.ui) loadCatalogs();
      if (s.ui !== prev.ui || s.plugins !== prev.plugins) {
        onPluginsChanged?.();
        apply();
      }
    }),
    usePluginCatalogs.subscribe((s, prev) => s.catalogs !== prev.catalogs && apply()),
    useI18n.subscribe((s, prev) => s.locale !== prev.locale && loadCatalogs()),
  ];
  return () => {
    unsubscribe.forEach((u) => u());
    clearUiContributions();
  };
}

export const PLUGIN_THEME_STYLE_ID = "openidea-plugin-theme";

/** Stylesheet for a plugin theme. Its selector outranks every built-in theme block. */
export function pluginThemeCss(theme: ActiveTheme["theme"]): string {
  const kind = theme.kind === "light" ? "light" : "dark";
  const decls = [`  color-scheme: ${kind};`];
  for (const [name, value] of Object.entries(theme.tokens)) {
    // Backend validates; keep the guard so a malformed payload can't inject declarations.
    if (!/^--[a-z0-9-]+$/.test(name) || value == null || /[;{}<>\\]/.test(value)) continue;
    decls.push(`  ${name}: ${value};`);
  }
  return `:root[data-plugin-theme]:not([data-plugin-theme=""]) {\n${decls.join("\n")}\n}\n`;
}

/**
 * Applies a plugin theme (null restores the built-in one): its tokens as a
 * stylesheet over the built-in light or dark base named by its `kind`. A
 * stylesheet rather than inline styles, so the accent picked in Settings ›
 * Appearance and the editor colour scheme still layer on top.
 */
export function applyPluginTheme(theme: ActiveTheme | null, root: HTMLElement = document.documentElement) {
  const doc = root.ownerDocument;
  const current = doc.getElementById(PLUGIN_THEME_STYLE_ID);
  const id = theme && `${theme.pluginId}/${theme.theme.id}`;
  const css = theme && pluginThemeCss(theme.theme);
  // The same theme again (each window hears every selection): replacing its stylesheet restyles the page.
  if (theme && current?.textContent === css && root.dataset.pluginTheme === id) return;
  current?.remove();
  const had = root.dataset.pluginTheme !== undefined;
  if (!theme) {
    delete root.dataset.pluginTheme;
    delete root.dataset.pluginThemeKind;
    if (had) applyThemeAttributes(currentThemeId(), root);
  } else {
    const style = doc.createElement("style");
    style.id = PLUGIN_THEME_STYLE_ID;
    style.textContent = css;
    doc.head.appendChild(style);
    root.dataset.pluginTheme = id!;
    root.dataset.pluginThemeKind = theme.theme.kind === "light" ? "light" : "dark";
    applyThemeAttributes(currentThemeId(), root);
  }
  if (had || theme) syncWindowBackground();
}

/**
 * Quick Switch's theme preview of plugin themes: a live plugin's theme as it
 * contributes it, shown in this window only; nothing is selected or saved.
 */
export function providePluginThemePreviews(): () => void {
  return providePluginThemePreview((ref) => {
    const state = usePlugins.getState();
    if (ref === "selected") return applyPluginTheme(state.activeTheme);
    const want = ref ? parsePluginThemeRef(ref) : null;
    const item = want
      ? state.ui.find((c) => c.point === "themes" && c.pluginId === want.pluginId && c.key === want.themeId)
      : undefined;
    applyPluginTheme(item ? { pluginId: item.pluginId, theme: item.decl as ActiveTheme["theme"] } : null);
  });
}

/** localStorage key read by public/boot.js: the selected theme's stylesheet, applied before the app loads. */
export const PLUGIN_THEME_CACHE_KEY = "openidea.pluginTheme";

export interface CachedPluginTheme {
  /** `data-plugin-theme`: `<pluginId>/<themeId>`. */
  id: string;
  kind: "light" | "dark";
  css: string;
}

function cachePluginTheme(theme: ActiveTheme | null) {
  try {
    if (!theme) {
      localStorage.removeItem(PLUGIN_THEME_CACHE_KEY);
      return;
    }
    const cached: CachedPluginTheme = {
      id: `${theme.pluginId}/${theme.theme.id}`,
      kind: theme.theme.kind === "light" ? "light" : "dark",
      css: pluginThemeCss(theme.theme),
    };
    localStorage.setItem(PLUGIN_THEME_CACHE_KEY, JSON.stringify(cached));
  } catch {
    /* storage unavailable */
  }
}

let reportedFrame: string | undefined;

/**
 * Tells the backend the theme's resolved frame colour, which new windows open
 * in. Selecting a theme clears it there, so it is sent once per selection.
 */
function reportThemeFrame(theme: ActiveTheme | null) {
  const frame = theme ? windowBackgroundHex() : null;
  if (!theme || !frame) {
    reportedFrame = undefined;
    return;
  }
  const key = `${theme.pluginId}/${theme.theme.id}|${frame}`;
  if (key === reportedFrame) return;
  reportedFrame = key;
  void pluginsBackend()
    .setThemeFrame(frame)
    .catch(() => (reportedFrame = undefined));
}

/**
 * Applies the selected plugin theme and keeps it for the next start-up. Until
 * the first plugin list arrives, the theme public/boot.js restored stays.
 */
export function trackPluginTheme(): () => void {
  const sync = (s: ReturnType<typeof usePlugins.getState>) => {
    if (!s.activeTheme && (!s.loaded || s.error)) return;
    applyPluginTheme(s.activeTheme);
    cachePluginTheme(s.activeTheme);
    reportThemeFrame(s.activeTheme);
  };
  sync(usePlugins.getState());
  const unsubscribe = usePlugins.subscribe((s, prev) => {
    if (s.activeTheme !== prev.activeTheme || s.loaded !== prev.loaded) sync(s);
  });
  return () => {
    unsubscribe();
    applyPluginTheme(null);
  };
}

/**
 * Makes the plugin host's theme the one the Appearance settings select: a
 * plugin theme (`plugin:<id>/<theme>`, from any theme picker, the OS mode with
 * "Sync with OS", or the plugin's details page) is selected there once its
 * plugin is live; a built-in one clears it. While the selected plugin is off,
 * its built-in base shows and the selection is kept for when it is back.
 */
export function followThemeSetting(): () => void {
  let requested: string | undefined;
  const reconcile = () => {
    const plugins = usePlugins.getState();
    if (!plugins.loaded || plugins.error || !useProject.getState().settings?.appearance) return;
    const choice = currentThemeChoice();
    const want = parsePluginThemeRef(choice);
    const target = want && isThemeAvailable(choice) ? choice : null;
    const active = plugins.activeTheme;
    const current = active ? `plugin:${active.pluginId}/${active.theme.id}` : null;
    if (target === current || (want && !target && !current)) {
      requested = undefined;
      return;
    }
    // A selected plugin that is off: leave the host's selection for when it is back.
    if (want && !target) {
      if (requested === "") return;
      requested = "";
      void selectPluginTheme(null, null);
      return;
    }
    if (requested === (target ?? "")) return;
    requested = target ?? "";
    void selectPluginTheme(want && target ? want.pluginId : null, want && target ? want.themeId : null);
  };
  reconcile();
  const disposers = [
    // Not on the host's theme changing: another window selects it before this one's settings
    // say so, and selecting this window's choice back would flip it until they agree.
    usePlugins.subscribe((s, prev) => {
      if (s.loaded !== prev.loaded) reconcile();
    }),
    useProject.subscribe((s, prev) => {
      if (s.settings?.appearance !== prev.settings?.appearance) reconcile();
    }),
    useThemeOverride.subscribe(reconcile),
    useContributedThemes.subscribe(reconcile),
    subscribeScheme(reconcile),
  ];
  return () => disposers.forEach((d) => d());
}
