/**
 * Settings › Debugger › Breakpoints › "Allow placing breakpoints in any file":
 * when off, new line breakpoints go only into files of languages that have a
 * debug adapter (`languages/*.toml` `[debugger]`).
 */
import { commands, isTauri } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";

let debuggable: Set<string> | null = null;
let loading = false;

function load() {
  if (debuggable || loading || !isTauri()) return;
  loading = true;
  commands
    .languages()
    .then((langs) => {
      debuggable = new Set(langs.filter((l) => l.debuggable).map((l) => l.id));
    })
    .catch(() => undefined)
    .finally(() => (loading = false));
}

/** Whether a new breakpoint may be placed in a file of `language`. */
export function canPlaceBreakpoint(language: string): boolean {
  if (workflowSettings().debugger.breakpointsAnyFile) return true;
  load();
  // Until the language list is known, don't block anything.
  return !debuggable || debuggable.has(language);
}
