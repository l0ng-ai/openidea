/**
 * Django tests (PyCharm's "Django tests" configuration): `manage.py test` with a
 * target (app labels, modules or dotted test paths), a settings module and
 * further options. The command is the interpreter (`python3`, `.venv/bin/python`,
 * `uv`), the runner args its leading arguments (`run python` for uv / poetry).
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";

/** A Django project: it has a Django tests configuration (detected from `manage.py`, or made in the form). */
export const hasDjangoTests = (configs: readonly RunConfig[]) => configs.some((c) => c.kind === "django-test");

/** Index of `manage.py` when `test` follows it, else -1. */
function manageTest(args: readonly string[]): number {
  return args.findIndex((a, i) => /(^|[/\\])manage\.py$/.test(a) && args[i + 1] === "test");
}

/** Number of leading positional arguments (the test labels). */
const labelCount = (args: readonly string[]) => {
  const n = args.findIndex((a) => a.startsWith("-"));
  return n < 0 ? args.length : n;
};

/** Dotted test label of a module file: `polls/tests.py` → `polls.tests`, `polls/tests/__init__.py` → `polls.tests`. */
export function djangoLabel(relPath: string): string {
  return relPath
    .replace(/\.py$/, "")
    .replace(/(^|\/)__init__$/, "")
    .replace(/\//g, ".");
}

/**
 * `args` of a `manage.py test` command line running `labels` in place of its
 * own target (the labels right after `test`); null for other command lines.
 */
function withDjangoLabels(args: readonly string[], labels: readonly string[]): string[] | null {
  const at = manageTest(args);
  if (at < 0) return null;
  const rest = args.slice(at + 2);
  return [...args.slice(0, at + 2), ...labels, ...rest.slice(labelCount(rest))];
}

/**
 * The command line (and, for a configuration made in the form, the Target field)
 * of `config` running `labels`; null when it doesn't run `manage.py test`.
 */
export function djangoTestsOf(config: RunConfig, labels: readonly string[]): Pick<RunConfig, "args" | "params"> | null {
  const args = withDjangoLabels(config.args, labels);
  if (!args) return null;
  return config.params?.target === undefined
    ? { args }
    : { args, params: { ...config.params, target: formatArgs([...labels]) } };
}

export const djangoTestType: RunConfigTypeContribution = {
  id: "django-test",
  label: "Django tests",
  icon: "file-python",
  description: "Run Django tests with manage.py test",
  defaults: { command: "python3" },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "python3",
      required: true,
      hint: "e.g. python3, .venv/bin/python, uv, poetry",
    },
    {
      key: "runnerArgs",
      label: "Runner arguments",
      mono: true,
      placeholder: "run python",
      hint: "e.g. `run python` for uv/poetry; empty calls the interpreter itself",
    },
    {
      key: "target",
      label: "Target",
      mono: true,
      placeholder: "polls.tests",
      hint: "App labels, modules or dotted test paths; empty runs every test",
    },
    {
      key: "settings",
      label: "Settings module",
      mono: true,
      placeholder: "mysite.settings_test",
      hint: "Passed as --settings; empty keeps DJANGO_SETTINGS_MODULE or the default in manage.py",
    },
    { key: "options", label: "Options", mono: true, placeholder: "e.g. --keepdb --parallel" },
  ],
  commandLine(p) {
    const args = [...parseArgs(p.runnerArgs ?? ""), "manage.py", "test", ...parseArgs(p.target ?? "")];
    if (p.settings?.trim()) args.push("--settings", p.settings.trim());
    args.push(...parseArgs(p.options ?? ""));
    return { command: p.command?.trim() || "python3", args };
  },
  paramsFrom(c) {
    if (c.kind !== "django-test") return null;
    const at = manageTest(c.args);
    if (at < 0) return null;
    const rest = c.args.slice(at + 2);
    const n = labelCount(rest);
    let options = rest.slice(n);
    let settings = "";
    if (options[0] === "--settings" && options[1] !== undefined) {
      settings = options[1];
      options = options.slice(2);
    }
    return {
      command: c.command,
      runnerArgs: formatArgs(c.args.slice(0, at)),
      target: formatArgs(rest.slice(0, n)),
      settings,
      options: formatArgs(options),
    };
  },
};
