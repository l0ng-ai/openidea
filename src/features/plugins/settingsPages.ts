/**
 * Settings › Plugins for the standalone Settings window: registers the Plugins
 * page, projects plugin commands/keymaps/settings/themes, and follows plugin
 * updates without pulling in CodeMirror editor extensions.
 */
import { isMacHost, registerExtensionBindings } from "@/platform/keymap";
import { languageListChanged } from "@/platform/languageList";
import { lazyComponent, lazyWhen } from "@/ui";
import { registerOverlay, registerSettingsPage } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";
import { ConsentDialogHost, provideConsentDialog } from "./consent";
import { defineCoreUiPoints, pluginActionId } from "./corePoints";
import { trackIconTheme } from "./iconThemes";
import { useIntellijThemesDialog } from "./intellijThemesDialogStore";
import { defineUiPoint } from "./projection";
import { refreshRunTargets, startRunTargets } from "./runTargets";
import { projectSettings, type SettingsDecl } from "./settings";
import { refreshPlugins, SETTINGS_PAGE_ID, usePlugins } from "./store";
import { syncPluginProjection, trackPluginTheme } from "./themeRuntime";

export function registerPluginsPage(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE_ID,
    title: "Plugins",
    // After Editor, as in IntelliJ IDEA.
    order: 250,
    bleed: true,
    keywords: ["plugin", "extension", "wasm", "install", "theme", "marketplace"],
    component: lazyComponent(() => import("./PluginsPage").then((m) => m.PluginsPage)),
  });
}

const useIntellijThemesOpen = () => useIntellijThemesDialog((s) => s.open);
export const IntellijThemesDialogHost = lazyWhen(useIntellijThemesOpen, () =>
  import("./IntellijThemesDialog").then((m) => m.IntellijThemesDialogHost),
);

interface KeymapDecl {
  command: string;
  key: string;
  mac?: string | null;
  when?: string | null;
}

const VIEW_ONLY_POINTS: ReadonlyArray<[string, string]> = [
  ["menus", "Menus"],
  ["statusBar", "Status Bar Items"],
  ["views", "Tool Windows"],
  ["customEditors", "Editors"],
  ["editorPanels", "Editor Panels"],
  ["markerIcons", "Marker Icons"],
  ["fileIcons", "File Icons"],
  ["commitChecks", "Commit Checks"],
  ["snippets", "Snippets"],
  ["fileTemplates", "File Templates"],
];

function defineSettingsUiPoints(): () => void {
  const disposers = [
    defineCoreUiPoints(),
    defineUiPoint<KeymapDecl>("keymaps", {
      title: "Shortcuts",
      project: ({ pluginId, decl }) =>
        decl.key === "Escape" && decl.when
          ? undefined
          : registerExtensionBindings(pluginActionId(pluginId, decl.command), [
              isMacHost() ? (decl.mac ?? decl.key) : decl.key,
            ]),
    }),
    defineUiPoint<SettingsDecl>("settings", {
      title: "Settings",
      project: ({ pluginId, decl }) => projectSettings(pluginId, decl),
    }),
    ...VIEW_ONLY_POINTS.map(([point, title]) => defineUiPoint(point, { title })),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

function followSettingsPluginChanges(): () => void {
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const off = pluginsBackend().onEvent((e) => {
    switch (e.type) {
      case "runTargetsChanged":
        void refreshRunTargets(false).catch(() => {});
        break;
      case "commandsChanged":
        if (!refreshTimer) {
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void refreshPlugins();
          }, 30);
        }
        break;
      case "themeChanged":
        usePlugins.setState({ activeTheme: e.theme });
        break;
      case "languagesChanged":
        languageListChanged();
        break;
      default:
        break;
    }
  });
  return () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    off();
  };
}

export function activateSettingsPages(): () => void {
  const disposers = [
    registerPluginsPage(),
    registerOverlay({ id: "plugins.consent", component: ConsentDialogHost }),
    registerOverlay({ id: "plugins.intellijThemes", component: IntellijThemesDialogHost }),
    provideConsentDialog(),
    defineSettingsUiPoints(),
    followSettingsPluginChanges(),
    startRunTargets(false),
    syncPluginProjection(),
    trackPluginTheme(),
    trackIconTheme(),
  ];
  void refreshPlugins();
  return () => disposers.reverse().forEach((d) => d());
}
