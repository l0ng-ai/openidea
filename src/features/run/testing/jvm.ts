/** Gradle test logging (`Class > method() PASSED`) and Maven Surefire reports. */
import { jvmFrameTarget } from "../links";
import type { TestResults } from "./results";
import { parseDuration, type TestEvent, type TestOutputParser } from "./types";

const GRADLE_RE = /^(\S[^>]*?(?:\s>\s[^>]+?)+)\s+(PASSED|FAILED|SKIPPED)(?:\s+\(([\d.]+\s*m?s)\))?$/;
const GRADLE_SUMMARY_RE = /^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?/;
const FRAME_RE =
  /(?:([\w$]+(?:\.[\w$]+)*)\.[\w$<>-]+)?\(([\w$.-]+\.(?:java|kt|kts|scala|groovy)):(\d+)\)|\bat ([\w$.-]+\.(?:java|kt|kts|scala|groovy)):(\d+)/;
// [ERROR] com.acme.OrderTest.shouldX -- Time elapsed: 0.01 s <<< FAILURE!   (Surefire 3)
// shouldX(com.acme.OrderTest)  Time elapsed: 0.01 sec  <<< FAILURE!          (Surefire 2)
const SUREFIRE3_RE =
  /^(?:\[\w+\]\s+)?([\w$.]+)\.([\w$]+)(?:\(\))?\s+--\s+Time elapsed: ([\d.]+ s(?:ec)?)\s+<<<\s+(FAILURE|ERROR)!/;
const SUREFIRE2_RE = /^(?:\[\w+\]\s+)?([\w$]+)\(([\w$.]+)\)\s+Time elapsed: ([\d.]+ s(?:ec)?)\s+<<<\s+(FAILURE|ERROR)!/;
const SUREFIRE_CLASS_RE =
  /^(?:\[\w+\]\s+)?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+), Time elapsed: ([\d.]+ s(?:ec)?).*?(?:-- in |- in )([\w$.]+)\s*$/;
const SUREFIRE_TOTAL_RE = /^(?:\[\w+\]\s+)?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/;

export function jvmParser(): TestOutputParser {
  let failure: string[] | null = null;
  let located = false;

  const startFailure = (path: string[]) => {
    failure = path;
    located = false;
  };

  return {
    feed(line) {
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;
      if ((m = GRADLE_RE.exec(line.trim())) && !line.startsWith(" ")) {
        // `method()` is a JUnit 5 display name; the reports name the method.
        const path = m[1]!.split(/\s+>\s+/).map((p, i, all) => (i === all.length - 1 ? p.replace(/\(\)$/, "") : p));
        const status = m[2] === "PASSED" ? "passed" : m[2] === "FAILED" ? "failed" : "skipped";
        events.push({ type: "result", path, status, durationMs: parseDuration(m[3]) });
        if (status === "failed") startFailure(path);
        else failure = null;
        return events;
      }
      if ((m = GRADLE_SUMMARY_RE.exec(line))) {
        const failed = Number(m[2] ?? 0);
        const skipped = Number(m[3] ?? 0);
        events.push({ type: "summary", passed: Number(m[1]) - failed - skipped, failed, skipped });
        failure = null;
        return events;
      }
      if ((m = SUREFIRE3_RE.exec(line)) || (m = SUREFIRE2_RE.exec(line))) {
        const surefire3 = SUREFIRE3_RE.test(line);
        const cls = surefire3 ? m[1]! : m[2]!;
        const method = surefire3 ? m[2]! : m[1]!;
        const path = [cls, method];
        events.push({ type: "result", path, status: "failed", durationMs: parseDuration(m[3]) });
        startFailure(path);
        return events;
      }
      if ((m = SUREFIRE_CLASS_RE.exec(line))) {
        const failed = Number(m[2]) + Number(m[3]);
        const run = Number(m[1]);
        const skipped = Number(m[4]);
        events.push({
          type: "result",
          path: [m[6]!],
          status: failed > 0 ? "failed" : skipped === run ? "skipped" : "passed",
          durationMs: parseDuration(m[5]),
        });
        failure = null;
        return events;
      }
      if ((m = SUREFIRE_TOTAL_RE.exec(line))) {
        const failed = Number(m[2]) + Number(m[3]);
        const skipped = Number(m[4]);
        events.push({ type: "summary", passed: Number(m[1]) - failed - skipped, failed, skipped });
        failure = null;
        return events;
      }
      if (failure) {
        if (!line.trim() || /^\[(INFO|WARNING)\]/.test(line)) {
          if (!line.trim()) return events;
          failure = null;
          return events;
        }
        events.push({ type: "output", path: failure, line });
        const f = FRAME_RE.exec(line);
        const libraryFrame =
          /^\s*at\s+(?:org\.junit|junit\.|org\.opentest4j|kotlin\.|jdk\.internal|java\.|javax\.|sun\.|org\.gradle)/.test(
            line,
          );
        if (f && !located && !libraryFrame) {
          located = true;
          events.push({
            type: "location",
            path: failure,
            location: f[2]
              ? jvmFrameTarget(f[1], f[2], Number(f[3]))
              : { path: f[4]!, line: Number(f[5]), resolve: "name" },
          });
        }
      }
      return events;
    },
  };
}

/**
 * Gradle's console names a test class by its simple name and its XML reports by the
 * qualified one: moves the console's results to the reported class.
 */
export function moveToReportedClasses(tests: TestResults, classNames: readonly string[]) {
  const bySimpleName = new Map<string, string | null>();
  for (const c of new Set(classNames)) {
    const simple = c.slice(c.lastIndexOf(".") + 1);
    if (simple !== c) bySimpleName.set(simple, bySimpleName.has(simple) ? null : c);
  }
  for (const root of [...tests.roots]) {
    const qualified = bySimpleName.get(root.name);
    if (qualified) tests.move([root.name], [qualified]);
  }
}
