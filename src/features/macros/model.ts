/**
 * Edit › Macros (IDEA's ActionMacroManager): a macro is the list of actions
 * the user ran plus what they typed and the editing / caret keys they pressed
 * in the editor. The last recording and the named macros persist in
 * localStorage (per user, like live templates).
 */
import { create } from "zustand";

/** Plain data an action can be run with: primitives, string lists, or a flat object of those. */
export type MacroArg = MacroValue | { [key: string]: MacroValue };
type MacroValue = string | number | boolean | string[];

const isMacroValue = (v: unknown): v is MacroValue =>
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every((x) => typeof x === "string"));

function isMacroArg(v: unknown): v is MacroArg {
  if (isMacroValue(v)) return true;
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && Object.values(v).every(isMacroValue);
}

/** An editor key replayed as a CodeMirror command (see `editorKeys.ts`). */
export type MacroStep =
  | { kind: "action"; id: string; arg?: MacroArg }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

export interface Macro {
  name: string;
  steps: MacroStep[];
}

interface MacroState {
  /** Steps recorded so far, while recording. */
  recording: MacroStep[] | null;
  /** A macro is being played back. */
  playing: boolean;
  /** The last recorded macro (Play Back Last Macro). */
  last: MacroStep[] | null;
  saved: Macro[];
}

export const STORAGE_KEY = "openidea.macros.v1";

function isStep(v: unknown): v is MacroStep {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (s.kind === "action") return typeof s.id === "string" && (s.arg === undefined || isMacroArg(s.arg));
  if (s.kind === "text") return typeof s.text === "string";
  return s.kind === "key" && typeof s.key === "string";
}

const steps = (v: unknown): MacroStep[] | null => (Array.isArray(v) ? v.filter(isStep) : null);

function read(): Pick<MacroState, "last" | "saved"> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { last?: unknown; saved?: unknown } | null;
    const saved = Array.isArray(raw?.saved)
      ? raw.saved
          .filter((m): m is { name: string; steps: unknown } => !!m && typeof m.name === "string" && !!m.name.trim())
          .map((m) => ({ name: m.name, steps: steps(m.steps) ?? [] }))
      : [];
    return { last: steps(raw?.last), saved };
  } catch {
    return { last: null, saved: [] };
  }
}

export const useMacros = create<MacroState>(() => ({ recording: null, playing: false, ...read() }));

function persist() {
  const { last, saved } = useMacros.getState();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ last, saved }));
  } catch {
    /* storage unavailable */
  }
}

/** Test helper: re-reads storage. */
export function _reloadMacros() {
  useMacros.setState({ recording: null, playing: false, ...read() });
}

/** Appends a step to the recording; consecutive typing is merged into one text step. */
export function recordStep(step: MacroStep) {
  const rec = useMacros.getState().recording;
  if (!rec || useMacros.getState().playing) return;
  const prev = rec[rec.length - 1];
  const next =
    step.kind === "text" && prev?.kind === "text"
      ? [...rec.slice(0, -1), { kind: "text" as const, text: prev.text + step.text }]
      : [...rec, step];
  useMacros.setState({ recording: next });
}

/** An action's argument when it can be stored (plain data only). */
export function storableArg(arg: unknown): MacroArg | undefined | null {
  if (arg === undefined) return undefined;
  return isMacroArg(arg) ? arg : null;
}

export function startRecording() {
  useMacros.setState({ recording: [] });
}

/** Ends the recording; returns its steps (also the new "last macro" when not empty). */
export function stopRecording(): MacroStep[] {
  const rec = useMacros.getState().recording ?? [];
  useMacros.setState({ recording: null, ...(rec.length ? { last: rec } : {}) });
  persist();
  return rec;
}

/** Saves `steps` as `name`, replacing a macro of that name. */
export function saveMacro(name: string, macroSteps: MacroStep[]) {
  const n = name.trim();
  if (!n) return;
  const saved = useMacros.getState().saved;
  const i = saved.findIndex((m) => m.name === n);
  const entry = { name: n, steps: macroSteps };
  useMacros.setState({ saved: i >= 0 ? saved.map((m, j) => (j === i ? entry : m)) : [...saved, entry] });
  persist();
}

export function renameMacro(from: string, to: string): boolean {
  const n = to.trim();
  const saved = useMacros.getState().saved;
  if (!n || (n !== from && saved.some((m) => m.name === n))) return false;
  useMacros.setState({ saved: saved.map((m) => (m.name === from ? { ...m, name: n } : m)) });
  persist();
  return true;
}

export function deleteMacro(name: string) {
  useMacros.setState((s) => ({ saved: s.saved.filter((m) => m.name !== name) }));
  persist();
}

function describeArg(arg: MacroArg): string {
  if (Array.isArray(arg)) return arg.join(", ");
  if (typeof arg === "object") return typeof arg.path === "string" ? arg.path : JSON.stringify(arg);
  return String(arg);
}

/** One line per step, for Edit Macros. */
export function describeStep(step: MacroStep, title: (id: string) => string): string {
  switch (step.kind) {
    case "action":
      return step.arg === undefined ? title(step.id) : `${title(step.id)} (${describeArg(step.arg)})`;
    case "text":
      return `Type "${step.text.replace(/\n/g, "↵")}"`;
    case "key":
      return `Press ${step.key}`;
  }
}

/** Runs `macroSteps` one after another; stops at the first step that cannot run. */
export async function playSteps(
  macroSteps: readonly MacroStep[],
  run: { action(id: string, arg?: unknown): Promise<boolean>; text(text: string): boolean; key(key: string): boolean },
): Promise<boolean> {
  if (useMacros.getState().playing) return false;
  useMacros.setState({ playing: true });
  try {
    for (const step of macroSteps) {
      const ok =
        step.kind === "action"
          ? await run.action(step.id, step.arg)
          : step.kind === "text"
            ? run.text(step.text)
            : run.key(step.key);
      if (!ok) return false;
      // Let the UI settle (popups open, editors mount) before the next step.
      await new Promise((r) => setTimeout(r, 0));
    }
    return true;
  } finally {
    useMacros.setState({ playing: false });
  }
}
