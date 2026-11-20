import type { ComponentType } from "react";
import { activateSettingsPages as agentsPages } from "./features/agents/settingsPages";
import { installLocaleSync } from "./features/app/locale";
import { activateSettingsPages as databasePages } from "./features/database/settingsPages";
import { activateSettingsPages as githubPages } from "./features/github/settingsPages";
import { activateSettingsPages as pluginsPages } from "./features/plugins/settingsPages";
import { activate as projectTrust } from "./features/project-trust";
import { activateSettingsWindow } from "./features/settings/settingsWindow";
import { SettingsWindow } from "./features/settings/window/SettingsWindow";
import { activateSettingsPages as templatesPages } from "./features/templates/settingsPages";
import { activateSettingsPages as todoPages } from "./features/todo/settingsPages";
import { activateSettingsPages as toolsPages } from "./features/tools/settingsPages";
import { activateSettingsPages as vcsPages } from "./features/vcs/settingsPages";
import { activateSettingsPages as vimPages } from "./features/vim/settingsPages";
import { activateList } from "./windowBoot";

/**
 * Native Settings window of project window `parent`: only the settings pages
 * (no workbench, project services, CodeMirror editors or tool windows).
 */
export function bootSettingsWindow(parent: string): ComponentType {
  activateList("settings pages", [
    ["project-trust", projectTrust],
    ["locale", installLocaleSync],
    ["settings", () => activateSettingsWindow(parent)],
    ["templates", templatesPages],
    ["todo", todoPages],
    ["plugins", pluginsPages],
    ["tools", toolsPages],
    ["agents", agentsPages],
    ["vim", vimPages],
    ["vcs", vcsPages],
    ["github", githubPages],
    ["database", databasePages],
  ]);
  return SettingsWindow;
}
