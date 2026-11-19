/**
 * Glue between backend plugins and the workbench: UI contributions are
 * projected (`projection.ts` + `points.tsx`), status items, tasks and event
 * subscriptions of running code go through `runtimeUi.tsx`, the selected
 * theme becomes a stylesheet of CSS
 * variables, notifications become balloons, consent requests open the
 * permission dialog, and opened files fire `on-language` / `on-file`.
 */
import type { PluginEvent, PluginUpdate } from "@/bindings";
import { useEditorRegistry } from "@/editor/api";
import { refreshLanguageInfos } from "@/editor/core/cm/languages";
import { clearBackoffs } from "@/editor/lsp/availability";
import { endpointsChanged, notifications } from "@/workbench/contributions";
import { languageListChanged } from "@/platform/languageList";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { pluginsBackend } from "./backend";
import { trackIconTheme } from "./iconThemes";
import { defineBuiltinUiPoints } from "./points";
import { handleRuntimeEvent, refreshEventKinds, startRuntimeUi } from "./runtimeUi";
import { grantPlugin, runPluginCommand, refreshPlugins, updateAllPlugins, usePlugins } from "./store";
import { followThemeSetting, syncPluginProjection, trackPluginTheme } from "./themeRuntime";

export { pluginActionId } from "./points";
export {
  applyPluginTheme,
  followThemeSetting,
  PLUGIN_THEME_CACHE_KEY,
  PLUGIN_THEME_STYLE_ID,
  providePluginThemePreviews,
  trackPluginTheme,
  type CachedPluginTheme,
} from "./themeRuntime";

/** Keeps the projected UI contributions in line with the plugin list. */
export function syncProjection(): () => void {
  return syncPluginProjection(clearBackoffs);
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
    case "endpointsChanged":
      if (e.root === useProject.getState().project?.root) endpointsChanged();
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
        actions: e.actions.map((a) => ({
          label: a.label,
          run: () => void runPluginCommand(e.pluginId, a.command, a.argument),
        })),
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
