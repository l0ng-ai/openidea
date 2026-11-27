/**
 * The xterm.js-backed part of the terminal (`runtime.ts`) loads on first use:
 * xterm is ~100 KB gzip that start-up does not need. No terminal session can
 * exist before it has loaded.
 */
import type * as Runtime from "./runtime";
import { useProject } from "@/platform/project";

export type TerminalRuntime = typeof Runtime;

let loaded: TerminalRuntime | null = null;
let pending: Promise<TerminalRuntime> | null = null;

/** The runtime if it has been loaded, else `null`. */
export function terminalRuntime(): TerminalRuntime | null {
  return loaded;
}

export function loadTerminalRuntime(): Promise<TerminalRuntime> {
  return (pending ??= import("./runtime").then((m) => {
    m.syncTerminalProject(useProject.getState().project?.root ?? null);
    return (loaded = m);
  }));
}
