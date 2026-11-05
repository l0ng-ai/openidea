/**
 * PHPUnit (and Pest, which runs on it) through `--teamcity`: one `##teamcity[…]` service message per
 * suite and test event, with the exact `Class::method` names and failure details. Tests are reported as
 * `[...suites, test]`: the configured suite (`Unit`), the class, then the method (with its data set).
 */
import { serviceMessage } from "./teamcity";
import type { TestEvent, TestOutputParser } from "./types";

/** `php_qn:///app/tests/FooTest.php::\App\FooTest::testBar` → the file. */
function hintFile(hint: string | undefined): string | null {
  const m = /^php_qn:\/\/(.+?\.php)(?:::|$)/.exec(hint ?? "");
  return m ? m[1]! : null;
}

/** First stack frame inside the project (not `vendor/`): `/app/tests/FooTest.php:12`. */
function failureLocation(details: string): { path: string; line: number } | null {
  for (const line of details.split("\n")) {
    const m = /(?:^|\s)((?:[A-Za-z]:)?[^\s:]+\.php):(\d+)\s*$/.exec(line.trim());
    if (m && !/[/\\]vendor[/\\]/.test(m[1]!)) return { path: m[1]!, line: Number(m[2]) };
  }
  return null;
}

export function phpunitParser(): TestOutputParser {
  /** Open suites, outermost first (the data-provider suite `Class::method` is one of them). */
  const suites: string[] = [];
  const open = new Map<string, { path: string[]; file: string | null; done: boolean }>();

  /** A data-provider suite is named `Class::method`; its data sets belong under the method (the class is open already). */
  const suitePath = (): string[] =>
    suites.map((s) => {
      const at = s.lastIndexOf("::");
      return at > 0 ? s.slice(at + 2) : s;
    });

  return {
    feed(line) {
      const message = serviceMessage(line);
      if (!message) return [];
      const { kind, attrs: a } = message;
      const name = a.name ?? "";
      const events: TestEvent[] = [];
      switch (kind) {
        case "testSuiteStarted":
          suites.push(name);
          break;
        case "testSuiteFinished":
          if (suites[suites.length - 1] === name) suites.pop();
          break;
        case "testStarted": {
          const path = [...suitePath(), name];
          open.set(name, { path, file: hintFile(a.locationHint), done: false });
          events.push({ type: "start", path });
          break;
        }
        case "testFailed":
        case "testIgnored": {
          const test = open.get(name);
          if (!test) break;
          const details = a.details ?? "";
          const text = [a.message, details].filter(Boolean).join("\n");
          for (const l of text.split("\n")) events.push({ type: "output", path: test.path, line: l });
          const at = failureLocation(details) ?? (test.file ? { path: test.file, line: undefined } : null);
          if (at) {
            events.push({
              type: "location",
              path: test.path,
              location: { path: at.path, ...(at.line ? { line: at.line } : {}), resolve: "path" },
            });
          }
          events.push({ type: "result", path: test.path, status: kind === "testIgnored" ? "skipped" : "failed" });
          test.done = true;
          break;
        }
        case "testFinished": {
          const test = open.get(name);
          if (!test) break;
          open.delete(name);
          // A failed or ignored test already has its result; the finish only reports a pass.
          if (!test.done) {
            events.push({
              type: "result",
              path: test.path,
              status: "passed",
              ...(a.duration ? { durationMs: Number(a.duration) } : {}),
            });
          }
          break;
        }
      }
      return events;
    },
  };
}

// ----------------------------------------------------------------- command lines

/** Options that take a value in a separate argument. */
const VALUE_OPTIONS = new Set([
  "-c",
  "--configuration",
  "--bootstrap",
  "--filter",
  "--testsuite",
  "--group",
  "--exclude-group",
  "--covers",
  "--uses",
  "--cache-directory",
]);

/** Number of leading runner arguments (`vendor/bin/phpunit` under `php`); PHPUnit's own options follow. */
function runnerLength(args: readonly string[]): number {
  return args[0] && /(^|[/\\])(phpunit|pest)(\.phar|\.bat)?$/.test(args[0]) ? 1 : 0;
}

/** Splits the arguments after the runner into options and positional targets. */
function splitArgs(rest: readonly string[], dropFilter: boolean): { options: string[]; targets: string[] } {
  const options: string[] = [];
  const targets: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("-")) targets.push(arg);
    else if (VALUE_OPTIONS.has(arg) && i + 1 < rest.length) {
      if (!(dropFilter && arg === "--filter")) options.push(arg, rest[i + 1]!);
      i++;
    } else if (!(dropFilter && arg.startsWith("--filter="))) options.push(arg);
  }
  return { options, targets };
}

/**
 * `args` running `target` (a file or directory) and/or a `--filter` pattern in place of the command's own.
 * PHPUnit stops parsing options at the first path, so everything is placed before it.
 */
export function phpunitArgs(args: readonly string[], run: { target?: string; filter?: string }): string[] {
  const n = runnerLength(args);
  const { options, targets } = splitArgs(args.slice(n), run.filter !== undefined);
  return [
    ...args.slice(0, n),
    ...options,
    ...(run.filter === undefined ? [] : ["--filter", run.filter]),
    ...(run.target === undefined ? targets : [run.target]),
  ];
}

/** `--teamcity` ahead of any path, unless the run already picked a result format. */
export function withTeamcity(args: readonly string[]): string[] {
  if (args.some((a) => a === "--teamcity" || /^--(testdox|log-|no-output)/.test(a))) return [...args];
  const n = runnerLength(args);
  return [...args.slice(0, n), "--teamcity", ...args.slice(n)];
}

const escapePattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * `--filter` pattern selecting the tests at `paths` (`[suite, class, method]`, a data set under its method).
 * PHPUnit matches `Class::method with data set …`; a class or suite node selects by its name.
 */
export function phpunitFilter(paths: readonly (readonly string[])[]): string {
  const parts = new Set<string>();
  for (const path of paths) {
    const last = path[path.length - 1] ?? "";
    const dataSet = / with data set .*$/.test(last);
    const method = last.replace(/ with data set .*$/, "");
    // A data set sits under a node named after its method (the data-provider suite).
    const cls = path[path.length - (dataSet ? 3 : 2)];
    if (cls && /^[a-z_]\w*$/.test(method))
      parts.add(`${escapePattern(cls)}::${escapePattern(method)}( with data set .*)?`);
    else parts.add(`${escapePattern(last)}::.*`);
  }
  return `/(${[...parts].join("|")})$/`;
}
