/**
 * Settings › Debugger › Breakpoints › "Allow placing breakpoints in any file":
 * when off, new line breakpoints go only into files of languages that have a
 * debug adapter (`languages/*.toml` `[debugger]`) and into templates debugpy stops in.
 */
import { classFileBreakpointReason } from "@/platform/classFiles";
import { call, commands, isTauri } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { useBreakpoints } from "./store";

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

const JINJA_EXTENSION = /\.(jinja2?|j2)$/i;

/**
 * A Jinja2 template for debugpy: a Jinja2 Template file (also by extension, should File Types give
 * it to another language), or markup or text in a `templates` folder.
 */
export const isJinjaTemplate = (path: string, language?: string | null) =>
  language === "jinja" ||
  language === "jinja-html" ||
  JINJA_EXTENSION.test(path) ||
  /[\\/]templates[\\/].*\.(html?|xml|txt)$/i.test(path);

/** Whether a new breakpoint may be placed in a file of `language`. */
export function canPlaceBreakpoint(language: string, path = ""): boolean {
  if (classFileBreakpointReason(path)) return false;
  // Templates have no adapter of their own: a Python Debug configuration stops in them (debugpy
  // `django` / `jinja`). Django's doesn't declare debugpy, or it would shadow Python's `[debugger]`.
  if (workflowSettings().debugger.breakpointsAnyFile || language === "django-html" || isJinjaTemplate(path, language)) {
    return true;
  }
  load();
  // Until the language list is known, don't block anything.
  return !debuggable || debuggable.has(language);
}

/** Template engines with an enabled breakpoint: debugpy's `django` / `jinja` switches. */
export interface TemplateBreakpoints {
  django: boolean;
  jinja: boolean;
}

export const NO_TEMPLATE_BREAKPOINTS: TemplateBreakpoints = { django: false, jinja: false };

const languageOf = (path: string) =>
  isTauri()
    ? call(commands.docLanguage(path, null)).then(
        (d) => d.language,
        () => null,
      )
    : Promise.resolve(null);

/**
 * Which template engines the breakpoints are in, by each file's language: a Django Template is
 * Django's however the server starts (uvicorn, gunicorn, pytest-django); other templates are Jinja2's.
 */
export async function templateBreakpoints(): Promise<TemplateBreakpoints> {
  const paths = Object.entries(useBreakpoints.getState().byFile)
    .filter(([path, list]) => !/\.pyi?$/i.test(path) && list.some((b) => b.enabled))
    .map(([path]) => path);
  const languages = await Promise.all(paths.map(languageOf));
  return {
    django: languages.includes("django-html"),
    jinja: paths.some((path, i) => languages[i] !== "django-html" && isJinjaTemplate(path, languages[i])),
  };
}
