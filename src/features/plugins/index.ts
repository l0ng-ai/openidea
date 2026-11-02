/**
 * Plugins: Settings › Plugins (installed list, enable/disable, install from
 * disk, uninstall, theme selection) and the runtime bridge to the WASM plugin
 * host (`ide-plugin`).
 *
 * Actions: `plugins.settings`, `plugins.installFromDisk`, `plugins.reloadAll`,
 * plus one action per plugin command: `plugin.<pluginId>.<commandId>`
 * (searchable in Search Everywhere › Actions and bindable in the keymap editor;
 * a string arg is forwarded to the plugin).
 */
import { lazyComponent } from "@/ui";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerSettingsPage } from "@/workbench/contributions";
import { startPluginBridge, trackPluginTheme } from "./bridge";
import { installFromDisk, refreshPlugins, reloadPlugin, SETTINGS_PAGE_ID, usePlugins } from "./store";

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
  const disposers = [registerPluginsPage(), trackPluginTheme()];
  void refreshPlugins();
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  const disposers = [
    registerPluginsPage(),
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
    // Dev plugins (`<project>/.openidea/plugins`) depend on the open project.
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root || s.project?.trusted !== prev.project?.trusted) void refreshPlugins();
    }),
  ];
  void refreshPlugins();
  return () => disposers.reverse().forEach((d) => d());
}
