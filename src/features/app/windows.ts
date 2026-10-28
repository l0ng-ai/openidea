/**
 * Multi-window: one project per window. New windows are created by the
 * backend (`window_open_project` / `window_new`) and told what to open via a
 * pending launch, taken here on startup and on `openidea://launch`.
 *
 * Loose files opened without a project (dropped on the Welcome screen, File ›
 * Open File…, a file path on the command line) open in LightEdit: a window with
 * editor tabs only. One LightEdit window collects them all.
 */
import type { Action } from "@/platform/actions";
import { t } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import {
  basename,
  confirmLeaveProject,
  dirname,
  openLightEdit,
  openProject,
  provideStartupLaunch,
  useProject,
} from "@/platform/project";
import { connectRemote, isRemoteWindow } from "@/platform/remote";
import { holdSplash } from "@/platform/splash";
import { editorService, maybeEditorService, notifications } from "@/workbench/contributions";
import { chooseProjectWindow } from "@/workbench/projectWindow";

export const LAUNCH_EVENT = "openidea://launch";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function desktopOnly(): boolean {
  if (isTauri()) return false;
  notifications().notify({ level: "warning", title: t("app.window.desktopOnly") });
  return true;
}

function openFailed(path: string, e: unknown) {
  notifications().notify({
    level: "error",
    title: t("app.window.openFailed", { name: basename(path) }),
    body: errorText(e),
    key: `app.open:${path}`,
  });
}

/** Opens project `path` in this window; true once it is this window's project. */
async function openHere(path: string): Promise<boolean> {
  if (useProject.getState().project?.root === path) return true;
  if (!(await confirmLeaveProject())) return false;
  try {
    await openProject(path);
    return true;
  } catch (e) {
    openFailed(path, e);
    return false;
  }
}

/** Opens `files` as editor tabs of this window, focusing the last. */
async function openInEditor(files: readonly string[]): Promise<void> {
  for (const [i, path] of files.entries())
    await editorService()
      .openFile(path, { focus: i === files.length - 1 })
      .catch((e) => console.warn(`could not open ${path}`, e));
}

/** Opens `files` in this window: in its project's editor or, without one, in LightEdit. */
async function openFilesHere(files: readonly string[]): Promise<void> {
  const s = useProject.getState();
  if (!s.project && !s.lightEdit) {
    try {
      await openLightEdit(files[0]!);
    } catch (e) {
      return openFailed(files[0]!, e);
    }
  }
  await openInEditor(files);
}

/**
 * Opens loose `files`: in this window's local project; else a file inside a project open in
 * another window opens there and the rest in LightEdit (this window's session, the LightEdit
 * window, or this window turns into one; a remote project window gets a new one).
 */
export async function openFiles(files: readonly string[]): Promise<void> {
  if (!files.length) return;
  const s = useProject.getState();
  if (s.project && !isRemoteWindow()) return openInEditor(files);
  if (desktopOnly()) return;
  try {
    const here = await call(commands.windowOpenFiles([...files]));
    if (here.length) await openFilesHere(here);
  } catch (e) {
    openFailed(files[0]!, e);
  }
}

const pathIsDir = (path: string) => call(commands.fsReadDir(path)).then(() => true);

/** Opens dropped paths: files as loose files ({@link openFiles}), the first folder as a project. */
export async function openPaths(
  paths: readonly string[],
  isDir: (path: string) => Promise<boolean> = pathIsDir,
): Promise<void> {
  const kinds = await Promise.all(paths.map((p) => isDir(p).catch(() => false)));
  const files = paths.filter((_, i) => !kinds[i]);
  const dir = paths.find((_, i) => kinds[i]);
  await openFiles(files);
  if (dir) await openProjectWithPolicy(dir);
}

/**
 * Opens `path`, focusing the window that already has it. `newWindow`: always a
 * new window; otherwise this window unless it already has a project or LightEdit
 * session. `files` then open in the project's editor.
 */
export async function openProjectInWindow(path: string, newWindow: boolean, files: readonly string[] = []) {
  if (desktopOnly()) return;
  const s = useProject.getState();
  const inNew = newWindow || s.project !== null || s.lightEdit;
  try {
    const outcome = await call(commands.windowOpenProject(path, inNew, [...files]));
    if (outcome.kind === "current" && (await openHere(path))) await openInEditor(files);
  } catch (e) {
    openFailed(path, e);
  }
}

/**
 * Opens `path` following "Open project in" when this window already has a
 * project or LightEdit session, then `files` in its editor.
 */
export async function openProjectWithPolicy(path: string, files: readonly string[] = []): Promise<void> {
  if (desktopOnly()) return;
  const { project: current, lightEdit } = useProject.getState();
  if (!current && !lightEdit) return openProjectInWindow(path, false, files);
  if (current?.root === path) return openInEditor(files);
  const mode = await chooseProjectWindow(basename(path));
  if (!mode) return;
  if (mode === "new") return openProjectInWindow(path, true, files);
  try {
    // A window that already has the project is focused instead.
    const outcome = await call(commands.windowOpenProject(path, false, [...files]));
    if (outcome.kind === "current" && (await openHere(path))) await openInEditor(files);
  } catch {
    if (await openHere(path)) await openInEditor(files);
  }
}

/** LightEdit: opens the current file's folder as a project ("Open project in" applies) and the file there. */
export async function openLightEditFileAsProject(): Promise<void> {
  if (!useProject.getState().lightEdit) return;
  const path = maybeEditorService()?.activePath();
  if (path) await openProjectWithPolicy(dirname(path), [path]);
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

async function pickFiles(title: string): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: false, multiple: true, title, defaultPath: defaultProjectDirectory() });
  return picked === null ? [] : Array.isArray(picked) ? picked : [picked];
}

/** Takes this window's pending launch (if any) and opens its project and files. */
export async function consumeLaunch(): Promise<void> {
  if (!isTauri()) return;
  const launch = await commands.windowTakeLaunch().catch(() => null);
  const files = launch?.files ?? [];
  if (launch?.project) {
    if (await openHere(launch.project)) await openInEditor(files);
  } else if (files.length) await openFilesHere(files);
  else if (launch?.remote) {
    const { sshConfig, path } = launch.remote;
    await connectRemote(sshConfig, path).catch((e) =>
      notifications().notify({
        level: "error",
        title: t("app.window.openFailed", { name: basename(path) }),
        body: errorText(e),
        key: `app.open:${path}`,
      }),
    );
  }
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
      id: "file.openFile",
      title: t("app.action.openFile"),
      category: t("app.category.file"),
      icon: "file",
      keywords: ["file", "light edit"],
      run: async () => {
        if (desktopOnly()) return;
        await openFiles(await pickFiles(t("app.window.pickFileTitle")));
      },
    },
    {
      // Files and folders dropped on the Welcome screen.
      id: "file.openPaths",
      title: "Open Paths",
      category: t("app.category.file"),
      hidden: true,
      run: async (c) => {
        if (Array.isArray(c.arg)) await openPaths(c.arg.filter((p): p is string => typeof p === "string"));
      },
    },
    {
      id: "lightEdit.openProject",
      title: t("app.action.lightEditOpenProject"),
      category: t("app.category.file"),
      icon: "folder-open",
      keywords: ["light edit", "project", "folder"],
      when: "lightEdit",
      run: openLightEditFileAsProject,
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

async function closeThisWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/**
 * LightEdit: closing its last editor tab closes the window (through the close guard,
 * so the last window shows the Welcome screen instead).
 */
export function installLightEditAutoClose(closeWindow: () => Promise<void> = closeThisWindow): () => void {
  const editor = maybeEditorService();
  const off = editor?.onActiveInputChange?.((input) => {
    if (input || !useProject.getState().lightEdit || editor?.openTabs?.().length) return;
    void closeWindow().catch((e) => console.warn("could not close the window", e));
  });
  return () => off?.();
}

export function installLaunchHandling(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const launch = consumeLaunch();
  provideStartupLaunch(launch);
  holdSplash(launch);
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
