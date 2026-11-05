/**
 * The server's recent tool calls (`mcpCallHistory`, most recent first) for the
 * MCP Server tool window and the status bar popup: read when shown, and again on
 * `mcpStatusChanged` (sent at most once a second while calls run).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { commands, isTauri, onIdeEvent, type McpCallOutcome, type McpCallRecord } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

interface CallsState {
  calls: McpCallRecord[];
  loaded: boolean;
  error: string | null;
}

export const useMcpCalls = create<CallsState>(() => ({ calls: [], loaded: false, error: null }));

let pending: Promise<void> | null = null;
let again = false;

/** Reads the history again; a request made while one runs reads once more after it. */
export function refreshCalls(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (pending) {
    again = true;
    return pending;
  }
  pending = commands
    .mcpCallHistory()
    .then(
      (calls) => useMcpCalls.setState({ calls, loaded: true, error: null }),
      (e: unknown) => useMcpCalls.setState({ loaded: true, error: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => {
      pending = null;
      if (again) {
        again = false;
        void refreshCalls();
      }
    });
  return pending;
}

/** Keeps `useMcpCalls` current while the calling component is mounted. */
export function useTrackedCalls(): CallsState {
  useEffect(() => {
    void refreshCalls();
    return onIdeEvent("mcpStatusChanged", () => void refreshCalls());
  }, []);
  return useMcpCalls();
}

export const OUTCOMES: readonly McpCallOutcome[] = ["inProgress", "success", "error", "cancelled", "failed"];

export function outcomeLabel(outcome: McpCallOutcome): string {
  switch (outcome) {
    case "inProgress":
      return tx("In progress");
    case "success":
      return tx("Success");
    case "error":
      return tx("Error");
    case "cancelled":
      return tx("Cancelled");
    case "failed":
      return tx("Failed");
  }
}

/** `StringUtil.formatDuration`-like: `850 ms`, `2.4 s`, `1 m 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} m ${s} s` : `${m} m`;
}

/** The call's start as a time of day with seconds (`DateFormatUtil.formatTimeWithSeconds`). */
export function formatCallTime(ms: number | null): string {
  if (ms == null) return "";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** The arguments as indented JSON when they parse (they are a shortened summary otherwise). */
export function prettyArguments(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** A changed file as the editor opens it: project-relative paths resolve against the call's project. */
export function changedFilePath(file: string, project: string | null): string {
  if (isAbsolute(file) || !project) return file;
  const sep = project.includes("\\") && !project.includes("/") ? "\\" : "/";
  return `${project.replace(/[\\/]+$/, "")}${sep}${file}`;
}
