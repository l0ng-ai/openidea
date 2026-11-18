/**
 * Standalone native Settings window (`settings-<parent>`): settings pages only,
 * working on the parent's project without importing workbench status bar widgets
 * or CodeMirror.
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { registerActions } from "@/platform/actions";
import { logError } from "@/platform/errorLog";
import { isImeKey } from "@/platform/ime";
import { commands } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { restoreRemote } from "@/platform/remote";
import { isPopupOpen } from "@/ui";
import { settingsActions } from "./actions";
import { loadBuiltinPages, unloadBuiltinPages } from "./dialog/LazySettingsDialog";
import { trackIconThemePages } from "./iconThemePages";
import {
  closeSettings,
  openSettings,
  rebaseSettings,
  selectPage,
  setNewProjects,
  setQuery,
  settingsTitle,
  useSettingsDialog,
} from "./model/staging";
import { trackRuntimeSettings } from "./runtime";
import { installActionProxies } from "./window/bridge";

/** Same event as `windows::LAUNCH_EVENT`: a pending launch (page) is waiting. */
const LAUNCH_EVENT = "openidea://launch";

export interface SettingsLaunch {
  page?: string;
  newProjects: boolean;
}

function navigate(page: string | undefined) {
  if (!page) return;
  setQuery("");
  selectPage(page);
}

async function takeLaunch(): Promise<SettingsLaunch | null> {
  const launch = await commands.windowTakeLaunch().catch(() => null);
  return launch && { page: launch.settingsPage ?? undefined, newProjects: launch.newProjects };
}

/** A launch for the open window: its page, and the mode when it asks for new projects. */
export function relaunchSettings(launch: SettingsLaunch | null) {
  if (!launch) return;
  if (launch.newProjects) setNewProjects(true);
  navigate(launch.page);
}

function listenLaunch(): () => void {
  let disposed = false;
  let off: (() => void) | undefined;
  void getCurrentWebviewWindow()
    .listen(LAUNCH_EVENT, () => void takeLaunch().then(relaunchSettings))
    .then((u) => {
      if (disposed) return u();
      off = u;
      // A page requested before we listened: its event is gone, the launch is not.
      void takeLaunch().then(relaunchSettings);
    });
  return () => {
    disposed = true;
    off?.();
  };
}

/** Esc and ⌘W cancel, like closing the window; ⌘, stays here. */
function installWindowKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isImeKey(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === "Escape" && !isPopupOpen()) || (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w")) {
      e.preventDefault();
      closeSettings();
    } else if (mod && e.key === ",") {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/**
 * The settings window (`settings-<parent>`): settings pages only, working on
 * the parent's project; Cancel / OK / Esc close the window.
 */
export function activateSettingsWindow(parent: string): () => void {
  const disposers = [
    trackRuntimeSettings(),
    trackIconThemePages(),
    unloadBuiltinPages,
    registerActions(settingsActions((page, newProjects) => relaunchSettings({ page, newProjects: !!newProjects }))),
    installActionProxies(parent),
    listenLaunch(),
    installWindowKeys(),
    useSettingsDialog.subscribe((s, prev) => {
      if (prev.open && !s.open) void getCurrentWebviewWindow().close();
      if (s.newProjects !== prev.newProjects) {
        void getCurrentWebviewWindow()
          .setTitle(settingsTitle(s.newProjects))
          .catch(() => {});
      }
    }),
  ];
  void (async () => {
    useSettingsDialog.setState({ pagesLoading: true });
    openSettings();
    try {
      const launch = await takeLaunch();
      relaunchSettings(launch);
      await Promise.all([
        loadBuiltinPages().catch((e) => logError("cannot register settings pages", e)),
        (async () => {
          await restoreRemote();
          const project = await commands.projectCurrent().catch(() => null);
          if (project) useProject.setState({ project, settings: project.settings });
          else await loadSettings().catch((e) => console.warn("cannot load settings", e));
          rebaseSettings();
        })(),
      ]);
    } finally {
      useSettingsDialog.setState({ pagesLoading: false });
    }
  })().catch((e) => logError("settings window startup failed", e));
  return () => disposers.reverse().forEach((d) => d());
}
