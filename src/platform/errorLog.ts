/**
 * Uncaught errors and unhandled promise rejections of this window go to the log file
 * (target `frontend`), so the log attached to a report shows what failed in the UI.
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { commands, isTauri } from "./ipc";

/** Per window session: a loop of the same failure must not flood the log. */
const MAX_REPORTS = 50;

export function describeError(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack?.includes(reason.message) ? reason.stack : `${reason}\n${reason.stack ?? ""}`;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

/** A caught error worth keeping: shown in the console and written to the log file. */
export function logError(context: string, reason: unknown): void {
  console.error(context, reason);
  if (isTauri()) void commands.logFrontend("error", `${context}: ${describeError(reason).trim()}`).catch(() => {});
}

/** Installs the handlers; returns their disposer. Outside the desktop app it does nothing. */
export function installErrorLogging(): () => void {
  if (!isTauri()) return () => {};
  let label = "?";
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    /* no window: keep "?" */
  }
  let sent = 0;
  let last = "";
  const report = (kind: string, reason: unknown) => {
    const message = `[${label}] ${kind}: ${describeError(reason).trim()}`;
    if (message === last || sent >= MAX_REPORTS) return;
    last = message;
    sent++;
    void commands.logFrontend("error", message).catch(() => {});
  };
  const onError = (e: ErrorEvent) => report("uncaught error", e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => report("unhandled rejection", e.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
