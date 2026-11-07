/**
 * Glue between backend plugins and the workbench: UI contributions are
 * projected (`projection.ts` + `points.tsx`), status items, tasks and event
 * subscriptions of running code go through `runtimeUi.tsx`, the selected
 * theme becomes a stylesheet of CSS
 * variables, notifications become balloons, consent requests open the
 * permission dialog, and opened files fire `on-language` / `on-file`.
 */
import type { ActiveTheme, PluginEvent, PluginUpdate } from "@/bindings";
import { useEditorRegistry } from "@/editor/api";
import { refreshLanguageInfos } from "@/editor/core/cm/languages";
import { notifications } from "@/workbench/contributions";
import { useI18n } from "@/platform/i18n";
import { useProducerNames } from "@/platform/inspections";
import { languageListChanged } from "@/platform/languageList";
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
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { pluginsBackend } from "./backend";
import { trackIconTheme } from "./iconThemes";
import { defineBuiltinUiPoints } from "./points";
import { localizeContributions, loadPluginCatalogs, usePluginCatalogs } from "./pluginText";
import { clearUiContributions, syncUiContributions } from "./projection";
import { handleRuntimeEvent, refreshEventKinds, startRuntimeUi } from "./runtimeUi";
import { grantPlugin, refreshPlugins, selectPluginTheme, updateAllPlugins, usePlugins } from "./store";

export { pluginActionId } from "./points";

/** Keeps the projected UI contributions in line with the plugin list. */
export function syncProjection(): () => void {
  const apply = () => {
    const s = usePlugins.getState();
    syncUiContributions(localizeContributions(s.ui, usePluginCatalogs.getState().catalogs), s.plugins);
    // Their problems are listed by name in Settings › Inspections.
    useProducerNames.setState({ names: new Map(s.plugins.map((p) => [`plugin:${p.id}`, p.name])) });
  };
  const loadCatalogs = () => void loadPluginCatalogs(usePlugins.getState().ui, useI18n.getState().locale);
  apply();
  loadCatalogs();
  const unsubscribe = [
    usePlugins.subscribe((s, prev) => {
      if (s.ui !== prev.ui) loadCatalogs();
      if (s.ui !== prev.ui || s.plugins !== prev.plugins) apply();
    }),
    usePluginCatalogs.subscribe((s, prev) => s.catalogs !== prev.catalogs && apply()),
    useI18n.subscribe((s, prev) => s.locale !== prev.locale && loadCatalogs()),
  ];
  return () => {
    unsubscribe.forEach((u) => u());
    clearUiContributions();
  };
}

// --- theme ------------------------------------------------------------------

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
  doc.getElementById(PLUGIN_THEME_STYLE_ID)?.remove();
  const had = root.dataset.pluginTheme !== undefined;
  if (!theme) {
    delete root.dataset.pluginTheme;
    delete root.dataset.pluginThemeKind;
    if (had) applyThemeAttributes(currentThemeId(), root);
  } else {
    const style = doc.createElement("style");
    style.id = PLUGIN_THEME_STYLE_ID;
    style.textContent = pluginThemeCss(theme.theme);
    doc.head.appendChild(style);
    root.dataset.pluginTheme = `${theme.pluginId}/${theme.theme.id}`;
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
    usePlugins.subscribe((s, prev) => {
      if (s.loaded !== prev.loaded || s.activeTheme !== prev.activeTheme) reconcile();
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

/** Reports the focused editor's file to the backend (`editor-focused` events). */
function trackActiveFile(): () => void {
  let last: string | null | undefined;
  const report = (path: string | null) => {
    if (path === last) return;
    last = path;
    void pluginsBackend()
      .setActiveFile(path)
      .catch(() => {});
  };
  report(useEditorRegistry.getState().active?.ctx.path ?? null);
  return useEditorRegistry.subscribe((s) => report(s.active?.ctx.path ?? null));
}

// --- events -----------------------------------------------------------------

function announceUpdates(updates: readonly PluginUpdate[]) {
  const names = updates.map((u) => `${u.name} ${u.version}`).join(", ");
  notifications().notify({
    group: "plugins",
    level: "info",
    title: updates.length === 1 ? "Plugin update available" : `${updates.length} plugin updates available`,
    body: names,
    actions: [
      { label: "Update All", run: () => void updateAllPlugins() },
      { label: "Show Plugins", run: () => void executeAction("plugins.settings") },
    ],
  });
}

export function handlePluginEvent(e: PluginEvent) {
  switch (e.type) {
    case "commandsChanged":
      scheduleRefresh();
      break;
    case "updatesAvailable":
      announceUpdates(e.updates);
      break;
    case "notification": {
      const name = usePlugins.getState().plugins.find((p) => p.id === e.pluginId)?.name ?? e.pluginId;
      notifications().notify({
        group: "plugins",
        level: e.level,
        title: e.title || name,
        body: e.body || undefined,
        verbatim: true,
      });
      break;
    }
    case "themeChanged":
      usePlugins.setState({ activeTheme: e.theme });
      break;
    case "consentRequested":
      void refreshPlugins().then(() => grantPlugin(e.pluginId, e.capabilities));
      break;
    case "languagesChanged":
      void refreshLanguageInfos();
      languageListChanged();
      break;
    default:
      handleRuntimeEvent(e);
  }
}

/**
 * For windows that only show plugins (Settings): stays in line with what
 * changes elsewhere — installs, enable / disable, the theme, languages —
 * while notifications and permission prompts stay with the project windows.
 */
export function followPluginChanges(): () => void {
  return pluginsBackend().onEvent((e) => {
    if (e.type === "commandsChanged" || e.type === "themeChanged" || e.type === "languagesChanged")
      handlePluginEvent(e);
  });
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshPlugins();
    refreshEventKinds();
  }, 30);
}

/**
 * Fires `on-language:<id>` and `on-file:<project-relative path>` for files
 * opened in the editor; the backend activates the plugins waiting for them.
 */
function trackActivationEvents(): () => void {
  const seenLanguages = new Set<string>();
  const report = (ctx: { path: string | null; language: string } | undefined) => {
    if (!ctx?.path) return;
    if (!seenLanguages.has(ctx.language)) {
      seenLanguages.add(ctx.language);
      void pluginsBackend()
        .activationEvent("language", ctx.language)
        .catch(() => seenLanguages.delete(ctx.language));
    }
    const root = useProject.getState().project?.root;
    if (root && ctx.path.startsWith(`${root}/`)) {
      void pluginsBackend()
        .activationEvent("file", ctx.path.slice(root.length + 1))
        .catch(() => {});
    }
  };
  report(useEditorRegistry.getState().active?.ctx);
  return useEditorRegistry.subscribe((s, prev) => {
    if (s.active?.ctx.path !== prev.active?.ctx.path) report(s.active?.ctx);
  });
}

export function startPluginBridge(): () => void {
  const disposers = [
    defineBuiltinUiPoints(),
    pluginsBackend().onEvent(handlePluginEvent),
    syncProjection(),
    trackPluginTheme(),
    followThemeSetting(),
    trackIconTheme(),
    trackActiveFile(),
    trackActivationEvents(),
    startRuntimeUi(),
  ];
  return () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    disposers.reverse().forEach((d) => d());
  };
}
