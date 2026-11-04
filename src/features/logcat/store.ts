/**
 * Logcat tool window state: the device being watched, the lines streamed from it
 * and the filters over them. The stream itself lives in the view (one per window).
 */
import { create } from "zustand";
import type { AndroidDevice, LogcatLevel, LogcatLine } from "@/platform/ipc";

/** Kept lines; a chatty device must not grow the buffer without bound. */
export const MAX_LINES = 20_000;

export type LogcatStatus = "idle" | "running" | "error";

/** A line plus the identity the list needs: the buffer drops old lines from the
 * front, so the index is not stable. */
export interface LogcatRow extends LogcatLine {
  id: number;
}

interface LogcatState {
  devices: AndroidDevice[];
  devicesError: string | null;
  loadingDevices: boolean;
  /** `adb -s` value of the device being watched. */
  serial: string | null;
  /** Drop lines below this level. */
  level: LogcatLevel;
  /** Substring of the tag or message, or `#pid`. */
  query: string;
  /** Freeze the view: lines keep arriving but are only applied when resumed. */
  paused: boolean;
  follow: boolean;
  status: LogcatStatus;
  error: string | null;
  lines: LogcatRow[];
}

export const useLogcat = create<LogcatState>(() => ({
  devices: [],
  devicesError: null,
  loadingDevices: false,
  serial: null,
  level: "verbose",
  query: "",
  paused: false,
  follow: true,
  status: "idle",
  error: null,
  lines: [],
}));

/** Lines received while paused, applied on resume. */
let pending: LogcatRow[] = [];

/** Row ids keep growing: a reopened window's stale keys can never collide. */
let nextId = 0;

function push(lines: LogcatRow[], batch: LogcatRow[]): LogcatRow[] {
  const next = lines.concat(batch);
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

/**
 * Applies a stream batch. While paused the lines wait in `pending` instead, so
 * resuming shows what happened meanwhile rather than a hole.
 */
export function appendLines(batch: LogcatLine[]) {
  const rows = batch.map((line) => ({ ...line, id: ++nextId }));
  const { paused } = useLogcat.getState();
  if (paused) {
    pending = pending.concat(rows);
    if (pending.length > MAX_LINES) pending = pending.slice(pending.length - MAX_LINES);
    return;
  }
  useLogcat.setState((s) => ({ lines: push(s.lines, rows) }));
}

export function setPaused(paused: boolean) {
  if (!paused && pending.length) {
    const lines = pending;
    pending = [];
    useLogcat.setState((s) => ({ lines: push(s.lines, lines), paused }));
    return;
  }
  useLogcat.setState({ paused });
}

export function clearLines() {
  pending = [];
  useLogcat.setState({ lines: [] });
}

/** Takes a fresh device list, keeping the watched device while it is still there. */
export function setDevices(devices: AndroidDevice[]) {
  const { serial } = useLogcat.getState();
  const usable = (d: AndroidDevice) => d.state === "device";
  const keep = serial !== null && devices.some((d) => d.serial === serial && usable(d));
  useLogcat.setState({
    devices,
    devicesError: null,
    loadingDevices: false,
    serial: keep ? serial : (devices.find(usable)?.serial ?? null),
  });
}

export function setDevicesError(message: string) {
  useLogcat.setState({ devicesError: message, loadingDevices: false });
}

export function setStatus(status: LogcatStatus, error: string | null = null) {
  useLogcat.setState({ status, error });
}

export function resetLogcat() {
  pending = [];
  useLogcat.setState({
    devices: [],
    devicesError: null,
    loadingDevices: false,
    serial: null,
    paused: false,
    status: "idle",
    error: null,
    lines: [],
  });
}
