/**
 * Minitest's verbose output (`-v`; Test::Unit's minitest shim prints the same): one
 * `Class#test_name = 0.00 s = .` line per test (`.` passed, `F` failed, `E` error, `S` skipped),
 * then the failure sections and the summary. Tests are reported as `[Class, test_name]`.
 *
 * ```text
 * MixedTest#test_prints = hello from test      <- the test's own output comes first,
 * 0.00 s = .                                      the result follows on a line of its own
 *
 *   1) Failure:
 *   MixedTest#test_fail [test/mixed_test.rb:5]:
 *   Expected: 4
 *     Actual: 3
 *
 * 7 runs, 5 assertions, 1 failures, 1 errors, 1 skips
 * ```
 */
import { parseDuration, type TestEvent, type TestOutputParser, type TestStatus } from "./types";

// A class may be a spec description with spaces (`Spec style#test_0001_works`).
const RESULT_RE = /^(.+?)#(\S+) = ([\d.]+ s) = ([.FES])$/;
const STARTED_RE = /^(.+?)#(\S+) = (.*)$/;
/** The result of a test that printed output first. */
const LATE_RESULT_RE = /^([\d.]+ s) = ([.FES])$/;
const SECTION_RE = /^\s*\d+\) (Failure|Error|Skipped):$/;
const SECTION_TEST_RE = /^(.+?)#(\S+?)(?: \[(.+?):(\d+)\])?:$/;
const FRAME_RE = /^\s+(\S+?):(\d+):in /;
const SUMMARY_RE = /^(\d+) runs, \d+ assertions, (\d+) failures, (\d+) errors, (\d+) skips/;
const FINISHED_RE = /^Finished in ([\d.]+s)/;
/** Gems and the standard library never locate a failure. */
const LIBRARY_RE = /[/\\](?:gems|rubygems|lib[/\\]ruby)[/\\]/;

const STATUS: Record<string, Exclude<TestStatus, "running">> = {
  ".": "passed",
  F: "failed",
  E: "failed",
  S: "skipped",
};

/** Minitest names no file for a passing test: its location is searched for when the user jumps to it. */
const located = (path: string[]): TestEvent => ({
  type: "location",
  path,
  location: { path: path[1]!, className: path[0], resolve: "rubyTest" },
});

export function rubyParser(): TestOutputParser {
  const seen = new Set<string>();
  /** The test's own location, once. */
  const locate = (path: string[]): TestEvent[] => {
    const id = path.join("\0");
    if (seen.has(id)) return [];
    seen.add(id);
    return [located(path)];
  };
  /** A test whose result line has not been printed yet: its own output came first. */
  let pending: string[] | null = null;
  let section: { path: string[] | null; located: boolean; expectTest: boolean } | null = null;
  let finished: number | undefined;

  return {
    feed(line) {
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;

      if ((m = SUMMARY_RE.exec(line))) {
        section = null;
        const [runs, failures, errors, skips] = [m[1], m[2], m[3], m[4]].map(Number) as [
          number,
          number,
          number,
          number,
        ];
        events.push({
          type: "summary",
          passed: Math.max(0, runs - failures - errors - skips),
          failed: failures + errors,
          skipped: skips,
          durationMs: finished,
        });
        return events;
      }
      if ((m = FINISHED_RE.exec(line))) {
        finished = parseDuration(m[1]);
        pending = null;
        return events;
      }
      if (SECTION_RE.test(line)) {
        section = { path: null, located: false, expectTest: true };
        return events;
      }
      if (section) {
        if (section.expectTest) {
          const t = SECTION_TEST_RE.exec(line);
          section.expectTest = false;
          if (t) {
            section.path = [t[1]!, t[2]!];
            events.push({ type: "output", path: section.path, line });
            if (t[3]) {
              section.located = true;
              events.push({
                type: "location",
                path: section.path,
                location: { path: t[3], line: Number(t[4]), resolve: "path" },
              });
            }
            return events;
          }
        }
        if (section.path) {
          events.push({ type: "output", path: section.path, line });
          const frame = FRAME_RE.exec(line);
          // An error has no `[file:line]` in its header: its first frame outside the libraries is the place.
          if (frame && !section.located && !LIBRARY_RE.test(frame[1]!)) {
            section.located = true;
            events.push({
              type: "location",
              path: section.path,
              location: { path: frame[1]!, line: Number(frame[2]), resolve: "path" },
            });
          }
        }
        return events;
      }

      if ((m = RESULT_RE.exec(line))) {
        const path = [m[1]!, m[2]!];
        events.push({ type: "result", path, status: STATUS[m[4]!]!, durationMs: parseDuration(m[3]) }, ...locate(path));
        pending = null;
        return events;
      }
      if (pending && (m = LATE_RESULT_RE.exec(line))) {
        events.push({ type: "result", path: pending, status: STATUS[m[2]!]!, durationMs: parseDuration(m[1]) });
        pending = null;
        return events;
      }
      if ((m = STARTED_RE.exec(line)) && /^(test|\w*_\d+)/.test(m[2]!)) {
        pending = [m[1]!, m[2]!];
        events.push({ type: "start", path: pending }, ...locate(pending));
        if (m[3]) events.push({ type: "output", path: pending, line: m[3] });
        return events;
      }
      if (pending) events.push({ type: "output", path: pending, line });
      return events;
    },
  };
}
