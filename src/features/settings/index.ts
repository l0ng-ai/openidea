/**
 * Settings: the Settings window (⌘,, action `file.settings`) with built-in
 * pages (Appearance, System Settings, Keymap, Editor › General / Font / Code
 * Style / Files) plus pages contributed via `registerSettingsPage`, and the
 * runtime application of keymap / UI font size / high-contrast settings.
 *
 * On the desktop Settings open in a native child window (`activateSettingsWindow`
 * runs there) unless Appearance › "Open Settings in a separate window" is off;
 * then, and in the browser build, they open as an in-page dialog.
 *
 * `executeAction("file.settings", "keymap")` opens a specific page;
 * `file.newProjectsSettings` (IDEA's Settings for New Projects) edits the
 * global layer only, which new projects inherit.
 */
import { registerActions } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { lazyWhen } from "@/ui";
import { useProject } from "@/platform/project";
import { provideSettingsSearchIndex, registerOverlay } from "@/workbench/contributions";
import { windowBackgroundHex } from "@/workbench/theme";
import { NEW_PROJECTS_PAGE, settingsActions } from "./actions";
import {
  LazyProjectStructureDialog,
  LazySettingsDialog,
  loadBuiltinPages,
  unloadBuiltinPages,
} from "./dialog/LazySettingsDialog";
import { openProjectStructure, openSettings, useSettingsDialog } from "./model/staging";
import {
  appearanceToggleActions,
  navigationBarActions,
  presentationAssistantAction,
  zoomActions,
} from "./appearanceRuntime";
import { PresentationAssistant } from "./presentation/PresentationAssistant";
import { activateFileTypes } from "./fileTypesRuntime";
import { trackRuntimeSettings } from "./runtime";
import { activateSettingsWindow, relaunchSettings } from "./settingsWindow";
import { installSettingsHost } from "./window/bridge";
import { showAssignShortcut, useAssignShortcut } from "./keymap/assignShortcutStore";
import { settingsSearchEntries } from "./searchIndex";
import { activatePythonStatus } from "./languages/PythonStatus";
import { activatePhpStatus } from "./languages/PhpStatus";
import { trackIconThemePages } from "./iconThemePages";

export { activateSettingsWindow };

const separateWindow = () => useProject.getState().settings?.appearance?.settingsInSeparateWindow !== false;

/** The native Settings window when it is enabled and the backend can make one, else the dialog. */
async function showSettings(page?: string, newProjects = false) {
  if (isTauri() && separateWindow()) {
    try {
      await call(commands.windowOpenSettings(page ?? null, newProjects, windowBackgroundHex()));
      return;
    } catch (e) {
      console.warn("settings window unavailable, using the dialog", e);
    }
  }
  const targetPage = page ?? (newProjects ? NEW_PROJECTS_PAGE : useSettingsDialog.getState().pageId);
  await loadBuiltinPages({ pageId: targetPage });
  // Like a launch into the open window: go to the page, keep the edits not applied yet.
  if (useSettingsDialog.getState().open) relaunchSettings({ page, newProjects });
  else openSettings(page, { newProjects });
}

const useAssignShortcutOpen = () => useAssignShortcut((s) => s.actionId !== null);

export function activate(): () => void {
  const disposers = [
    trackRuntimeSettings(),
    trackIconThemePages(),
    activatePythonStatus(),
    activatePhpStatus(),
    unloadBuiltinPages,
    registerOverlay({ id: "settings.dialog", component: LazySettingsDialog }),
    registerOverlay({ id: "settings.projectStructure", component: LazyProjectStructureDialog }),
    registerOverlay({ id: "settings.presentationAssistant", component: PresentationAssistant }),
    activateFileTypes(),
    registerOverlay({
      id: "settings.assignShortcut",
      component: lazyWhen(useAssignShortcutOpen, () =>
        import("./keymap/AssignShortcut").then((m) => m.AssignShortcutOverlay),
      ),
    }),
    registerActions([
      ...zoomActions(),
      ...appearanceToggleActions(),
      presentationAssistantAction(),
      ...navigationBarActions(),
      ...settingsActions((page, newProjects) => showSettings(page, newProjects)),
      {
        id: "file.projectStructure",
        title: "Project Structure…",
        category: "File",
        icon: "folder",
        keywords: ["project structure", "sdk", "jdk", "modules", "libraries", "facets", "artifacts", "sources"],
        run: ({ arg }) => openProjectStructure(typeof arg === "string" ? arg : undefined),
      },
      {
        // Search Everywhere's ⌥↵ on an action (arg: the action id).
        id: "settings.assignShortcut",
        title: "Assign Shortcut…",
        category: "Settings",
        hidden: true,
        run: ({ arg }) => {
          if (typeof arg === "string") showAssignShortcut(arg);
        },
      },
    ]),
    provideSettingsSearchIndex(settingsSearchEntries),
    isTauri() ? installSettingsHost() : () => {},
  ];
  return () => disposers.reverse().forEach((d) => d());
}
