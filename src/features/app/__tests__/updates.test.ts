import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
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
const appUpdateWindowReady = vi.fn(async (_ready: boolean, _systemLocale: string) => ({ status: "ok", data: null }));
const appUpdateAnnouncement = vi.fn(async () => ({ status: "ok", data: true }));
const updateListeners = new Map<string, (event: { update: UpdateInfo }) => void>();
const appRestart = vi.fn(async () => null);
const cancelRequest = vi.fn(async () => null);
const appBuildInfo = vi.fn(async () => ({ version: "0.1.21" }));
const settingsSet = vi.fn(async () => ({ status: "ok", data: { general: {}, appearance: {} } }));
const recordInstalledUpdate = vi.fn();

vi.mock("@/platform/releaseNotes", () => ({ recordInstalledUpdate }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    ideEventsReady: async () => {},
    onIdeEvent: (type: string, handler: (event: { update: UpdateInfo }) => void) => {
      updateListeners.set(type, handler);
      return () => updateListeners.delete(type);
    },
    commands: {
      ...actual.commands,
      appInstallUpdate,
      appCheckUpdate,
      appUpdateWindowReady,
      appUpdateAnnouncement,
      appRestart,
      cancelRequest,
      appBuildInfo,
      settingsSet,
    },
  };
});

const {
  checkForUpdates,
  installUpdateChecks,
  installUpdate,
  notifyUpdate,
  progressText,
  CHECK_TASK_ID,
  INSTALL_TASK_ID,
  UPDATE_KEY,
} = await import("../updates");
const { provideNotificationService } = await import("@/workbench/contributions");
const { updateSource } = await import("@/platform/updateSource");
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
    expect(recordInstalledUpdate).toHaveBeenCalledWith("0.1.22", null);
    const installed = notes.at(-1)!;
    expect(installed).toMatchObject({ title: "OpenIDEA 0.1.22 is installed", key: UPDATE_KEY, sticky: true });
    installed.actions![0]!.run();
    expect(appRestart).toHaveBeenCalledTimes(2);
  });

  it("puts only the first paragraph in the balloon, the page keeps the whole notes", async () => {
    const longNotes = "A short summary.\n\n## What's new\n\n- " + "detail ".repeat(80);
    await notifyUpdate({ version: "0.1.22", currentVersion: "0.1.21", notes: longNotes, date: null });
    expect(notes.at(-1)?.body).toBe("A short summary.");

    notes.at(-1)!.actions![0]!.run();
    install.resolve(ok(null));
    await tick();
    expect(recordInstalledUpdate).toHaveBeenCalledWith("0.1.22", longNotes);
  });

  it("remembers the notes of the update it installed, for the page after the restart", async () => {
    await notifyUpdate({ version: "0.1.22", currentVersion: "0.1.21", notes: "## Fixed\n- a crash", date: null });
    notes[0]!.actions![0]!.run();
    install.resolve(ok(null));
    await tick();
    expect(recordInstalledUpdate).toHaveBeenCalledWith("0.1.22", "## Fixed\n- a crash");
  });

  it("joins the running install on repeated clicks (balloon, log entry, a second check)", async () => {
    await notifyUpdate({ version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null });
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
    expect(recordInstalledUpdate).not.toHaveBeenCalled();
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
  describe.each(["welcome", "lightEdit", "project"])("visible answers in %s windows", (windowKind) => {
    describe.each(["logged", "unlogged", "maximized"])("%s notifications", (mode) => {
      it.each(["available", "none", "error"])(
        "shows %s with a saved Notifications layout and popups off",
        async (outcome) => {
          const { notificationServiceImpl, useNotifications, dismissBalloon } =
            await import("@/workbench/notificationStore");
          const { Balloons, NotificationsToolWindow } = await import("@/workbench/Notifications");
          const { registerToolWindow } = await import("@/workbench/contributions");
          const { useToolWindowLayout } = await import("@/workbench/toolwindows/store");
          const previousLayout = useToolWindowLayout.getState();
          const dispose = registerToolWindow({
            id: "notifications",
            title: "Notifications",
            icon: "bell",
            anchor: "right",
            component: NotificationsToolWindow,
          });
          // A maximized side needs a registered window, or the layout treats it as stale.
          const disposeLeft =
            mode === "maximized"
              ? registerToolWindow({
                  id: "project",
                  title: "Project",
                  icon: "folder",
                  anchor: "left",
                  component: () => null,
                })
              : () => {};
          useProject.setState({
            project: windowKind === "project" ? ({ root: "/p", name: "p" } as never) : null,
            lightEdit: windowKind === "lightEdit",
            settings: {
              notifications: { balloons: false, groups: { updates: { display: "none", log: mode !== "unlogged" } } },
            } as unknown as Settings,
          });
          useToolWindowLayout.setState({
            visible: {
              ...previousLayout.visible,
              right: "notifications",
              ...(mode === "maximized" ? { left: "project" } : {}),
            },
            maximized: mode === "maximized" ? "left" : null,
          });
          useNotifications.setState({ items: [] });
          provideNotificationService(notificationServiceImpl);
          const view = render(createElement(Balloons));
          const list =
            windowKind === "project"
              ? render(createElement("div", { hidden: mode === "maximized" }, createElement(NotificationsToolWindow)))
              : null;
          try {
            // A dismissed answer with the same key must not hide a later manual result.
            const { notify } = await import("@/workbench/notificationStore");
            act(() =>
              dismissBalloon(notify({ level: "info", title: "Old update", key: UPDATE_KEY, userInitiated: true })),
            );
            await act(async () => {
              const done = checkForUpdates();
              check.resolve(
                outcome === "error"
                  ? { status: "error", error: { kind: "unavailable", message: "offline" } }
                  : ok({
                      enabled: true,
                      update:
                        outcome === "available"
                          ? { version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null }
                          : null,
                    }),
              );
              await done;
            });
            const title =
              outcome === "error"
                ? "Update check failed"
                : outcome === "available"
                  ? "OpenIDEA 0.1.22 is available"
                  : "OpenIDEA 0.1.21 is up to date";
            const answer = screen.getByRole(outcome === "error" ? "alert" : "status");
            expect(answer).toBeVisible();
            expect(answer).toHaveTextContent(title);
          } finally {
            view.unmount();
            list?.unmount();
            dispose();
            disposeLeft();
            useNotifications.setState({ items: [] });
            useToolWindowLayout.setState(previousLayout);
          }
        },
      );
    });
  });

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

  it("does not consume an announcement when a manual check is cancelled", async () => {
    const done = checkForUpdates();
    task(CHECK_TASK_ID)!.cancel!();
    await done;
    check.resolve(
      ok({ enabled: true, update: { version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null } }),
    );
    await tick();
    expect(appUpdateAnnouncement).not.toHaveBeenCalled();
    await notifyUpdate({ version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null });
    expect(appUpdateAnnouncement).toHaveBeenCalledWith("0.1.22", true);
    expect(notes.at(-1)?.title).toBe("OpenIDEA 0.1.22 is available");
  });

  it("suppresses an already announced automatic version but still answers a manual check", async () => {
    const update = { version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null };
    appUpdateAnnouncement.mockResolvedValueOnce({ status: "ok", data: false });
    await notifyUpdate(update);
    expect(notes).toHaveLength(0);
    await notifyUpdate(update, true);
    expect(appUpdateAnnouncement).toHaveBeenLastCalledWith("0.1.22", false);
    expect(notes.at(-1)).toMatchObject({ title: "OpenIDEA 0.1.22 is available", userInitiated: true });
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

  it("starts the process scheduler after subscribing and leaves automatic results to notification settings", async () => {
    const dispose = installUpdateChecks();
    await tick();
    expect(appUpdateWindowReady).toHaveBeenCalledTimes(1);
    updateListeners.get("updateAvailable")!({
      update: { version: "0.1.22", currentVersion: "0.1.21", notes: null, date: null },
    });
    await tick();
    expect(notes.at(-1)).toMatchObject({ title: "OpenIDEA 0.1.22 is available", userInitiated: false });
    dispose();
    expect(updateListeners.has("updateAvailable")).toBe(false);
  });

  it("does not start a schedule after its window has been disposed", async () => {
    const dispose = installUpdateChecks();
    dispose();
    await tick();
    expect(appUpdateWindowReady).not.toHaveBeenCalledWith(true, expect.anything());
    expect(appUpdateWindowReady).toHaveBeenCalledWith(false, navigator.language);
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

describe("automatic nightly update prompts", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const update = (currentVersion: string): UpdateInfo => ({
    version: "0.1.41",
    currentVersion,
    notes: null,
    date: null,
  });
  const startupCheck = async (currentVersion: string) => {
    notes = [];
    await notifyUpdate(update(currentVersion));
    return notes.length;
  };

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"], now: 10 * DAY });
  });
  afterEach(() => vi.useRealTimers());

  it("leaves stable prompts to the backend announcement policy", async () => {
    expect(await startupCheck("0.1.40")).toBe(1);
    expect(await startupCheck("0.1.40")).toBe(1);
  });

  it("asks a nightly build at most once a day", async () => {
    const nightly = "0.1.41-nightly.202611081417";
    expect(await startupCheck(nightly)).toBe(1);
    vi.setSystemTime(11 * DAY - 1);
    expect(await startupCheck(nightly)).toBe(0);
    vi.setSystemTime(11 * DAY);
    expect(await startupCheck(nightly)).toBe(1);
  });

  it("does not prompt twice a day for periodic nightly checks, but always answers a manual check", async () => {
    const nightly = "0.1.41-nightly.202611081417";
    const dispose = installUpdateChecks();
    await tick();
    try {
      const available = updateListeners.get("updateAvailable")!;
      available({ update: update(nightly) });
      await tick();
      expect(notes).toHaveLength(1);
      vi.setSystemTime(10 * DAY + 4 * 60 * 60 * 1000);
      available({ update: { ...update(nightly), version: "0.1.42-nightly.202611090200" } });
      await tick();
      expect(notes).toHaveLength(1);
      const done = checkForUpdates();
      check.resolve(ok({ enabled: true, update: update(nightly) }));
      await done;
      expect(notes.at(-1)).toMatchObject({ title: "OpenIDEA 0.1.41 is available", userInitiated: true });
      notes = [];
      vi.setSystemTime(11 * DAY);
      available({ update: { ...update(nightly), version: "0.1.42-nightly.202611091400" } });
      await tick();
      expect(notes).toHaveLength(1);
    } finally {
      dispose();
    }
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
