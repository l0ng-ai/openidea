/**
 * unittest's text runner, as Django's `manage.py test` prints it: verbose result
 * lines (`-v 2`), failure sections and the summary. Tests are reported as
 * `[module, Class, test]`; class and module fixtures (`setUpClass`, a test module
 * that fails to import) as their class or module.
 */
import { parseDuration, type TestEvent, type TestOutputParser, type TestStatus } from "./types";

/** A Python identifier (Unicode letters, not starting with a digit). */
const ID = String.raw`[\p{L}_][\p{L}\p{N}_]*`;
// `test_x (polls.tests.QuestionTests.test_x)` (Python ≥ 3.11 adds the test name),
// `test_x (polls.tests.QuestionTests)`, then a subtest's `[msg]` / `(i=1)`.
const HEADER_RE = new RegExp(
  String.raw`^\s*(${ID}(?:\.${ID})*) \((${ID}(?:\.${ID})+)\)(?: \[.*?\])?(?: \(.*?\))?(?= \.\.\.|$)`,
  "u",
);
const OUTCOME_RE = /^(ok|FAIL|ERROR|skipped(?: .*)?|expected failure|unexpected success)$/;
// A docstring's first line follows the name when the test has one: `Checks x. ... ok`.
const TRAILING_OUTCOME_RE = / \.\.\. (ok|FAIL|ERROR|skipped(?: .*)?|expected failure|unexpected success)$/;
const SECTION_RE = /^(FAIL|ERROR|UNEXPECTED SUCCESS): (.+)$/;
const FRAME_RE = /^\s*File "([^"]+)", line (\d+), in (\S+)/;
// Installed packages and the standard library with its unittest (`lib/python3.12/…`, Windows `Lib\…`);
// a project's own `unittest/` folder is not a library.
const LIBRARY_RE =
  /[/\\](?:site-packages|dist-packages)[/\\]|\/lib\/python[\d.]*\/(?:unittest\/|[^/]+\.py$)|\\Lib\\(?:unittest\\|[^\\]+\.py$)/;
const RAN_RE = /^Ran (\d+) tests? in ([\d.]+s)$/;
// Python ≥ 3.12 prints `NO TESTS RAN` when nothing matched the labels.
const RESULT_RE = /^(OK|FAILED|NO TESTS RAN)(?: \((.*)\))?$/;
/** unittest's `separator1` / `separator2`. */
const RULE1 = "=".repeat(70);
const RULE2 = "-".repeat(70);

function status(outcome: string): Exclude<TestStatus, "running"> {
  if (outcome === "ok" || outcome === "expected failure") return "passed";
  if (outcome.startsWith("skipped")) return "skipped";
  return "failed";
}

/** Tree path of a reported test: its module, class and name. */
function testPath(name: string, dotted: string): string[] {
  // A test module that failed to import: `polls.tests (unittest.loader._FailedTest.polls.tests)`.
  if (/^unittest\.loader\._Failed/.test(dotted)) return [name];
  if (name === "setUpModule" || name === "tearDownModule") return [dotted];
  const id = dotted.endsWith(`.${name}`) ? dotted.slice(0, -name.length - 1) : dotted;
  const dot = id.lastIndexOf(".");
  const parts = dot < 0 ? [id] : [id.slice(0, dot), id.slice(dot + 1)];
  return name === "setUpClass" || name === "tearDownClass" ? parts : [...parts, name];
}

export function unittestParser(): TestOutputParser {
  /** A test whose outcome hasn't been printed yet (output, a docstring or subtests came first). */
  let pending: string[] | null = null;
  let section: {
    path: string[];
    /** The function whose frame locates the failure (the test, `setUpClass`, a module's `<module>`). */
    name: string;
    ruled: boolean;
    location: TestEvent | null;
    fallback: TestEvent | null;
  } | null = null;
  let ran: { count: number; durationMs?: number } | null = null;

  const closeSection = (): TestEvent[] => {
    const s = section;
    section = null;
    const location = s && (s.location ?? s.fallback);
    return location ? [location] : [];
  };

  /** Result lines; a line may hold several (Python < 3.11 prints nothing after a test with failed subtests). */
  const results = (line: string, events: TestEvent[]): boolean => {
    let rest = line;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = HEADER_RE.exec(rest))) {
      const after = rest.slice(m[0].length).replace(/^ \.\.\. ?/, "");
      const outcome = OUTCOME_RE.exec(after);
      // A result that comes later (after a docstring or the test's output) only for test methods
      // (unittest's `test` prefix); fixtures and modules print theirs at once. Lines of other tools
      // such as `Finished (0.5s)` or `compile (gcc.exe)` are no tests.
      if (!outcome && !m[1]!.startsWith("test")) break;
      matched = true;
      const path = testPath(m[1]!, m[2]!);
      rest = after;
      if (outcome) {
        events.push({ type: "result", path, status: status(outcome[1]!) });
        pending = null;
        return true;
      }
      events.push({ type: "start", path });
      pending = path;
    }
    return matched;
  };

  return {
    feed(line) {
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;
      if (line === RULE1) {
        events.push(...closeSection());
        pending = null;
        return events;
      }
      // An unexpected success's section has no traceback: the summary follows its rule.
      if (section && RAN_RE.test(line)) events.push(...closeSection());
      if (section) {
        if (line === RULE2) {
          if (!section.ruled) section.ruled = true;
          else events.push(...closeSection());
          return events;
        }
        events.push({ type: "output", path: section.path, line });
        const frame = FRAME_RE.exec(line);
        // Library frames never locate a failure, even when named like the test or fixture
        // (Django's own `setUpClass` runs the test's `setUpTestData`).
        if (frame && !LIBRARY_RE.test(frame[1]!)) {
          const location: TestEvent = {
            type: "location",
            path: section.path,
            location: { path: frame[1]!, line: Number(frame[2]), resolve: "path" },
          };
          if (frame[3] === section.name) section.location ??= location;
          else section.fallback ??= location;
        }
        return events;
      }
      if ((m = SECTION_RE.exec(line))) {
        const header = HEADER_RE.exec(m[2]!);
        if (header) {
          const path = testPath(header[1]!, header[2]!);
          const name = /^unittest\.loader\._Failed/.test(header[2]!) ? "<module>" : header[1]!;
          section = { path, name, ruled: false, location: null, fallback: null };
          events.push({ type: "result", path, status: "failed" }, { type: "output", path, line });
          return events;
        }
      }
      if ((m = RAN_RE.exec(line))) {
        ran = { count: Number(m[1]), durationMs: parseDuration(m[2]) };
        return events;
      }
      if (ran && (m = RESULT_RE.exec(line))) {
        const counts: Record<string, number> = {};
        for (const c of (m[2] ?? "").matchAll(/([a-z ]+)=(\d+)/g)) counts[c[1]!.trim()] = Number(c[2]);
        const failed = (counts.failures ?? 0) + (counts.errors ?? 0) + (counts["unexpected successes"] ?? 0);
        const skipped = counts.skipped ?? 0;
        events.push({
          type: "summary",
          passed: Math.max(0, ran.count - failed - skipped),
          failed,
          skipped,
          durationMs: ran.durationMs,
        });
        ran = null;
        return events;
      }
      if (results(line, events)) return events;
      if (pending) {
        const outcome = OUTCOME_RE.exec(line) ?? TRAILING_OUTCOME_RE.exec(line);
        if (outcome) {
          events.push({ type: "result", path: pending, status: status(outcome[1]!) });
          pending = null;
        }
      }
      return events;
    },
    end: closeSection,
  };
}
