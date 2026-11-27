/**
 * Settings › Debugger › Breakpoints › "Allow placing breakpoints in any file":
 * when off, new line breakpoints go only into files of languages that have a
 * debug adapter (`languages/*.toml` `[debugger]`).
 */
import { classFileBreakpointReason } from "@/platform/classFiles";
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

/** Jinja2's own extensions: no language of theirs yet, but debugpy stops in them (`jinja: true`). */
const JINJA_EXTENSION = /\.(jinja2?|j2)$/i;

/** A Jinja2 template for debugpy: a `.jinja` / `.j2` file, or markup or text in a `templates` folder. */
export const isJinjaTemplate = (path: string) =>
  JINJA_EXTENSION.test(path) || /[\\/]templates[\\/].*\.(html?|xml|txt)$/i.test(path);

/** Whether a new breakpoint may be placed in a file of `language`. */
export function canPlaceBreakpoint(language: string, path = ""): boolean {
  if (classFileBreakpointReason(path)) return false;
  if (workflowSettings().debugger.breakpointsAnyFile || JINJA_EXTENSION.test(path)) return true;
  load();
  // Until the language list is known, don't block anything.
  return !debuggable || debuggable.has(language);
}
