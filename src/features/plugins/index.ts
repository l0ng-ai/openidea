import { pluginLanguageVisuals } from "./languageVisuals";
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
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { editorService, registerOverlay } from "@/workbench/contributions";
import { providePluginThemePreviews, startPluginBridge } from "./bridge";
import { ConsentDialogHost, provideConsentDialog } from "./consent";
import { pluginLineMarkerGutter } from "./lineMarkerGutter";
import { startViewUi } from "./uiPoints";
import { showInstalledIntellijThemes } from "./intellijThemesDialogStore";
import { startWorkspaceContains } from "./workspaceContains";
import { startPluginDecorations } from "./decorations";
import { startPluginConsoleRules } from "./consoleRules";
import { startOneDarkNotice } from "./oneDarkNotice";
import { startIndexedMarkers } from "./indexedMarkers";
import { startPluginNavigation } from "./navigation";
import { IntellijThemesDialogHost, registerPluginsPage } from "./settingsPages";
import { installFromDisk, refreshPlugins, reloadPlugin, SETTINGS_PAGE_ID, updateAllPlugins, usePlugins } from "./store";

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
          await (await import("./intellijImport")).importIntellijTheme(typeof arg === "string" ? arg : undefined);
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
    startPluginNavigation(),
    startOneDarkNotice(),
    startIndexedMarkers(),
    startPluginDecorations(),
    startPluginConsoleRules(),
    // Plugin custom editors (tab kind) and context menu entries.
    startViewUi((input) => void editorService().openInput(input)),
    startWorkspaceContains(),
    // Gutter icons from plugins' `line-markers` providers (next to the LSP ones).
    registerEditorContribution({ id: "plugins.languageFeatures", order: 58, extensions: pluginLanguageVisuals }),
    registerEditorContribution({ id: "plugins.lineMarkers", order: 57, extensions: pluginLineMarkerGutter }),
    // Dev plugins (`<project>/.openidea/plugins`) depend on the open project.
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root || s.project?.trusted !== prev.project?.trusted) void refreshPlugins();
    }),
  ];
  void refreshPlugins();
  return () => disposers.reverse().forEach((d) => d());
}
