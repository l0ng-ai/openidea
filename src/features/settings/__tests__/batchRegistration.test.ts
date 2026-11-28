import { describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (e: { payload: unknown }) => void>();
const emitTo = vi.fn(() => Promise.resolve());
const windowControls = {
  label: "settings-main",
  unminimize: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  setFocus: vi.fn(() => Promise.resolve()),
};

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (...args: unknown[]) => (emitTo as (...a: unknown[]) => Promise<void>)(...args),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    get label() {
      return windowControls.label;
    },
    unminimize: () => windowControls.unminimize(),
    show: () => windowControls.show(),
    setFocus: () => windowControls.setFocus(),
    listen: (event: string, cb: (e: { payload: unknown }) => void) => {
      listeners.set(event, cb);
      return Promise.resolve(() => listeners.delete(event));
    },
  }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true };
});

import type { ProjectInfo } from "@/bindings";
import { executeAction, getAction, registerAction, useActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  editorService,
  maybeEditorService,
  notifications,
  provideEditorService,
  provideNotificationService,
  registerSettingsPage,
  registerSettingsPages,
  useSettingsPages,
  type EditorService,
} from "@/workbench/contributions";
import { installActionProxies, installEditorProxy, installSettingsHost, type ActionInfo } from "../window/bridge";

describe("registerSettingsPages", () => {
  it("registers and disposes a page batch in one store update each while keeping later overrides", () => {
    let updates = 0;
    const off = useSettingsPages.subscribe(() => {
      updates += 1;
    });
    const disposeBatch = registerSettingsPages([
      { id: "batch.a", title: "A" },
      { id: "batch.b", title: "B" },
      { id: "batch.c", title: "C" },
    ]);
    const disposeOverride = registerSettingsPage({ id: "batch.b", title: "B2" });
    try {
      expect(updates).toBe(2);
      expect(useSettingsPages.getState().pages.get("batch.a")?.title).toBe("A");
      expect(useSettingsPages.getState().pages.get("batch.b")?.title).toBe("B2");
      disposeBatch();
      expect(updates).toBe(3);
      expect(useSettingsPages.getState().pages.has("batch.a")).toBe(false);
      expect(useSettingsPages.getState().pages.get("batch.b")?.title).toBe("B2");
      expect(useSettingsPages.getState().pages.has("batch.c")).toBe(false);
    } finally {
      disposeOverride();
      off();
    }
  });
});

describe("installActionProxies", () => {
  it("batches parent action syncs and keeps local actions authoritative", async () => {
    const localRun = vi.fn();
    const disposeLocal = registerAction({ id: "local.win", title: "Local", run: localRun });
    const dispose = installActionProxies("main");
    await vi.waitFor(() => expect(listeners.has("openidea://settings/actions")).toBe(true));

    let updates = 0;
    const off = useActions.subscribe(() => {
      updates += 1;
    });
    const batch: ActionInfo[] = [
      { id: "local.win", title: "Remote Should Lose" },
      ...Array.from({ length: 50 }, (_, i) => ({ id: `remote.act.${i}`, title: `Remote ${i}` })),
    ];
    try {
      listeners.get("openidea://settings/actions")!({ payload: batch });
      // 50 remote actions register in a single store update instead of 50.
      expect(updates).toBe(1);
      expect(getAction("local.win")?.title).toBe("Local");
      expect(getAction("remote.act.49")?.title).toBe("Remote 49");

      await executeAction("remote.act.3", "arg3");
      expect(emitTo).toHaveBeenCalledWith("main", "openidea://settings/exec", { id: "remote.act.3", arg: "arg3" });

      // Re-syncing disposes previous proxies in 1 update and registers the new list in 1 update.
      listeners.get("openidea://settings/actions")!({ payload: [{ id: "remote.act.0", title: "Updated 0" }] });
      expect(updates).toBe(3);
      expect(getAction("remote.act.49")).toBeUndefined();
      expect(getAction("remote.act.0")?.title).toBe("Updated 0");
    } finally {
      off();
      dispose();
      disposeLocal();
    }
  });
});

describe("settings window editor bridge", () => {
  it("forwards editorService().openFile from the settings window to the parent and restores on dispose", async () => {
    emitTo.mockClear();
    const previous = maybeEditorService();
    const dispose = installEditorProxy("main");
    try {
      await editorService().openFile("/Users/dev/.copilot/skills/azure-storage/SKILL.md", { focus: true });
      expect(emitTo).toHaveBeenCalledWith("main", "openidea://settings/open-file", {
        path: "/Users/dev/.copilot/skills/azure-storage/SKILL.md",
        options: { focus: true },
      });
    } finally {
      dispose();
    }
    expect(maybeEditorService()).toBe(previous);
  });

  it("opens forwarded files in the parent project window and focuses it", async () => {
    windowControls.label = "main";
    windowControls.unminimize.mockClear();
    windowControls.show.mockClear();
    windowControls.setFocus.mockClear();
    const openFile = vi.fn(async () => {});
    const previous = maybeEditorService();
    provideEditorService({ openFile } as unknown as EditorService);
    useProject.setState({ project: { root: "/repo", name: "repo", trusted: true, isGit: true } as ProjectInfo });
    const dispose = installSettingsHost();
    try {
      await vi.waitFor(() => expect(listeners.has("openidea://settings/open-file")).toBe(true));
      listeners.get("openidea://settings/open-file")!({
        payload: { path: "/Users/dev/.copilot/skills/azure-storage/SKILL.md", options: { focus: true } },
      });
      await vi.waitFor(() =>
        expect(openFile).toHaveBeenCalledWith("/Users/dev/.copilot/skills/azure-storage/SKILL.md", { focus: true }),
      );
      await vi.waitFor(() => expect(windowControls.setFocus).toHaveBeenCalledTimes(1));
    } finally {
      dispose();
      provideEditorService(previous);
      useProject.setState({ project: null, lightEdit: false });
      windowControls.label = "settings-main";
    }
  });

  it("notifies the user when opening a forwarded file fails in the parent window", async () => {
    windowControls.label = "main";
    const openFile = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const notify = vi.fn();
    const previousEditor = maybeEditorService();
    const previousNotifications = notifications();
    provideEditorService({ openFile } as unknown as EditorService);
    provideNotificationService({ notify });
    useProject.setState({ project: { root: "/repo", name: "repo", trusted: true, isGit: true } as ProjectInfo });
    const dispose = installSettingsHost();
    try {
      await vi.waitFor(() => expect(listeners.has("openidea://settings/open-file")).toBe(true));
      listeners.get("openidea://settings/open-file")!({
        payload: { path: "/Users/dev/.copilot/skills/azure-storage/SKILL.md", options: { focus: true } },
      });
      await vi.waitFor(() =>
        expect(notify).toHaveBeenCalledWith(
          expect.objectContaining({
            level: "error",
            body: "permission denied",
            key: "app.open:/Users/dev/.copilot/skills/azure-storage/SKILL.md",
          }),
        ),
      );
    } finally {
      dispose();
      provideEditorService(previousEditor);
      provideNotificationService(previousNotifications);
      useProject.setState({ project: null, lightEdit: false });
      windowControls.label = "settings-main";
    }
  });

  it("falls back to file.openPaths when the parent is on the Welcome screen", async () => {
    windowControls.label = "main";
    windowControls.setFocus.mockClear();
    useProject.setState({ project: null, lightEdit: false });
    const openPaths = vi.fn(async () => {
      useProject.setState({ lightEdit: true });
    });
    const disposeAction = registerAction({ id: "file.openPaths", title: "Open Paths", run: openPaths });
    const disposeHost = installSettingsHost();
    try {
      await vi.waitFor(() => expect(listeners.has("openidea://settings/open-file")).toBe(true));
      listeners.get("openidea://settings/open-file")!({
        payload: { path: "/Users/dev/.copilot/skills/azure-storage/SKILL.md", options: { focus: true } },
      });
      await vi.waitFor(() =>
        expect(openPaths).toHaveBeenCalledWith(
          expect.objectContaining({ arg: ["/Users/dev/.copilot/skills/azure-storage/SKILL.md"] }),
        ),
      );
      await vi.waitFor(() => expect(windowControls.setFocus).toHaveBeenCalledTimes(1));
    } finally {
      disposeHost();
      disposeAction();
      useProject.setState({ project: null, lightEdit: false });
      windowControls.label = "settings-main";
    }
  });
});
