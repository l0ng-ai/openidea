/**
 * Per-project history of expressions typed into the debugger (breakpoint
 * conditions, Evaluate, the debug console), most recent first, as IDEA keeps them.
 */
import { useProject } from "@/platform/project";

export type HistoryKind = "condition" | "evaluate" | "console";

const PREFIX = "openidea.debugger.history.";
const MAX = 50;

function key(kind: HistoryKind): string | null {
  const root = useProject.getState().project?.root;
  return root ? `${PREFIX}${kind}:${root}` : null;
}

export function readHistory(kind: HistoryKind): string[] {
  const k = key(kind);
  if (!k) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(k) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export function pushHistory(kind: HistoryKind, expression: string) {
  const e = expression.trim();
  const k = key(kind);
  if (!e || !k) return;
  const next = [e, ...readHistory(kind).filter((h) => h !== e)].slice(0, MAX);
  try {
    localStorage.setItem(k, JSON.stringify(next));
  } catch {
    // Storage unavailable: no history.
  }
}

/** Browse History (⌥⌘E) of the focused debug console input, while one has focus. */
let browseConsoleHistory: (() => void) | null = null;

export function setConsoleHistoryBrowser(fn: (() => void) | null) {
  browseConsoleHistory = fn;
}

export function browseFocusedConsoleHistory(): boolean {
  if (!browseConsoleHistory) return false;
  browseConsoleHistory();
  return true;
}
