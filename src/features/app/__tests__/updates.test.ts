import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheck, UpdateProgress } from "@/bindings";
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
const appInstallUpdate = vi.fn((_request: number, ch: Channel) => {
  channel = ch;
  return install.promise;
});
const appCheckUpdate = vi.fn(() => check.promise);
const appRestart = vi.fn(async () => null);
const cancelRequest = vi.fn(async () => null);
const appBuildInfo = vi.fn(async () => ({ version: "0.1.21" }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, appInstallUpdate, appCheckUpdate, appRestart, cancelRequest, appBuildInfo },
  };
});

const { checkForUpdates, installUpdate, notifyUpdate, progressText, CHECK_TASK_ID, INSTALL_TASK_ID, UPDATE_KEY } =
  await import("../updates");
const { provideNotificationService } = await import("@/workbench/contributions");
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
});

afterEach(() => vi.clearAllMocks());

describe("Install and Restart", () => {
  it("runs as a background task with download progress, then restarts", async () => {
    const done = installUpdate("0.1.22");
    expect(expired).toEqual([UPDATE_KEY]);
    expect(task(INSTALL_TASK_ID)).toMatchObject({ title: "Downloading OpenIDEA 0.1.22", fraction: null, done: false });
    expect(task(INSTALL_TASK_ID)?.cancel).toBeTypeOf("function");

    channel!.onmessage({ type: "downloading", downloaded: 21 * 1024 * 1024, total: 84 * 1024 * 1024 });
    expect(task(INSTALL_TASK_ID)).toMatchObject({ fraction: 0.25, message: "21.0 MB of 84.0 MB" });
    channel!.onmessage({ type: "installing" });
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
    expect(notes).toHaveLength(1);

    install.resolve(ok(null));
    await tick();
    action.run();
    expect(appInstallUpdate).toHaveBeenCalledTimes(2);
  });

  it("reports a failure with Retry, and stays quiet when cancelled", async () => {
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
    expect(cancelRequest).toHaveBeenCalledWith(appInstallUpdate.mock.calls.at(-1)![0]);
    install.resolve({ status: "error", error: { kind: "cancelled", message: "cancelled" } });
    await cancelled;
    expect(notes).toEqual([]);
    expect(appRestart).not.toHaveBeenCalled();
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
    expect(notes.at(-1)?.title).toBe(title);
    expect(task(CHECK_TASK_ID)?.done).toBe(true);
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
