/**
 * Tools installer: Settings › Languages & Frameworks › Language Servers, plus
 * install prompts for missing language servers.
 *
 * Actions: `tools.languageServers` (open the page), `tools.install` (arg: tool name),
 * `java.downloadJdk` (arg: `DownloadJdkArgs`).
 */
import { lazyComponent } from "@/ui";
import { executeAction, registerActions } from "@/platform/actions";
import { registerSettingsPage } from "@/workbench/contributions";
import { installJdkPrompts, registerJdkActions } from "./jdk";
import { installMissingServerPrompts } from "./missing";
import { installTool, refreshTools, SETTINGS_PAGE_ID, toolByName, useTools } from "./store";

/** The Language Servers page (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE_ID,
    title: "Language Servers",
    group: "Languages & Frameworks",
    order: 400,
    keywords: [
      "lsp",
      "language server",
      "debugger",
      "adapter",
      "dap",
      "install",
      "initialization options",
      "rust-analyzer",
      "gopls",
      "pyright",
    ],
    projectScope: true,
    component: lazyComponent(() => import("./LanguageServersPage").then((m) => m.LanguageServersPage)),
  });
}

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    registerActions([
      {
        id: "tools.languageServers",
        title: "Language Servers…",
        category: "Tools",
        icon: "package",
        keywords: ["lsp", "install", "debugger", "adapter"],
        run: () => void executeAction("file.settings", SETTINGS_PAGE_ID),
      },
      {
        id: "tools.install",
        title: "Install Language Server / Debugger",
        category: "Tools",
        hidden: true,
        // Tools the IDE can't install (no recipe, missing npm/curl) open the page with the manual hint.
        run: async ({ arg }) => {
          if (typeof arg === "string") {
            if (!useTools.getState().loaded) await refreshTools();
            const tool = toolByName(arg);
            // Unknown because the list failed to load: try anyway, so the failure is reported.
            if (tool ? tool.canInstall : useTools.getState().error !== null) {
              await installTool(arg);
              return;
            }
          }
          await executeAction("file.settings", SETTINGS_PAGE_ID);
        },
      },
    ]),
    installMissingServerPrompts(),
    registerJdkActions(),
    installJdkPrompts(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
