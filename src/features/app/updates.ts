/**
 * Update check and install. Both run as background tasks in the status bar: the
 * check while the request is out, the install with download progress and Cancel.
 * Every entry point (Help menu, toolbar gear, welcome screen, Search Everywhere,
 * the "is available" notification and its log entry) goes through these, so a
 * repeated click joins the running check or install instead of starting another.
 */
import { Channel } from "@tauri-apps/api/core";
import { t } from "@/platform/i18n";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type UpdateInfo,
  type UpdateProgress,
} from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { upsertTask } from "@/workbench/tasks";

export const UPDATE_KEY = "app.update";
export const CHECK_TASK_ID = "app.update.check";
export const INSTALL_TASK_ID = "app.update.install";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

let checking: Promise<void> | null = null;
let installing: Promise<void> | null = null;

/** Manual update check. Does nothing over the network unless an endpoint is configured. */
export function checkForUpdates(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  checking ??= runCheck().finally(() => (checking = null));
  return checking;
}

async function runCheck() {
  const title = t("app.update.checking");
  // The check only reads: cancelling drops its answer (the request finishes on its own).
  let abandon = () => {};
  const abandoned = new Promise<"cancelled">((resolve) => (abandon = () => resolve("cancelled")));
  upsertTask({ id: CHECK_TASK_ID, title, message: null, fraction: null, done: false, cancel: () => abandon() });
  try {
    const r = await Promise.race([call(commands.appCheckUpdate()), abandoned]);
    if (r === "cancelled") return;
    if (!r.enabled) {
      notifications().notify({
        level: "info",
        title: t("app.update.disabled"),
        body: t("app.update.disabledBody"),
        key: UPDATE_KEY,
      });
    } else if (!r.update) {
      const info = await commands.appBuildInfo();
      notifications().notify({
        level: "info",
        title: t("app.update.none", { version: info.version }),
        key: UPDATE_KEY,
      });
    } else if (!installing) {
      notifyUpdate(r.update);
    }
  } catch (e) {
    notifications().notify({ level: "error", title: t("app.update.failed"), body: errorText(e), key: UPDATE_KEY });
  } finally {
    upsertTask({ id: CHECK_TASK_ID, title, message: null, fraction: 1, done: true });
  }
}

/** Silent check once per app start; only an available update is shown. */
export async function checkForUpdatesOnStartup(): Promise<void> {
  if (!isTauri()) return;
  const update = await commands.appStartupUpdateCheck().catch(() => null);
  if (update) notifyUpdate(update);
}

export function notifyUpdate(update: UpdateInfo) {
  notifications().notify({
    level: "info",
    title: t("app.update.available", { version: update.version }),
    body: update.notes ?? undefined,
    sticky: true,
    key: UPDATE_KEY,
    actions: [{ label: t("app.update.install"), run: () => void installUpdate(update.version) }],
  });
}

function megabytes(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Download progress as the task's message and fraction. */
export function progressText(p: UpdateProgress): { message: string; fraction: number | null } {
  if (p.type === "installing") return { message: t("app.update.installingMessage"), fraction: null };
  const done = p.downloaded ?? 0;
  if (p.total) {
    return {
      message: t("app.update.progress", { done: megabytes(done), total: megabytes(p.total) }),
      fraction: Math.min(1, done / p.total),
    };
  }
  return { message: t("app.update.progressUnknown", { done: megabytes(done) }), fraction: null };
}

/** Downloads and installs `version`, then restarts. A second call while one runs joins it. */
export function installUpdate(version: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  installing ??= runInstall(version).finally(() => (installing = null));
  return installing;
}

async function runInstall(version: string) {
  const title = t("app.update.downloading", { version });
  const request = nextRequestId();
  const cancel = () => void commands.cancelRequest(request).catch(() => {});
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = (p) => {
    const { message, fraction } = progressText(p);
    upsertTask({
      id: INSTALL_TASK_ID,
      title,
      message,
      fraction,
      done: false,
      cancel: p.type === "installing" ? undefined : cancel,
      // Replacing the app happens in one step that must not be cut short.
      uncancellable: p.type === "installing" ? t("app.update.installUncancellable") : undefined,
    });
  };
  // The notification's action is spent: progress lives in the status bar from here.
  notifications().expire?.(UPDATE_KEY);
  upsertTask({ id: INSTALL_TASK_ID, title, message: null, fraction: null, done: false, cancel });
  try {
    await call(commands.appInstallUpdate(request, channel));
  } catch (e) {
    if (!isCancelled(e)) {
      notifications().notify({
        level: "error",
        title: t("app.update.installFailed"),
        body: errorText(e),
        key: UPDATE_KEY,
        actions: [{ label: t("app.update.retry"), run: () => void installUpdate(version) }],
      });
    }
    return;
  } finally {
    upsertTask({ id: INSTALL_TASK_ID, title, message: null, fraction: 1, done: true });
  }
  const restart = () => void commands.appRestart();
  // Stays if a window cancels the restart (unsaved changes): the update applies on the next start.
  notifications().notify({
    level: "info",
    title: t("app.update.installed", { version }),
    body: t("app.update.installedBody"),
    sticky: true,
    key: UPDATE_KEY,
    actions: [{ label: t("app.update.restart"), run: restart }],
  });
  restart();
}
