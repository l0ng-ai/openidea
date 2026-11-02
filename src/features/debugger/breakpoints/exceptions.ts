/**
 * Exception breakpoints: the filters each adapter offers (`exceptionBreakpointFilters`,
 * cached per adapter so the Breakpoints dialog can show them without a session) and the
 * user's choices (filter id → enabled), persisted per project and mirrored to the backend,
 * which applies them to every session (adapter defaults for filters without a choice).
 */
import { create } from "zustand";
import { useProject } from "@/platform/project";
import { call, commands, isTauri, type ExceptionFilter } from "@/platform/ipc";

interface ExceptionState {
  root: string | null;
  /** Explicit choices; filters without one use the adapter's default. */
  choices: Record<string, boolean>;
  /** Adapter name → filters it offered last time. */
  known: Record<string, ExceptionFilter[]>;
}

const CHOICES_PREFIX = "openidea.debugger.exceptions:";
const KNOWN_KEY = "openidea.debugger.exceptionFilters";

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: choices last for this session only.
  }
}

export function sanitizeChoices(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
}

export function sanitizeKnown(raw: unknown): Record<string, ExceptionFilter[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ExceptionFilter[]> = {};
  for (const [adapter, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const filters = list.filter(
      (f): f is ExceptionFilter => !!f && typeof f.filter === "string" && typeof f.label === "string",
    );
    if (filters.length) out[adapter] = filters;
  }
  return out;
}

const seed = (filter: string, label: string, def = false): ExceptionFilter => ({
  filter,
  label,
  description: null,
  default: def,
  supportsCondition: false,
});

/**
 * Filters of the supported adapters before any session reported its own (the dialog
 * shows them right away, like IDEA's per-language exception breakpoints).
 */
export const BUILTIN_FILTERS: Record<string, ExceptionFilter[]> = {
  debugpy: [
    seed("raised", "Raised Exceptions"),
    seed("uncaught", "Uncaught Exceptions", true),
    seed("userUnhandled", "User Uncaught Exceptions"),
  ],
  "java-debug": [seed("caught", "Caught Exceptions"), seed("uncaught", "Uncaught Exceptions")],
  "js-debug": [seed("all", "Caught Exceptions"), seed("uncaught", "Uncaught Exceptions")],
  codelldb: [
    seed("rust_panic", "Rust: on panic", true),
    seed("cpp_throw", "C++: on throw"),
    seed("cpp_catch", "C++: on catch"),
  ],
};

export const useExceptionBreakpoints = create<ExceptionState>(() => ({
  root: null,
  choices: {},
  known: { ...BUILTIN_FILTERS, ...sanitizeKnown(readJson(KNOWN_KEY)) },
}));

/** Choice key of an adapter's filter (adapters reuse ids such as `uncaught`). */
export function choiceKey(adapter: string, filter: string): string {
  return `${adapter}:${filter}`;
}

/** Effective state: the adapter-scoped choice, a legacy unscoped one, else the default. */
export function isFilterEnabled(filter: ExceptionFilter, choices: Record<string, boolean>, adapter = ""): boolean {
  return choices[choiceKey(adapter, filter.filter)] ?? choices[filter.filter] ?? filter.default;
}

export interface ExceptionGroup {
  adapter: string;
  filters: Array<ExceptionFilter & { enabled: boolean }>;
}

/** Filters grouped by adapter (sorted), with their effective state. */
export function exceptionGroups(
  known: Record<string, ExceptionFilter[]>,
  choices: Record<string, boolean>,
): ExceptionGroup[] {
  return Object.keys(known)
    .sort()
    .map((adapter) => ({
      adapter,
      filters: known[adapter]!.map((f) => ({ ...f, enabled: isFilterEnabled(f, choices, adapter) })),
    }));
}

/** Merges filters reported by live sessions into the per-adapter cache. */
export function mergeKnown(
  known: Record<string, ExceptionFilter[]>,
  sessions: Array<{ adapter: string; filters: ExceptionFilter[] }>,
): Record<string, ExceptionFilter[]> {
  let next = known;
  for (const s of sessions) {
    if (!s.filters.length) continue;
    if (JSON.stringify(next[s.adapter]) === JSON.stringify(s.filters)) continue;
    next = { ...next, [s.adapter]: s.filters };
  }
  return next;
}

async function push() {
  if (!isTauri() || !useExceptionBreakpoints.getState().root || useProject.getState().project?.trusted === false)
    return;
  try {
    await call(commands.debugSetExceptionBreakpoints(useExceptionBreakpoints.getState().choices));
  } catch (e) {
    console.warn("debugSetExceptionBreakpoints failed", e);
  }
}

/** Loads the project's choices and sends them to the backend. */
export function loadExceptionBreakpoints(root: string | null) {
  const choices = root ? sanitizeChoices(readJson(CHOICES_PREFIX + root)) : {};
  useExceptionBreakpoints.setState({ root, choices });
  void push();
}

export function setExceptionFilter(adapter: string, filter: string, enabled: boolean) {
  const { root, choices } = useExceptionBreakpoints.getState();
  const key = choiceKey(adapter, filter);
  if (choices[key] === enabled) return;
  const next = { ...choices, [key]: enabled };
  useExceptionBreakpoints.setState({ choices: next });
  if (root) writeJson(CHOICES_PREFIX + root, next);
  void push();
}

/** Pulls the filters of live sessions (after a session starts, when the dialog opens). */
export async function refreshExceptionFilters() {
  if (!isTauri()) return;
  try {
    const sessions = await call(commands.debugExceptionFilters());
    const { known } = useExceptionBreakpoints.getState();
    const next = mergeKnown(known, sessions);
    if (next !== known) {
      useExceptionBreakpoints.setState({ known: next });
      writeJson(KNOWN_KEY, next);
    }
  } catch (e) {
    console.warn("debugExceptionFilters failed", e);
  }
}
