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
import { useProject } from "@/platform/project";
import { enableRemote } from "@/platform/remote";
import { isPopupOpen } from "@/ui";
import { NEW_PROJECTS_PAGE, settingsActions } from "./actions";
import { loadBuiltinPages, preloadBuiltinRegistry, unloadBuiltinPages } from "./dialog/LazySettingsDialog";
import { trackIconThemePages } from "./iconThemePages";
import { validateSettings } from "./model/schema";
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

function listenLaunch(afterInit: Promise<unknown>): () => void {
  let disposed = false;
  let off: (() => void) | undefined;
  void getCurrentWebviewWindow()
    .listen(LAUNCH_EVENT, () => void takeLaunch().then(relaunchSettings))
    .then(async (u) => {
      if (disposed) return u();
      off = u;
      // A page requested after `window_take_settings_init` read the slot but before `listen`
      // attached: its event is gone, the launch is not. Apply it after the initial launch settles.
      await afterInit.catch(() => {});
      if (!disposed) void takeLaunch().then(relaunchSettings);
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
  const bootstrap = (async () => {
    useSettingsDialog.setState({ pagesLoading: true });
    openSettings(undefined, { globalBase: useSettingsDialog.getState().globalBase });
    try {
      const [init] = await Promise.all([commands.windowTakeSettingsInit(), preloadBuiltinRegistry().catch(() => null)]);
      if (init.remote) enableRemote(init.remote);
      const globalBase = validateSettings(init.globalSettings);
      if (init.project) {
        useProject.setState({ project: init.project, settings: init.project.settings });
      } else {
        useProject.setState({ project: null, settings: init.globalSettings });
      }
      const launch = init.launch && {
        page: init.launch.settingsPage ?? undefined,
        newProjects: init.launch.newProjects,
      };
      const targetPage =
        launch?.page ?? (launch?.newProjects ? NEW_PROJECTS_PAGE : useSettingsDialog.getState().pageId);
      await loadBuiltinPages({ pageId: targetPage, updates: init.updates }).catch((e) =>
        logError("cannot register settings pages", e),
      );
      relaunchSettings(launch);
      rebaseSettings(globalBase);
      if (init.remote) {
        // Reconcile remote-host settings asynchronously without blocking first paint on SSH.
        // `rebaseSettings` updates only `base` / `globalBase` and leaves any staged edits intact.
        const remoteGlobalPromise = init.remote.commands.includes("settings_get_global")
          ? commands.settingsGetGlobal().catch(() => null)
          : Promise.resolve(null);
        void Promise.all([commands.projectCurrent(), remoteGlobalPromise])
          .then(([fresh, remoteGlobal]) => {
            if (!useSettingsDialog.getState().open) return;
            const nextGlobal = remoteGlobal ? validateSettings(remoteGlobal) : globalBase;
            if (fresh) {
              useProject.setState({ project: fresh, settings: fresh.settings });
            }
            if (fresh || remoteGlobal) {
              rebaseSettings(nextGlobal);
            }
          })
          .catch(() => {});
      }
    } finally {
      useSettingsDialog.setState({ pagesLoading: false });
    }
  })();
  bootstrap.catch((e) => logError("settings window startup failed", e));
  const disposers = [
    trackRuntimeSettings(),
    trackIconThemePages(),
    unloadBuiltinPages,
    registerActions(settingsActions((page, newProjects) => relaunchSettings({ page, newProjects: !!newProjects }))),
    installActionProxies(parent),
    listenLaunch(bootstrap),
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
  return () => disposers.reverse().forEach((d) => d());
}
