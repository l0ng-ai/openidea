/**
 * Python's `python -m unittest`: the IDE's reporter (`unittestReporter.py`, handed over in an
 * environment variable) runs in its place with the same arguments, and prints a record per
 * finished test and subtest (`records.ts`) next to unittest's own console output. Tests are
 * reported as `[module, Class, test, subtest]`; reruns select them with unittest's own `-k` patterns.
 */
import REPORTER_SOURCE from "./unittestReporter.py?raw";

/** Index of `-m` when `unittest` follows it, else -1. */
function unittestAt(args: readonly string[]): number {
  return args.findIndex((a, i) => a === "-m" && args[i + 1] === "unittest");
}

/** The environment variable the reporter's source reaches Python in; the command line stays short. */
export const REPORTER_VAR = "OPENIDEA_UNITTEST_REPORTER";
const BOOTSTRAP = `import os; exec(os.environ.pop("${REPORTER_VAR}"))`;

/** `config` with `-m unittest` replaced by the IDE's reporter; unchanged when it doesn't run unittest. */
export function withUnittestReporter<T extends { args: string[]; env?: Record<string, string> }>(config: T): T {
  const at = unittestAt(config.args);
  if (at < 0) return config;
  return {
    ...config,
    args: [...config.args.slice(0, at), "-c", BOOTSTRAP, ...config.args.slice(at + 2)],
    env: { ...config.env, [REPORTER_VAR]: REPORTER_SOURCE },
  };
}

/**
 * `args` running only the tests at `paths` (tree paths): a `-k` pattern per test in place of the
 * run's own. A pattern with a wildcard matches the whole test id (`module.Class.test`), so
 * `*.test_a` doesn't also run `test_ab`; a class or module fixture runs all of its tests.
 */
export function unittestRerunArgs(args: readonly string[], paths: readonly string[][]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-k") i++;
    else if (!args[i]!.startsWith("-k")) kept.push(args[i]!);
  }
  const ids = [...new Set(paths.map((p) => p.slice(0, 3).join(".") + (p.length < 3 ? ".*" : "")))];
  return [...kept, ...ids.flatMap((id) => ["-k", `*${id}`])];
}
