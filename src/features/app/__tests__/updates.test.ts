import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UpdateCheck, UpdateInfo, UpdateProgress } from "@/bindings";
import type { NotificationService } from "@/workbench/contributions";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (p: unknown) => void = () => {};
  },
}));

type Channel = { onmessage: (p: UpdateProgress) => void };
type Result<T> = { status: "ok"; data: T } | { status: "error"; error: { kind: string; message: string } };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let install: ReturnType<typeof deferred<Result<null>>>;
let check: ReturnType<typeof deferred<Result<UpdateCheck>>>;
let channel: Channel | null;
const appInstallUpdate = vi.fn((_source: string, _request: number, ch: Channel) => {
  channel = ch;
  return install.promise;
});
const appCheckUpdate = vi.fn(() => check.promise);
const appStartupUpdateCheck = vi.fn(async (): Promise<UpdateInfo | null> => null);
const appRestart = vi.fn(async () => null);
const cancelRequest = vi.fn(async () => null);
const appBuildInfo = vi.fn(async () => ({ version: "0.1.21" }));
const settingsSet = vi.fn(async () => ({ status: "ok", data: { general: {}, appearance: {} } }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      appInstallUpdate,
      appCheckUpdate,
      appStartupUpdateCheck,
      appRestart,
      cancelRequest,
      appBuildInfo,
      settingsSet,
    },
  };
});

const {
  checkForUpdates,
  checkForUpdatesOnStartup,
  installUpdate,
  notifyUpdate,
  progressText,
  updateSource,
  CHECK_TASK_ID,
  INSTALL_TASK_ID,
  UPDATE_KEY,
} = await import("../updates");
const { provideNotificationService } = await import("@/workbench/contributions");
const { useProject } = await import("@/platform/project");
const { useTasks } = await import("@/workbench/tasks");

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];
let expired: string[];

const task = (id: string) => useTasks.getState().tasks.find((t) => t.id === id);
const ok = <T>(data: T): Result<T> => ({ status: "ok", data });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  notes = [];
  expired = [];
  channel = null;
  install = deferred();
  check = deferred();
  provideNotificationService({ notify: (n) => void notes.push(n), expire: (k) => void expired.push(k) });
  useTasks.setState({ tasks: [] });
  useProject.setState({ project: null, lightEdit: false, settings: null });
});

afterEach(() => vi.clearAllMocks());

describe("Install and Restart", () => {
  it("runs as a background task with download progress, then restarts", async () => {
    const done = installUpdate("0.1.22");
    expect(notes.at(-1)).toMatchObject({
      title: "Downloading OpenIDEA 0.1.22",
      key: UPDATE_KEY,
      sticky: true,
      userInitiated: true,
    });
    expect(notes.at(-1)!.actions![0]!.label).toBe("Cancel");
    expect(task(INSTALL_TASK_ID)).toMatchObject({ title: "Downloading OpenIDEA 0.1.22", fraction: null, done: false });
    expect(task(INSTALL_TASK_ID)?.cancel).toBeTypeOf("function");

    channel!.onmessage({ type: "downloading", downloaded: 21 * 1024 * 1024, total: 84 * 1024 * 1024 });
    expect(task(INSTALL_TASK_ID)).toMatchObject({ fraction: 0.25, message: "21.0 MB of 84.0 MB" });
    channel!.onmessage({ type: "installing" });
    expect(notes.at(-1)!.actions).toBeUndefined();
    expect(task(INSTALL_TASK_ID)).toMatchObject({ fraction: null, message: "Installing…", cancel: undefined });

    install.resolve(ok(null));
    await done;
    expect(task(INSTALL_TASK_ID)?.done).toBe(true);
    expect(appRestart).toHaveBeenCalledTimes(1);
    const installed = notes.at(-1)!;
    expect(installed).toMatchObject({ title: "OpenIDEA 0.1.22 is installed", key: UPDATE_KEY, sticky: true });
    installed.actions![0]!.run();
    expect(appRestart).toHaveBeenCalledTimes(2);
  });

  it("joins the running install on repeated clicks (balloon, log entry, a second check)", async () => {
    notifyUpdate({ version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null });
    const action = notes[0]!.actions![0]!;
    action.run();
    action.run();
    void installUpdate("0.1.22");
    expect(appInstallUpdate).toHaveBeenCalledTimes(1);

    // A check while installing doesn't offer the install again.
    const checked = checkForUpdates();
    check.resolve(
      ok({ enabled: true, update: { version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null } }),
    );
    await checked;
    expect(notes.map((n) => n.title)).toEqual(["OpenIDEA 0.1.22 is available", "Downloading OpenIDEA 0.1.22"]);

    install.resolve(ok(null));
    await tick();
    action.run();
    expect(appInstallUpdate).toHaveBeenCalledTimes(2);
  });

  it("reports a failure with Retry, and a cancellation", async () => {
    const failed = installUpdate("0.1.22");
    install.resolve({ status: "error", error: { kind: "unavailable", message: "connection reset" } });
    await failed;
    expect(appRestart).not.toHaveBeenCalled();
    expect(task(INSTALL_TASK_ID)?.done).toBe(true);
    expect(notes.at(-1)).toMatchObject({
      level: "error",
      title: "Could not install the update",
      body: "connection reset",
    });
    expect(notes.at(-1)!.actions![0]!.label).toBe("Retry");

    notes = [];
    install = deferred();
    const cancelled = installUpdate("0.1.22");
    task(INSTALL_TASK_ID)!.cancel!();
    expect(cancelRequest).toHaveBeenCalledWith(appInstallUpdate.mock.calls.at(-1)![1]);
    install.resolve({ status: "error", error: { kind: "cancelled", message: "cancelled" } });
    await cancelled;
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Update cancelled", key: UPDATE_KEY });
    expect(appRestart).not.toHaveBeenCalled();
  });

  it.each([
    ["a failed", "unavailable", "github", "CNB", "cnb"],
    ["a failed", "unavailable", "cnb", "GitHub", "github"],
    ["a cancelled (likely slow)", "cancelled", "cnb", "GitHub", "github"],
  ])("offers %s download from %s again from the other source", async (_case, kind, from, label, to) => {
    useProject.setState({ settings: { general: { updateSource: from }, appearance: {} } as unknown as Settings });
    const first = installUpdate("0.1.22");
    install.resolve({ status: "error", error: { kind, message: kind } });
    await first;
    const action = notes.at(-1)!.actions!.at(-1)!;
    expect(action.label).toBe(`Retry with ${label}`);

    install = deferred();
    action.run();
    await tick();
    expect(settingsSet).toHaveBeenCalledWith("global", "general.updateSource", JSON.stringify(to));
    expect(appInstallUpdate.mock.calls.at(-1)![0]).toBe(to);
    install.resolve(ok(null));
    await tick();
  });
});

describe("Check for Updates", () => {
  it("shows a background task while checking and joins a running check", async () => {
    const first = checkForUpdates();
    void checkForUpdates();
    expect(appCheckUpdate).toHaveBeenCalledTimes(1);
    expect(task(CHECK_TASK_ID)).toMatchObject({ title: "Checking for updates…", done: false });
    check.resolve(ok({ enabled: true, update: null }));
    await first;
    expect(task(CHECK_TASK_ID)?.done).toBe(true);
    expect(notes.at(-1)).toMatchObject({ title: "OpenIDEA 0.1.21 is up to date" });
  });

  it.each([
    [ok({ enabled: false, update: null }), "Automatic updates are not configured"],
    [
      ok({ enabled: true, update: { version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null } }),
      "OpenIDEA 0.1.22 is available",
    ],
    [
      { status: "error", error: { kind: "unavailable", message: "offline" } } as Result<UpdateCheck>,
      "Update check failed",
    ],
  ])("always ends in a notification (%#)", async (result, title) => {
    const done = checkForUpdates();
    check.resolve(result);
    await done;
    expect(notes.at(-1)).toMatchObject({ title, userInitiated: true });
    expect(task(CHECK_TASK_ID)?.done).toBe(true);
  });

  it("shows the check in a balloon where there is no status bar (the welcome screen)", async () => {
    const done = checkForUpdates();
    expect(notes[0]).toMatchObject({ level: "info", title: "Checking for updates…", key: UPDATE_KEY });
    check.resolve(ok({ enabled: true, update: null }));
    await done;
    expect(notes.at(-1)).toMatchObject({ title: "OpenIDEA 0.1.21 is up to date", key: UPDATE_KEY });
  });

  it("marks the manual check's progress as the user's own request", async () => {
    const done = checkForUpdates();
    expect(notes[0]).toMatchObject({ level: "info", title: "Checking for updates…", userInitiated: true });
    check.resolve(ok({ enabled: true, update: null }));
    await done;
  });

  it("leaves the startup check to the IDE Updates notification settings", async () => {
    appStartupUpdateCheck.mockResolvedValueOnce({
      version: "0.1.22",
      currentVersion: "0.1.21",
      notes: null,
      date: null,
    });
    await checkForUpdatesOnStartup();
    expect(notes.at(-1)).toMatchObject({ title: "OpenIDEA 0.1.22 is available" });
    expect(notes.at(-1)?.userInitiated).toBe(false);
  });

  it('still pops up when IDE Updates is set to "No popup" (no other surface on the welcome screen)', async () => {
    const { notificationServiceImpl, useNotifications } = await import("@/workbench/notificationStore");
    // What Settings › Notifications › IDE Updates stores for "No popup" (or "Don't Show Again").
    useProject.setState({
      settings: {
        notifications: { balloons: true, groups: { updates: { display: "none", log: true } } },
      } as unknown as Settings,
    });
    useNotifications.setState({ items: [] });
    provideNotificationService(notificationServiceImpl);
    try {
      const done = checkForUpdates();
      try {
        expect(useNotifications.getState().items[0]).toMatchObject({
          key: UPDATE_KEY,
          balloon: true,
          title: "Checking for updates…",
        });
      } finally {
        // Settle the check even when the assertion above fails, so later tests don't join it.
        check.resolve(ok({ enabled: true, update: null }));
        await done;
      }
      expect(useNotifications.getState().items[0]).toMatchObject({
        key: UPDATE_KEY,
        balloon: true,
        title: "OpenIDEA 0.1.21 is up to date",
      });
    } finally {
      useNotifications.setState({ items: [] });
    }
  });

  it("leaves the check to the status bar in a project window", async () => {
    useProject.setState({ project: { root: "/p", name: "p", trusted: true, isGit: false, settings: {} } as never });
    const done = checkForUpdates();
    expect(notes).toHaveLength(0);
    check.resolve(ok({ enabled: true, update: null }));
    await done;
    expect(notes.at(-1)?.title).toBe("OpenIDEA 0.1.21 is up to date");
  });
});

describe("updateSource", () => {
  const withSettings = (updateSource: string | undefined, locale: string | undefined) =>
    useProject.setState({ settings: { general: { updateSource }, appearance: { locale } } as unknown as Settings });

  it.each([
    ["auto", "zh", "cnb"],
    ["auto", "zh-CN", "cnb"],
    ["auto", "en", "github"],
    ["auto", "ko", "github"],
    [undefined, "zh", "cnb"],
    ["github", "zh", "github"],
    ["cnb", "en", "cnb"],
    ["bogus", "en", "github"],
  ])("%s with the %s UI uses %s", (setting, locale, expected) => {
    withSettings(setting, locale);
    expect(updateSource()).toBe(expected);
  });

  it("is passed to the check and the install", async () => {
    withSettings("cnb", "en");
    void checkForUpdates();
    expect(appCheckUpdate).toHaveBeenCalledWith("cnb");
    check.resolve(ok({ enabled: true, update: null }));
    void installUpdate("0.1.22");
    expect(appInstallUpdate.mock.calls.at(-1)![0]).toBe("cnb");
    install.resolve(ok(null));
    await tick();
  });
});

describe("progressText", () => {
  it("formats known and unknown lengths", () => {
    expect(progressText({ type: "downloading", downloaded: 1024 * 1024, total: null })).toEqual({
      message: "1.0 MB",
      fraction: null,
    });
    expect(progressText({ type: "downloading", downloaded: 10, total: 5 }).fraction).toBe(1);
  });
});
