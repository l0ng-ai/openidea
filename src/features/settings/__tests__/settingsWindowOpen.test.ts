import { describe, expect, it, vi } from "vitest";

const logFrontend = vi.hoisted(() => vi.fn(() => Promise.resolve()));
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
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      logFrontend,
      remoteCurrent: () => ok(null),
      projectCurrent: () => ok(null),
      settingsGetGlobal: () => ok({}),
      windowTakeLaunch: () => Promise.resolve(null),
    },
  };
});
vi.mock("../dialog/LazySettingsDialog", () => ({
  LazySettingsDialog: () => null,
  loadBuiltinPages: () => Promise.reject(new Error("page failed")),
  unloadBuiltinPages: () => {},
}));

const { activateSettingsWindow } = await import("..");
const { useSettingsDialog } = await import("../model/staging");

describe("the native Settings window", () => {
  it("opens even when a page fails to register, and logs why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dispose = activateSettingsWindow("main");
    await vi.waitFor(() => expect(useSettingsDialog.getState().open).toBe(true));
    expect(logFrontend).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("cannot register settings pages: Error: page failed"),
    );
    dispose();
  });
});
