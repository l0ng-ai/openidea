/**
 * Plugins: Settings › Plugins (installed list, enable/disable, install from
 * disk with a permission page, uninstall, theme selection) and the runtime
 * bridge to the plugin host (`ide_host::plugins`): UI contributions are
 * projected by `projection.ts` / `points.tsx`.
 *
 * Actions: `plugins.settings`, `plugins.installFromDisk`, `plugins.reloadAll`,
 * `plugins.importIntellijTheme` (a theme plugin file; `arg`: its path),
 * `plugins.importInstalledIntellijTheme` (from the JetBrains IDEs on this machine),
 * plus one action per plugin command: `plugin.<pluginId>.<commandId>`
 * (searchable in Search Everywhere › Actions and bindable in the keymap editor;
 * a string arg is forwarded to the plugin).
 *
 * Editor contribution `plugins.lineMarkers`: gutter icons from plugin
 * `line-markers` providers (`lineMarkerGutter.ts`).
 */
import { registerEditorContribution } from "@/editor/api";
import { lazyComponent } from "@/ui";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { editorService, registerOverlay, registerSettingsPage } from "@/workbench/contributions";
import {
  followPluginChanges,
  providePluginThemePreviews,
  startPluginBridge,
  syncProjection,
  trackPluginTheme,
} from "./bridge";
import { ConsentDialogHost, provideConsentDialog } from "./consent";
import { trackIconTheme } from "./iconThemes";
import { pluginLineMarkerGutter } from "./lineMarkerGutter";
import { defineBuiltinUiPoints } from "./points";
import { startViewUi } from "./uiPoints";
import { importIntellijTheme, showInstalledIntellijThemes } from "./intellijImport";
import { IntellijThemesDialogHost } from "./IntellijThemesDialog";
import { startWorkspaceContains } from "./workspaceContains";
import { installFromDisk, refreshPlugins, reloadPlugin, SETTINGS_PAGE_ID, updateAllPlugins, usePlugins } from "./store";

function registerPluginsPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE_ID,
    title: "Plugins",
    // After Editor, as in IntelliJ IDEA.
    order: 250,
    keywords: ["plugin", "extension", "wasm", "install", "theme", "marketplace"],
    component: lazyComponent(() => import("./PluginsPage").then((m) => m.PluginsPage)),
  });
}

/** Settings › Plugins for the Settings window: the page plus the plugin theme. */
export function activateSettingsPages(): () => void {
  const disposers = [
    registerPluginsPage(),
    registerOverlay({ id: "plugins.consent", component: ConsentDialogHost }),
    registerOverlay({ id: "plugins.intellijThemes", component: IntellijThemesDialogHost }),
    provideConsentDialog(),
    defineBuiltinUiPoints(),
    followPluginChanges(),
    syncProjection(),
    trackPluginTheme(),
    trackIconTheme(),
  ];
  void refreshPlugins();
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  const disposers = [
    registerPluginsPage(),
    registerOverlay({ id: "plugins.consent", component: ConsentDialogHost }),
    registerOverlay({ id: "plugins.intellijThemes", component: IntellijThemesDialogHost }),
    provideConsentDialog(),
    providePluginThemePreviews(),
    registerActions([
      {
        id: "plugins.settings",
        title: "Plugins…",
        category: "Plugins",
        icon: "plugin",
        keywords: ["extensions", "manage plugins"],
        run: () => void executeAction("file.settings", SETTINGS_PAGE_ID),
      },
      {
        id: "plugins.installFromDisk",
        title: "Install Plugin from Disk…",
        category: "Plugins",
        icon: "plugin",
        keywords: ["extension", "wasm", "plugin.toml"],
        run: async ({ arg }) => {
          await installFromDisk(typeof arg === "string" ? arg : undefined);
        },
      },
      {
        id: "plugins.updateAll",
        title: "Update All Plugins",
        category: "Plugins",
        icon: "plugin",
        keywords: ["upgrade", "marketplace", "new version"],
        run: async () => {
          await updateAllPlugins();
        },
      },
      {
        id: "plugins.importIntellijTheme",
        title: "Import IntelliJ Theme from File…",
        category: "Plugins",
        icon: "plugin",
        keywords: ["intellij", "jetbrains", "theme", "jar", "theme.json", "color scheme"],
        // Installing needs a project's window.
        when: "projectOpen",
        run: async ({ arg }) => {
          await importIntellijTheme(typeof arg === "string" ? arg : undefined);
        },
      },
      {
        id: "plugins.importInstalledIntellijTheme",
        title: "Import Theme from JetBrains IDE…",
        category: "Plugins",
        icon: "plugin",
        keywords: [
          "intellij",
          "jetbrains",
          "pycharm",
          "webstorm",
          "android studio",
          "theme",
          "color scheme",
          "migrate",
        ],
        when: "projectOpen",
        run: () => showInstalledIntellijThemes(),
      },
      {
        id: "plugins.reloadAll",
        title: "Reload Plugins",
        category: "Plugins",
        icon: "refresh",
        keywords: ["dev plugin", "rebuild"],
        run: async () => {
          const ids = usePlugins.getState().plugins.map((p) => p.id);
          for (const id of ids) await reloadPlugin(id);
        },
      },
    ]),
    startPluginBridge(),
    // Plugin custom editors (tab kind) and context menu entries.
    startViewUi((input) => void editorService().openInput(input)),
    startWorkspaceContains(),
    // Gutter icons from plugins' `line-markers` providers (next to the LSP ones).
    registerEditorContribution({ id: "plugins.lineMarkers", order: 57, extensions: pluginLineMarkerGutter }),
    // Dev plugins (`<project>/.openidea/plugins`) depend on the open project.
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root || s.project?.trusted !== prev.project?.trusted) void refreshPlugins();
    }),
  ];
  void refreshPlugins();
  return () => disposers.reverse().forEach((d) => d());
}
