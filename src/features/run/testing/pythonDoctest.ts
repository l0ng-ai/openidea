/**
 * Python doctests: `python -m doctest FILE[::Name.qualname]…` runs through the IDE's reporter
 * (`doctestReporter.py`, handed over in an environment variable), which prints a record per
 * example (`records.ts`). Tests are reported as `[file, object, example]`; `::` selects one class
 * or function of the module, which `python -m doctest` itself can't.
 */
import REPORTER_SOURCE from "./doctestReporter.py?raw";

const REPORTER_VAR = "OPENIDEA_DOCTEST_REPORTER";
const BOOTSTRAP = `import os; exec(os.environ.pop("${REPORTER_VAR}"))`;

/** Index of `-m` when `doctest` follows it, else -1. */
const doctestAt = (args: readonly string[]) => args.findIndex((a, i) => a === "-m" && args[i + 1] === "doctest");

/** `config` with `-m doctest` replaced by the IDE's reporter; unchanged when it doesn't run doctest. */
export function withDoctestReporter<T extends { args: string[]; env?: Record<string, string> }>(config: T): T {
  const at = doctestAt(config.args);
  if (at < 0) return config;
  return {
    ...config,
    args: [...config.args.slice(0, at), "-c", BOOTSTRAP, ...config.args.slice(at + 2)],
    env: { ...config.env, [REPORTER_VAR]: REPORTER_SOURCE },
  };
}

/** The dotted module of a file, as the reporter imports it: `pkg/calc.py` → `pkg.calc`. */
const moduleOf = (file: string) =>
  file
    .replace(/\.py$/, "")
    .replace(/(^|\/)__init__$/, "")
    .replace(/\//g, ".");

/**
 * `args` running the objects whose examples are at `paths` (tree paths) in place of the run's own
 * targets: `file::Object`, or the whole file for its module docstring or a module that failed to load.
 * ponytail: an object named like the end of the module's name (`money` in `shop/money.py`) reruns the whole file.
 */
export function doctestRerunArgs(args: readonly string[], paths: readonly string[][]): string[] | null {
  const at = doctestAt(args);
  if (at < 0) return null;
  // The module's own docstring: its dotted name, from the working directory or a source root (`src/`).
  const isModule = (file: string, owner: string) => `.${moduleOf(file)}`.endsWith(`.${owner}`);
  const targets = paths.map(([file, owner]) => (!owner || isModule(file!, owner) ? file! : `${file}::${owner}`));
  // Options stay; the run's own files and objects go.
  const options = args.slice(at + 2).filter((a, i, all) => a.startsWith("-") || all[i - 1] === "-o");
  // A whole file already runs its objects.
  const files = new Set(targets.filter((t) => !t.includes("::")));
  const kept = targets.filter((t) => !files.has(t.split("::")[0]!) || !t.includes("::"));
  return [...args.slice(0, at + 2), ...options, ...new Set(kept)];
}
