/**
 * Multi-window: one project per window. New windows are created by the
 * backend (`window_open_project` / `window_new`) and told what to open via a
 * pending launch, taken here on startup and on `openidea://launch`.
 */
import type { Action } from "@/platform/actions";
import { t } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { basename, confirmLeaveProject, openProject, provideStartupLaunch, useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { ask } from "./prompt";

export const LAUNCH_EVENT = "openidea://launch";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function desktopOnly(): boolean {
  if (isTauri()) return false;
  notifications().notify({ level: "warning", title: t("app.window.desktopOnly") });
  return true;
}

async function openHere(path: string) {
  if (useProject.getState().project?.root === path) return;
  if (!(await confirmLeaveProject())) return;
  try {
    await openProject(path);
  } catch (e) {
    notifications().notify({
      level: "error",
      title: t("app.window.openFailed", { name: basename(path) }),
      body: errorText(e),
      key: `app.open:${path}`,
    });
  }
}

/**
 * Opens `path`, focusing the window that already has it. `newWindow`: always a
 * new window; otherwise this window unless it already has a project.
 */
export async function openProjectInWindow(path: string, newWindow: boolean): Promise<void> {
  if (desktopOnly()) return;
  const inNew = newWindow || useProject.getState().project !== null;
  try {
    const outcome = await call(commands.windowOpenProject(path, inNew));
    if (outcome.kind === "current") await openHere(path);
  } catch (e) {
    notifications().notify({
      level: "error",
      title: t("app.window.openFailed", { name: basename(path) }),
      body: errorText(e),
      key: `app.open:${path}`,
    });
  }
}

/** System Settings › Project › "Open project in": `new` | `same` | `ask`. */
export function openPolicy(): "ask" | "new" | "same" {
  const v = useProject.getState().settings?.general?.openProjectIn;
  return v === "new" || v === "same" ? v : "ask";
}

/** Opens `path` following "Open project in" when this window already has a project. */
export async function openProjectWithPolicy(path: string): Promise<void> {
  if (desktopOnly()) return;
  const current = useProject.getState().project;
  if (!current) return openProjectInWindow(path, false);
  if (current.root === path) return;
  let mode = openPolicy();
  if (mode === "ask") {
    const r = await ask({
      title: t("app.window.askTitle"),
      body: t("app.window.askBody", { name: basename(path) }),
      buttons: [
        { id: "same", label: t("app.window.askThis") },
        { id: "new", label: t("app.window.askNew"), primary: true },
        { id: "cancel", label: t("common.cancel") },
      ],
      checkbox: t("app.window.askRemember"),
    });
    if (r.button !== "same" && r.button !== "new") return;
    mode = r.button;
    if (r.checked) {
      try {
        useProject.setState({ settings: await call(commands.settingsSet("global", "general.openProjectIn", JSON.stringify(mode))) });
      } catch {
        /* the choice still applies to this open */
      }
    }
  }
  if (mode === "new") return openProjectInWindow(path, true);
  try {
    // A window that already has the project is focused instead.
    const outcome = await call(commands.windowOpenProject(path, false));
    if (outcome.kind === "current") await openHere(path);
  } catch {
    await openHere(path);
  }
}

/** System Settings › Project › "Default directory" for folder pickers. */
export function defaultProjectDirectory(): string | undefined {
  return useProject.getState().settings?.general?.defaultProjectDirectory?.trim() || undefined;
}

async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title, defaultPath: defaultProjectDirectory() });
  const path = Array.isArray(picked) ? picked[0] : picked;
  return path ?? null;
}

/** Takes this window's pending launch (if any) and opens its project. */
export async function consumeLaunch(): Promise<void> {
  if (!isTauri()) return;
  const launch = await commands.windowTakeLaunch().catch(() => null);
  if (launch?.project) await openHere(launch.project);
}

export function windowActions(): Action[] {
  return [
    {
      id: "file.openInNewWindow",
      title: t("app.action.openInNewWindow"),
      category: t("app.category.file"),
      icon: "folder-open",
      keywords: ["window", "project", "folder"],
      run: async (c) => {
        if (desktopOnly()) return;
        const path = typeof c.arg === "string" ? c.arg : await pickFolder(t("app.window.pickTitle"));
        if (path) await openProjectInWindow(path, true);
      },
    },
    {
      id: "file.openRecentProject",
      title: t("app.action.openRecentProject"),
      category: t("app.category.file"),
      hidden: true,
      run: async (c) => {
        if (typeof c.arg === "string") await openProjectWithPolicy(c.arg);
      },
    },
    {
      // Used by File › Open… once a folder is picked.
      id: "file.openProjectPath",
      title: "Open Project Path",
      category: t("app.category.file"),
      hidden: true,
      run: async (c) => {
        if (typeof c.arg === "string") await openProjectWithPolicy(c.arg);
      },
    },
    {
      id: "window.new",
      title: t("app.action.newWindow"),
      category: t("app.category.window"),
      run: async () => {
        if (desktopOnly()) return;
        await call(commands.windowNew()).catch((e) =>
          notifications().notify({ level: "error", title: t("app.action.newWindow"), body: errorText(e) }),
        );
      },
    },
    {
      id: "window.next",
      title: t("app.action.nextWindow"),
      category: t("app.category.window"),
      run: () => (isTauri() ? commands.windowCycle(true) : undefined),
    },
    {
      id: "window.previous",
      title: t("app.action.previousWindow"),
      category: t("app.category.window"),
      run: () => (isTauri() ? commands.windowCycle(false) : undefined),
    },
    {
      id: "window.toggleFullScreen",
      title: t("app.action.toggleFullScreen"),
      category: t("app.category.view"),
      icon: "maximize",
      keywords: ["full screen", "fullscreen"],
      run: async () => {
        if (isTauri()) await commands.windowToggleFullscreen();
        else if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen?.();
      },
    },
  ];
}

export function installLaunchHandling(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  provideStartupLaunch(consumeLaunch());
  void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
    const off = await getCurrentWebviewWindow().listen(LAUNCH_EVENT, () => void consumeLaunch());
    if (disposed) off();
    else unlisten = off;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
