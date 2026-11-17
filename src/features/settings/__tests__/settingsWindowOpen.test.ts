import { describe, expect, it, vi } from "vitest";

const logFrontend = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const defaultInit = () => ({
  launch: null,
  remote: null,
  project: null,
  globalSettings: {},
  updates: false,
});
const windowTakeSettingsInit = vi.hoisted(() => vi.fn<() => Promise<unknown>>(() => Promise.resolve(defaultInit())));
const windowTakeLaunch = vi.hoisted(() => vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)));
const projectCurrent = vi.hoisted(() => vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)));
const settingsGetGlobal = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "settings-main",
    listen: () => Promise.resolve(() => {}),
    close: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
  }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      logFrontend,
      remoteCurrent: () => Promise.resolve(null),
      projectCurrent,
      settingsGet: () => Promise.resolve({}),
      settingsGetGlobal,
      windowTakeLaunch,
      windowTakeSettingsInit,
    },
  };
});
const loadBuiltinPages = vi.hoisted(() =>
  vi.fn<() => Promise<() => void>>(() => Promise.reject(new Error("page failed"))),
);
const preloadBuiltinRegistry = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../dialog/LazySettingsDialog", () => ({
  LazySettingsDialog: () => null,
  LazyProjectStructureDialog: () => null,
  loadBuiltinPages,
  preloadBuiltinRegistry,
  unloadBuiltinPages: () => {},
}));

const { activateSettingsWindow } = await import("..");
const { disableRemote } = await import("@/platform/remote");
const { useProject } = await import("@/platform/project");
const { stage, useSettingsDialog } = await import("../model/staging");

describe("the native Settings window", () => {
  it("opens even when a page fails to register, and logs why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    windowTakeSettingsInit.mockResolvedValueOnce(defaultInit());
    const dispose = activateSettingsWindow("main");
    expect(useSettingsDialog.getState().open).toBe(true);
    expect(useSettingsDialog.getState().pagesLoading).toBe(true);
    await vi.waitFor(() => expect(useSettingsDialog.getState().open).toBe(true));
    await vi.waitFor(() => expect(useSettingsDialog.getState().pagesLoading).toBe(false));
    expect(logFrontend).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("cannot register settings pages: Error: page failed"),
    );
    dispose();
  });

  it("hydrates from windowTakeSettingsInit without blocking on SSH and rebases base while keeping staged edits", async () => {
    loadBuiltinPages.mockClear().mockResolvedValue(() => {});
    settingsGetGlobal.mockClear();
    windowTakeLaunch.mockClear().mockResolvedValueOnce(null);
    let resolveRemoteRefresh!: (v: unknown) => void;
    projectCurrent.mockReturnValueOnce(new Promise((r) => (resolveRemoteRefresh = r)));
    windowTakeSettingsInit.mockResolvedValueOnce({
      launch: { settingsPage: "keymap", newProjects: false },
      remote: {
        target: { type: "ssh", config: "devbox" },
        root: "/home/dev/repo",
        host: "devbox",
        os: "linux",
        commands: ["project_current"],
      },
      project: null,
      globalSettings: { appearance: { theme: "dark" }, editor: { tabSize: 4 } },
      updates: true,
    });

    const dispose = activateSettingsWindow("main");
    // Unblocks pagesLoading immediately from local client settings while SSH projectCurrent is still pending.
    await vi.waitFor(() => expect(useSettingsDialog.getState().pagesLoading).toBe(false));
    await vi.waitFor(() => expect(windowTakeLaunch).toHaveBeenCalledTimes(1));
    expect(loadBuiltinPages).toHaveBeenCalledTimes(1);
    expect(loadBuiltinPages).toHaveBeenCalledWith({ pageId: "keymap", updates: true });
    expect(useSettingsDialog.getState().pageId).toBe("keymap");
    expect(useSettingsDialog.getState().base.appearance.theme).toBe("dark");
    expect(useSettingsDialog.getState().globalBase.editor.tabSize).toBe(4);
    expect(settingsGetGlobal).not.toHaveBeenCalled();

    // Even if the user stages an edit before SSH returns, remote `base` updates while `staged` stays intact.
    stage("editor.codeStyle.other", "project", "editor.tabSize", 8);
    resolveRemoteRefresh({
      root: "/home/dev/repo",
      name: "repo",
      displayName: "repo",
      trusted: true,
      isGit: true,
      settings: { editor: { tabSize: 6 }, appearance: { theme: "dark" } },
    });
    await vi.waitFor(() => expect(useSettingsDialog.getState().base.editor.tabSize).toBe(6));
    expect(useProject.getState().project?.root).toBe("/home/dev/repo");
    expect(useSettingsDialog.getState().staged["project|editor.tabSize"]?.value).toBe(8);

    disableRemote();
    useProject.setState({ project: null, settings: null });
    dispose();
  });

  it("picks up a launch queued between windowTakeSettingsInit and listen()", async () => {
    loadBuiltinPages.mockResolvedValue(() => {});
    windowTakeLaunch.mockResolvedValueOnce({ settingsPage: "appearance", newProjects: true });
    windowTakeSettingsInit.mockResolvedValueOnce({
      launch: { settingsPage: "keymap", newProjects: false },
      remote: null,
      project: null,
      globalSettings: {},
      updates: false,
    });

    const dispose = activateSettingsWindow("main");
    await vi.waitFor(() => expect(useSettingsDialog.getState().pagesLoading).toBe(false));
    await vi.waitFor(() => expect(useSettingsDialog.getState().newProjects).toBe(true));
    expect(useSettingsDialog.getState().pageId).toBe("appearance");

    useProject.setState({ project: null, settings: null });
    dispose();
  });
});
