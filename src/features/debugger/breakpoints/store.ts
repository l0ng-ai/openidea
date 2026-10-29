/**
 * Breakpoints of the open project: persisted per project in localStorage and
 * mirrored to the backend (`debugSetBreakpoints`) whenever a file's list changes.
 * The backend keeps them across sessions and returns verification states.
 */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import {
  makeBreakpoint,
  sameEntries,
  sortByLine,
  toBackend,
  toggleLine,
  type BreakpointEntry,
  type BreakpointStatus,
} from "./model";

interface BreakpointState {
  /** Project root the breakpoints belong to (storage key). */
  root: string | null;
  byFile: Record<string, BreakpointEntry[]>;
  /** Verification state by breakpoint id. */
  status: Record<string, BreakpointStatus>;
  muted: boolean;
}

export const useBreakpoints = create<BreakpointState>(() => ({ root: null, byFile: {}, status: {}, muted: false }));

const STORAGE_PREFIX = "openidea.debugger.breakpoints:";

interface Persisted {
  muted?: boolean;
  files?: Record<string, BreakpointEntry[]>;
}

function persist() {
  const { root, byFile, muted } = useBreakpoints.getState();
  if (!root) return;
  try {
    const files = Object.fromEntries(Object.entries(byFile).filter(([, l]) => l.length));
    localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify({ muted, files } satisfies Persisted));
  } catch {
    // Storage full / unavailable: breakpoints just don't survive a restart.
  }
}

function sanitize(raw: unknown): BreakpointEntry[] {
  if (!Array.isArray(raw)) return [];
  return sortByLine(
    raw
      .filter(
        (b): b is BreakpointEntry => !!b && typeof b === "object" && Number.isInteger((b as BreakpointEntry).line),
      )
      .map((b) => ({
        ...makeBreakpoint(b.line),
        ...(typeof b.id === "string" ? { id: b.id } : {}),
        enabled: b.enabled !== false,
        condition: typeof b.condition === "string" ? b.condition : null,
        logMessage: typeof b.logMessage === "string" ? b.logMessage : null,
        hitCondition: typeof b.hitCondition === "string" ? b.hitCondition : null,
        ...(b.temporary === true ? { temporary: true } : {}),
        // Before "Suspend" was its own option, a log message meant "log instead of suspending".
        ...(b.suspend === false || (b.suspend === undefined && typeof b.logMessage === "string" && b.logMessage.trim())
          ? { suspend: false }
          : {}),
        ...(b.logHit === true ? { logHit: true } : {}),
      })),
  );
}

/** Loads the project's breakpoints and pushes them all to the backend. */
export function loadBreakpoints(root: string | null) {
  let byFile: Record<string, BreakpointEntry[]> = {};
  let muted = false;
  if (root) {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_PREFIX + root) ?? "{}") as Persisted;
      muted = !!data.muted;
      for (const [path, list] of Object.entries(data.files ?? {})) {
        const clean = sanitize(list);
        if (clean.length) byFile[path] = clean;
      }
    } catch {
      byFile = {};
    }
  }
  const previous = Object.keys(useBreakpoints.getState().byFile);
  useBreakpoints.setState({ root, byFile, muted, status: {} });
  for (const path of new Set([...previous, ...Object.keys(byFile)])) scheduleSync(path);
}

// --- backend sync -------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Ids in the order last sent per file (backend states are index-aligned). */
const sent = new Map<string, string[]>();
const SYNC_DELAY = 120;

export function scheduleSync(path: string) {
  clearTimeout(timers.get(path));
  timers.set(
    path,
    setTimeout(() => {
      timers.delete(path);
      void syncFile(path);
    }, SYNC_DELAY),
  );
}

export async function syncFile(path: string) {
  if (!isTauri()) return;
  const { byFile, muted } = useBreakpoints.getState();
  const list = byFile[path] ?? [];
  sent.set(
    path,
    list.map((b) => b.id),
  );
  try {
    const states = await call(commands.debugSetBreakpoints(path, toBackend(list, muted, path)));
    applyStates(path, states);
  } catch (e) {
    console.warn("debugSetBreakpoints failed", e);
  }
}

/** Re-reads verification states after a `breakpointsChanged` event. */
export async function refreshStates(path: string) {
  if (!isTauri()) return;
  try {
    applyStates(path, await call(commands.debugBreakpointStates(path)));
  } catch (e) {
    console.warn("debugBreakpointStates failed", e);
  }
}

export function applyStates(path: string, states: Array<{ line: number; verified: boolean; message: string | null }>) {
  const ids = sent.get(path) ?? (useBreakpoints.getState().byFile[path] ?? []).map((b) => b.id);
  useBreakpoints.setState((s) => {
    const status = { ...s.status };
    states.forEach((st, i) => {
      const id = ids[i];
      if (id) status[id] = { verified: st.verified, message: st.message, line: st.line };
    });
    return { status };
  });
}

/** Marks every breakpoint unverified (no session is running). */
export function resetStatuses() {
  useBreakpoints.setState({ status: {} });
}

// --- mutations ----------------------------------------------------------------

function setFile(path: string, list: BreakpointEntry[]) {
  const current = useBreakpoints.getState().byFile[path] ?? [];
  if (sameEntries(current, list)) return;
  useBreakpoints.setState((s) => {
    const byFile = { ...s.byFile };
    if (list.length) byFile[path] = list;
    else delete byFile[path];
    return { byFile };
  });
  persist();
  scheduleSync(path);
}

export function breakpointsOf(path: string): BreakpointEntry[] {
  return useBreakpoints.getState().byFile[path] ?? [];
}

export function toggleBreakpoint(path: string, line: number) {
  setFile(path, toggleLine(breakpointsOf(path), line));
}

export function addBreakpoint(path: string, line: number, props: Partial<Omit<BreakpointEntry, "id" | "line">> = {}) {
  const list = breakpointsOf(path).filter((b) => b.line !== line);
  const bp = makeBreakpoint(line, props);
  setFile(path, sortByLine([...list, bp]));
  return bp;
}

export function updateBreakpoint(path: string, id: string, patch: Partial<Omit<BreakpointEntry, "id">>) {
  setFile(path, sortByLine(breakpointsOf(path).map((b) => (b.id === id ? { ...b, ...patch } : b))));
}

export function removeBreakpoint(path: string, id: string) {
  setFile(
    path,
    breakpointsOf(path).filter((b) => b.id !== id),
  );
}

export function removeAllBreakpoints() {
  for (const path of Object.keys(useBreakpoints.getState().byFile)) setFile(path, []);
}

/** Replaces a file's list after its lines moved with an edit (from the editor gutter). */
export function setFileBreakpoints(path: string, list: BreakpointEntry[]) {
  setFile(path, list);
}

/**
 * A suspend at `path:line` hit the temporary breakpoint there: remove it, like IDEA.
 * Returns whether one was removed.
 */
export function consumeTemporary(path: string, line: number): boolean {
  const bp = breakpointsOf(path).find((b) => b.temporary && b.line === line && b.enabled);
  if (!bp) return false;
  removeBreakpoint(path, bp.id);
  return true;
}

/** Toggles a temporary breakpoint on `line`; an existing one there is removed. */
export function toggleTemporaryBreakpoint(path: string, line: number) {
  if (breakpointsOf(path).some((b) => b.line === line)) {
    setFile(
      path,
      breakpointsOf(path).filter((b) => b.line !== line),
    );
    return;
  }
  addBreakpoint(path, line, { temporary: true });
}

export function setMuted(muted: boolean) {
  if (useBreakpoints.getState().muted === muted) return;
  useBreakpoints.setState({ muted });
  persist();
  for (const path of Object.keys(useBreakpoints.getState().byFile)) scheduleSync(path);
}
