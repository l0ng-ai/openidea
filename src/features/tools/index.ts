/**
 * Tools installer: Settings › Languages & Frameworks › Language Servers, plus
 * install prompts for missing language servers.
 *
 * Actions: `tools.languageServers` (open the page; arg: a tool name to show), `tools.install` (arg: tool name),
 * `tools.promptInstall` (arg: `{ name, sticky?, formatter?, refactoring?: label }`),
 * `java.downloadJdk` (arg: `DownloadJdkArgs`).
 */
import { executeAction, registerActions } from "@/platform/actions";
import { installExpiredServerPrompts } from "./expired";
import { installJdkPrompts, registerJdkActions } from "./jdk";
import {
  installMissingServerPrompts,
  installServerReadyExpiry,
  installServerWarningPrompts,
  promptInstall,
} from "./missing";
import { activateSettingsPages } from "./settingsPages";
import { installTool, refreshTools, SETTINGS_PAGE_ID, toolByName, useTools } from "./store";

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    registerActions([
      {
        id: "tools.promptInstall",
        title: "Install Missing Tool",
        hidden: true,
        run: async ({ arg }) => {
          if (arg && typeof arg === "object" && "name" in arg && typeof arg.name === "string") {
            await promptInstall(
              arg.name,
              !("sticky" in arg) || arg.sticky !== false,
              new Set(),
              "refactoring" in arg && typeof arg.refactoring === "string"
                ? { refactoring: arg.refactoring }
                : "formatter" in arg && arg.formatter === true
                  ? "formatter"
                  : "codeInsight",
            );
          }
        },
      },
      {
        id: "tools.languageServers",
        title: "Language Servers…",
        category: "Tools",
        icon: "package",
        keywords: ["lsp", "install", "debugger", "adapter"],
        run: ({ arg }) =>
          void executeAction(
            "file.settings",
            typeof arg === "string" ? `${SETTINGS_PAGE_ID}#${arg}` : SETTINGS_PAGE_ID,
          ),
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
    installServerReadyExpiry(),
    installServerWarningPrompts(),
    installExpiredServerPrompts(),
    registerJdkActions(),
    installJdkPrompts(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
