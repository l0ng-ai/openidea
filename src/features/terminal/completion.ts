/**
 * Terminal command completion (#3712): a command the shell integration marked
 * with OSC 133 C … D is an attention event when it ran long, failed, or the
 * tab cannot be seen. The decision is Settings › Notifications › Terminal's
 * completion mode plus a watched check; the notification goes through the
 * normal balloons (and, in the background, the OS toasts they mirror to).
 */
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";

export type TerminalCompletionMode = "off" | "longRunning" | "all";

export interface CompletionInfo {
  /** Wall-clock time from OSC 133 C to D. */
  durationMs: number;
  /** Exit status of `OSC 133;D;<status>`; null when the shell sent none. */
  exitCode: number | null;
  /** Ctrl-C was typed while this command ran. */
  interrupted: boolean;
}

export interface CompletionPrefs {
  mode: TerminalCompletionMode;
  /** Mode `longRunning`: a command must run at least this long to notify. */
  thresholdMs: number;
}

export interface CompletionAlert {
  level: "info" | "warning";
  body: string;
}

/** Settings › Notifications › Terminal (raw settings: the terminal does not depend on the settings feature). */
export function completionPrefs(): CompletionPrefs {
  const n = useProject.getState().settings?.notifications;
  const mode: TerminalCompletionMode =
    n?.terminalCompletion === "off" || n?.terminalCompletion === "all" ? n.terminalCompletion : "longRunning";
  const seconds = n?.terminalThresholdSeconds;
  const thresholdMs = (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 1 ? seconds : 10) * 1000;
  return { mode, thresholdMs };
}

/**
 * Whether a finished command is worth telling the user about, and how. A
 * failure notifies however briefly it ran; anything at all only when the tab
 * cannot be seen (a watched terminal answers itself), and a command stopped
 * with Ctrl-C never counts as finished.
 */
export function completionAlert(
  prefs: CompletionPrefs,
  info: CompletionInfo,
  watched: boolean,
): CompletionAlert | null {
  if (prefs.mode === "off" || info.interrupted || watched) return null;
  if (info.exitCode !== null && info.exitCode !== 0)
    return { level: "warning", body: tx`Exited with code ${info.exitCode}` };
  if (prefs.mode === "longRunning" && info.durationMs < prefs.thresholdMs) return null;
  return { level: "info", body: tx("Finished") };
}

/**
 * Raises the notification. `key` is per terminal session, so a tab's next
 * command replaces the previous notice instead of piling up.
 */
export function raiseCompletionNotification(
  sessionKey: string,
  title: string,
  alert: CompletionAlert,
  show: () => void,
) {
  notifications().notify({
    group: "terminal",
    level: alert.level,
    key: `terminal-done-${sessionKey}`,
    // The title is the tab's own (a command or app title), not UI text.
    title,
    body: alert.body,
    verbatim: true,
    actions: [{ label: tx("Show"), run: show }],
  });
}
