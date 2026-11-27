/**
 * Exception breakpoints on a chosen class (IDEA's Java Exception Breakpoints). A project-wide
 * list, persisted like method breakpoints and mirrored to the backend, which arms it in every
 * session that takes it.
 */
import { create } from "zustand";
import { useProject } from "@/platform/project";
import { call, commands, isTauri, type ExceptionClassBreakpoint } from "@/platform/ipc";
import { newBreakpointId } from "./model";
import { useBreakpoints } from "./store";

export interface ExceptionClassEntry {
  id: string;
  /** Fully qualified binary name; its subclasses stop too. */
  className: string;
  caught: boolean;
  uncaught: boolean;
  enabled: boolean;
  /** As typed: patterns for the class whose code throws, `-` before the excluded ones. */
  classFilters: string;
  classFiltersEnabled: boolean;
}

interface ExceptionClassState {
  root: string | null;
  list: ExceptionClassEntry[];
}

export const useExceptionClasses = create<ExceptionClassState>(() => ({ root: null, list: [] }));

const STORAGE_PREFIX = "openidea.debugger.exceptionClasses:";

export function sanitizeExceptionClasses(raw: unknown): ExceptionClassEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof x.className === "string")
    .map((x) => ({
      id: typeof x.id === "string" ? x.id : newBreakpointId(),
      className: x.className as string,
      caught: x.caught !== false,
      uncaught: x.uncaught !== false,
      enabled: x.enabled !== false,
      classFilters: typeof x.classFilters === "string" ? x.classFilters : "",
      classFiltersEnabled: x.classFiltersEnabled === true,
    }));
}

/** IDEA's class filter field: patterns split by spaces, commas or semicolons. */
export function parseClassFilters(text: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    if (token.startsWith("-")) {
      if (token.length > 1) exclude.push(token.slice(1));
    } else if (token) include.push(token);
  }
  return { include, exclude };
}

/** The backend list; one without a class yet is left out, muting disables the rest. */
export function toExceptionClassBreakpoints(
  list: readonly ExceptionClassEntry[],
  muted: boolean,
): ExceptionClassBreakpoint[] {
  return list
    .filter((b) => b.className.trim())
    .map((b) => {
      const filters = b.classFiltersEnabled ? parseClassFilters(b.classFilters) : { include: [], exclude: [] };
      return {
        id: b.id,
        className: b.className.trim(),
        caught: b.caught,
        uncaught: b.uncaught,
        enabled: b.enabled && !muted,
        classFilters: filters.include,
        classExclusionFilters: filters.exclude,
      };
    });
}

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(() => void syncExceptionClasses(), 120);
}

async function syncExceptionClasses() {
  const { root, list } = useExceptionClasses.getState();
  if (!isTauri() || !root || useProject.getState().project?.trusted === false) return;
  try {
    await call(
      commands.debugSetExceptionClassBreakpoints(toExceptionClassBreakpoints(list, useBreakpoints.getState().muted)),
    );
  } catch (e) {
    console.warn("debugSetExceptionClassBreakpoints failed", e);
  }
}

export function loadExceptionClasses(root: string | null) {
  let list: ExceptionClassEntry[] = [];
  if (root) {
    try {
      list = sanitizeExceptionClasses(JSON.parse(localStorage.getItem(STORAGE_PREFIX + root) ?? "[]"));
    } catch {
      // Corrupt entry: start empty.
    }
  }
  useExceptionClasses.setState({ root, list });
  scheduleSync();
}

function setList(list: ExceptionClassEntry[]) {
  useExceptionClasses.setState({ list });
  const { root } = useExceptionClasses.getState();
  if (root) {
    try {
      localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify(list));
    } catch {
      // Storage unavailable: kept for this session only.
    }
  }
  scheduleSync();
}

export function addExceptionClass(className: string): ExceptionClassEntry {
  const bp: ExceptionClassEntry = {
    id: newBreakpointId(),
    className: className.trim(),
    caught: true,
    uncaught: true,
    enabled: true,
    classFilters: "",
    classFiltersEnabled: false,
  };
  setList([...useExceptionClasses.getState().list, bp]);
  return bp;
}

export function updateExceptionClass(id: string, patch: Partial<Omit<ExceptionClassEntry, "id">>) {
  setList(useExceptionClasses.getState().list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
}

export function removeExceptionClass(id: string) {
  setList(useExceptionClasses.getState().list.filter((b) => b.id !== id));
}

export function removeAllExceptionClasses() {
  setList([]);
}

useBreakpoints.subscribe((s, prev) => {
  if (s.muted !== prev.muted) scheduleSync();
});
