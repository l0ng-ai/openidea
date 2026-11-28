import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, () => void>();
const settingsSyncNow = vi.fn();
const settingsSyncHasLocalChanges = vi.fn();

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    onIdeEvent: (type: string, handler: () => void) => {
      listeners.set(type, handler);
      return () => listeners.delete(type);
    },
    commands: {
      ...actual.commands,
      settingsSyncNow,
      settingsSyncHasLocalChanges,
      pluginList: () => Promise.resolve({ status: "ok", data: { plugins: [] } }),
    },
  };
});

const { claimAutoSync, installAutoSync, newlyOffered, syncedStorage, writeSyncedStorage } =
  await import("../settingsSync");
const { useProject } = await import("@/platform/project");

describe("Settings Sync storage", () => {
  it("splits IDE state by category and keeps project-scoped entries out", () => {
    expect(
      syncedStorage({
        "openidea.liveTemplates.v1": "[]",
        "openidea.fileTemplates.v1.project:/p": "{}",
        "openidea.macros.v1": "{}",
        "openidea.projectTree.options": "{}",
      }),
    ).toEqual({
      templates: { "openidea.liveTemplates.v1": "[]" },
      macros: { "openidea.macros.v1": "{}" },
      ui: { "openidea.projectTree.options": "{}" },
    });
  });

  it("replaces only the changed categories and never writes other keys", () => {
    localStorage.clear();
    localStorage.setItem("openidea.macros.v1", "old");
    localStorage.setItem("openidea.postfix.v1", "mine");
    localStorage.setItem("openidea.projectTree.options", "gone");
    const sent = syncedStorage();
    writeSyncedStorage(
      { ui: { "openidea.vim.v1": "on", "openidea.recentProjects": "x" }, macros: { "openidea.macros.v1": "new" } },
      sent,
      localStorage,
    );
    expect(localStorage.getItem("openidea.macros.v1")).toBe("new");
    expect(localStorage.getItem("openidea.postfix.v1")).toBe("mine");
    expect(localStorage.getItem("openidea.projectTree.options")).toBeNull();
    expect(localStorage.getItem("openidea.vim.v1")).toBe("on");
    expect(localStorage.getItem("openidea.recentProjects")).toBeNull();
  });

  it("keeps what changed here while the sync ran", () => {
    localStorage.clear();
    localStorage.setItem("openidea.toolWindowLayouts.v1", "before");
    localStorage.setItem("openidea.projectTree.options", "before");
    const sent = syncedStorage();
    localStorage.setItem("openidea.toolWindowLayouts.v1", "edited during the sync");
    localStorage.setItem("openidea.vim.v1", "added during the sync");
    writeSyncedStorage(
      { ui: { "openidea.toolWindowLayouts.v1": "remote", "openidea.vim.v1": "remote" } },
      sent,
      localStorage,
    );
    expect(localStorage.getItem("openidea.toolWindowLayouts.v1")).toBe("edited during the sync");
    expect(localStorage.getItem("openidea.vim.v1")).toBe("added during the sync");
    expect(localStorage.getItem("openidea.projectTree.options")).toBeNull();
  });
});

describe("automatic Settings Sync", () => {
  it("runs once for windows that ask at about the same time", () => {
    localStorage.clear();
    expect(claimAutoSync(60_000, 1_000_000)).toBe(true);
    expect(claimAutoSync(60_000, 1_030_000)).toBe(false);
    expect(claimAutoSync(5_000, 1_036_000)).toBe(true);
    expect(claimAutoSync(5_000, 1_038_000)).toBe(false);
    // The clock went back: the stored time is ahead, and expired.
    expect(claimAutoSync(60_000, 900_000)).toBe(true);
  });

  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  const synced = {
    result: { needsChoice: false, overwritten: [], settingsChanged: false, storage: {}, pluginsElsewhere: {} },
    settings: null,
  };
  let dispose = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    settingsSyncNow.mockReset().mockImplementation(() => ok(synced));
    settingsSyncHasLocalChanges.mockReset().mockImplementation(() => ok(true));
    useProject.setState({
      settings: { settingsSync: { repository: "git@example.test:me/s.git", auto: true } } as never,
    });
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("syncs once on startup and 30 seconds after the last change, without asking for credentials", async () => {
    dispose = installAutoSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSyncNow).toHaveBeenCalledTimes(1);
    expect(settingsSyncNow.mock.calls[0]?.[2]).toBe(false);
    useProject.setState({});
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSyncNow).toHaveBeenCalledTimes(1);

    listeners.get("settingsChanged")!();
    await vi.advanceTimersByTimeAsync(20_000);
    listeners.get("settingsChanged")!();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settingsSyncNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settingsSyncNow).toHaveBeenCalledTimes(2);
  });

  it("stays off the network when nothing that syncs changed", async () => {
    dispose = installAutoSync();
    await vi.advanceTimersByTimeAsync(0);
    settingsSyncHasLocalChanges.mockImplementation(() => ok(false));
    listeners.get("settingsChanged")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settingsSyncHasLocalChanges).toHaveBeenCalledTimes(1);
    expect(settingsSyncNow).toHaveBeenCalledTimes(1);
  });

  it("syncs again after a sync that was running when the settings changed", async () => {
    let finish = () => {};
    settingsSyncNow.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ status: "ok", data: synced }))),
    );
    dispose = installAutoSync();
    await vi.advanceTimersByTimeAsync(0);
    listeners.get("settingsChanged")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settingsSyncNow).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSyncNow).toHaveBeenCalledTimes(2);
  });
});

describe("plugins from other computers", () => {
  it("offers each plugin once", () => {
    localStorage.clear();
    expect(newlyOffered({ "a.one": "One" }, false)).toEqual(["a.one"]);
    expect(newlyOffered({ "a.one": "One", "a.two": "Two" })).toEqual(["a.one", "a.two"]);
    expect(newlyOffered({ "a.one": "One", "a.two": "Two" })).toEqual([]);
    expect(newlyOffered({ "a.two": "Two", "b.three": "Three" })).toEqual(["b.three"]);
  });
});
