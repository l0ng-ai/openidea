/**
 * Update check and install. Both run as background tasks in the status bar: the
 * check while the request is out, the install with download progress and Cancel.
 * Their balloons show the progress too (the welcome screen has no status bar).
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
  ideEventsReady,
  onIdeEvent,
  nextRequestId,
  type UpdateInfo,
  type UpdateProgress,
  type UpdateSource,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { recordInstalledUpdate } from "@/platform/releaseNotes";
import { updateSource } from "@/platform/updateSource";
import { notifications } from "@/workbench/contributions";
import { upsertTask } from "@/workbench/tasks";
import { UpdateBalloonBody } from "./UpdateBalloonBody";

export const UPDATE_KEY = "app.update";
export const CHECK_TASK_ID = "app.update.check";
export const INSTALL_TASK_ID = "app.update.install";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

const SOURCE_NAMES: Record<UpdateSource, string> = { github: "GitHub", cnb: "CNB" };

/** Makes `source` the update source; the retry it precedes uses it even if saving fails. */
async function chooseSource(source: UpdateSource) {
  try {
    useProject.setState({
      settings: await call(commands.settingsSet("global", "general.updateSource", JSON.stringify(source))),
    });
  } catch {
    /* the choice still applies to this retry */
  }
}

/**
 * Offered once a download failed or was cancelled (likely too slow): the same install from
 * the other source. A check never needs it, since it already falls back to the other source.
 */
function otherSourceAction(version: string, source: UpdateSource, notes: string | null) {
  const other: UpdateSource = source === "cnb" ? "github" : "cnb";
  return {
    label: t("app.update.retryWith", { source: SOURCE_NAMES[other] }),
    run: () => void chooseSource(other).then(() => installUpdate(version, other, notes)),
  };
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
  // No status bar (the welcome screen): the balloon is the only place the check can show.
  const { project, lightEdit } = useProject.getState();
  if (!installing && !project && !lightEdit)
    notifications().notify({
      level: "info",
      title,
      body: <UpdateBalloonBody task={CHECK_TASK_ID} />,
      key: UPDATE_KEY,
      userInitiated: true,
    });
  try {
    const r = await Promise.race([call(commands.appCheckUpdate(updateSource())), abandoned]);
    if (r === "cancelled") return;
    if (!r.enabled) {
      notifications().notify({
        level: "info",
        title: t("app.update.disabled"),
        body: t("app.update.disabledBody"),
        key: UPDATE_KEY,
        userInitiated: true,
      });
    } else if (!r.update) {
      const info = await commands.appBuildInfo();
      notifications().notify({
        level: "info",
        title: t("app.update.none", { version: info.version }),
        key: UPDATE_KEY,
        userInitiated: true,
      });
    } else if (!installing) {
      await notifyUpdate(r.update, true);
    }
  } catch (e) {
    notifications().notify({
      level: "error",
      title: t("app.update.failed"),
      body: errorText(e),
      key: UPDATE_KEY,
      userInitiated: true,
    });
  } finally {
    upsertTask({ id: CHECK_TASK_ID, title, message: null, fraction: 1, done: true });
  }
}

const NIGHTLY_PROMPT_KEY = "openidea.update.nightlyPromptedAt";
const NIGHTLY_PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Nightly builds come out more often than anyone wants to be asked: at most one prompt a day. */
function nightlyPromptDue(now = Date.now()): boolean {
  const last = Number(localStorage.getItem(NIGHTLY_PROMPT_KEY));
  if (now - last < NIGHTLY_PROMPT_INTERVAL_MS) return false;
  localStorage.setItem(NIGHTLY_PROMPT_KEY, String(now));
  return true;
}

/** Start one backend schedule after this window can receive its notifications. */
export function installUpdateChecks(): () => void {
  let disposed = false;
  const off = onIdeEvent("updateAvailable", ({ update }) => {
    if (!installing) void notifyUpdate(update);
  });
  void ideEventsReady().then(() => {
    if (!disposed && isTauri())
      void call(commands.appUpdateWindowReady(true, navigator.language)).catch((e) =>
        console.warn("cannot start update checks", e),
      );
  });
  return () => {
    disposed = true;
    off();
    if (isTauri()) void call(commands.appUpdateWindowReady(false, navigator.language)).catch(() => {});
  };
}

/** The balloon shows the first paragraph; the whole notes belong to the What's New page. */
function updateSummary(notes: string | null): string | undefined {
  const text = notes?.trim();
  if (!text) return undefined;
  const paragraph = text.split(/\r?\n\s*\r?\n/)[0]?.trim() || text;
  return paragraph.length > 300 ? paragraph.slice(0, 300).trimEnd() + "…" : paragraph;
}

/** `userInitiated`: the update came from a manual check, so it pops up regardless of the balloon settings. */
export async function notifyUpdate(update: UpdateInfo, userInitiated = false): Promise<void> {
  if (isTauri()) {
    const claimed = await call(commands.appUpdateAnnouncement(update.version, !userInitiated)).catch(
      () => userInitiated,
    );
    if (!claimed) return;
  }
  if (!userInitiated && update.currentVersion.includes("-nightly.") && !nightlyPromptDue()) return;
  notifications().notify({
    level: "info",
    title: t("app.update.available", { version: update.version }),
    body: updateSummary(update.notes ?? null),
    sticky: true,
    key: UPDATE_KEY,
    actions: [
      { label: t("app.update.install"), run: () => void installUpdate(update.version, updateSource(), update.notes) },
    ],
    userInitiated,
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
export function installUpdate(version: string, source = updateSource(), notes: string | null = null): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  installing ??= runInstall(version, source, notes).finally(() => (installing = null));
  return installing;
}

async function runInstall(version: string, source: UpdateSource, notes: string | null) {
  const title = t("app.update.downloading", { version });
  const request = nextRequestId();
  const cancel = () => void commands.cancelRequest(request).catch(() => {});
  const channel = new Channel<UpdateProgress>();
  const balloon = (actions?: Array<{ label: string; run: () => void }>) =>
    notifications().notify({
      level: "info",
      title,
      body: <UpdateBalloonBody task={INSTALL_TASK_ID} />,
      sticky: true,
      key: UPDATE_KEY,
      actions,
      userInitiated: true,
    });
  let installingShown = false;
  channel.onmessage = (p) => {
    const { message, fraction } = progressText(p);
    if (p.type === "installing" && !installingShown) {
      installingShown = true;
      balloon();
    }
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
  upsertTask({ id: INSTALL_TASK_ID, title, message: null, fraction: null, done: false, cancel });
  // Replaces the notification whose action is now spent.
  balloon([{ label: t("app.update.cancel"), run: cancel }]);
  try {
    await call(commands.appInstallUpdate(source, request, channel));
  } catch (e) {
    if (isCancelled(e)) {
      notifications().notify({
        level: "info",
        title: t("app.update.cancelled"),
        key: UPDATE_KEY,
        actions: [otherSourceAction(version, source, notes)],
        userInitiated: true,
      });
    } else {
      notifications().notify({
        level: "error",
        title: t("app.update.installFailed"),
        body: errorText(e),
        key: UPDATE_KEY,
        actions: [
          { label: t("app.update.retry"), run: () => void installUpdate(version, source, notes) },
          otherSourceAction(version, source, notes),
        ],
        userInitiated: true,
      });
    }
    return;
  } finally {
    upsertTask({ id: INSTALL_TASK_ID, title, message: null, fraction: 1, done: true });
  }
  // The restarted app reads this to show the What's New page of the version it now runs.
  recordInstalledUpdate(version, notes);
  const restart = () => void commands.appRestart();
  // Stays if a window cancels the restart (unsaved changes): the update applies on the next start.
  notifications().notify({
    level: "info",
    title: t("app.update.installed", { version }),
    body: t("app.update.installedBody"),
    sticky: true,
    key: UPDATE_KEY,
    actions: [{ label: t("app.update.restart"), run: restart }],
    userInitiated: true,
  });
  restart();
}
