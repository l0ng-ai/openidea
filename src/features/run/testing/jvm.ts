/**
 * Gradle test logging (`Class > method() PASSED`), the Gradle test init script's service messages
 * (`gradleTests.gradle`) and Maven Surefire reports.
 */
import { jvmFrameTarget } from "../links";
import type { TestResults } from "./results";
import { serviceMessage, type ServiceMessage } from "./teamcity";
import { parseDuration, type TestEvent, type TestLocation, type TestOutputParser } from "./types";

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
// `at org.junit…`, also behind a class loader or module (`at app//org.junit…`, `at java.base@21/java.lang…`).
const LIBRARY_FRAME_RE =
  /^\s*at\s+(?:\S*\/)?(?:org\.junit|junit\.|org\.opentest4j|org\.testng|kotlin\.|jdk\.internal|java\.|javax\.|sun\.|org\.gradle)/;

/** The source position of a stack frame in the project's code, null for library frames. */
function frameLocation(line: string): TestLocation | null {
  const f = FRAME_RE.exec(line);
  if (!f || LIBRARY_FRAME_RE.test(line)) return null;
  return f[2] ? jvmFrameTarget(f[1], f[2], Number(f[3])) : { path: f[4]!, line: Number(f[5]), resolve: "name" };
}

/**
 * Test events of the init script's messages. Tests are `[class, method]`, named as in the XML reports
 * (`add(int, int)[1]` → `add`); `outcomes` keeps each test's failure or skip until it finishes.
 */
function initScriptEvents({ kind, attrs }: ServiceMessage, outcomes: Map<string, "failed" | "skipped">): TestEvent[] {
  if (!attrs.className || !attrs.name) return [];
  const path = [attrs.className, attrs.name.split("(")[0]!.trim() || attrs.name];
  const key = path.join("\0");
  // A parameterized method's invocations share its node: one failure fails the method.
  const failed = outcomes.get(key) === "failed";
  switch (kind) {
    case "testStarted":
      if (!failed) outcomes.delete(key);
      return [{ type: "start", path }];
    case "testStdOut":
    case "testStdErr": {
      const text = (attrs.out ?? "").replace(/\r?\n$/, "");
      return text ? text.split(/\r?\n/).map((line) => ({ type: "output", path, line })) : [];
    }
    case "testFailed": {
      outcomes.set(key, "failed");
      const lines = (attrs.details || attrs.message || "").split("\n");
      const events: TestEvent[] = lines.map((line) => ({ type: "output", path, line }));
      const location = lines.map(frameLocation).find((l) => l);
      if (location) events.push({ type: "location", path, location });
      return events;
    }
    case "testIgnored":
      if (!failed) outcomes.set(key, "skipped");
      return [];
    case "testFinished": {
      const status = outcomes.get(key) ?? "passed";
      const durationMs = attrs.duration ? Number(attrs.duration) : undefined;
      return [{ type: "result", path, status, ...(durationMs === undefined ? {} : { durationMs }) }];
    }
  }
  return [];
}

export function jvmParser(): TestOutputParser {
  let failure: string[] | null = null;
  let located = false;
  /** The init script reports every test: Gradle's own test logging would repeat them by simple class name. */
  let reported = false;
  const outcomes = new Map<string, "failed" | "skipped">();

  const startFailure = (path: string[]) => {
    failure = path;
    located = false;
  };

  return {
    feed(line) {
      const events: TestEvent[] = [];
      const message = serviceMessage(line);
      if (message) {
        reported = true;
        failure = null;
        return initScriptEvents(message, outcomes);
      }
      let m: RegExpExecArray | null;
      if ((m = GRADLE_RE.exec(line.trim())) && !line.startsWith(" ")) {
        if (reported) {
          failure = null;
          return events;
        }
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
        const location = located ? null : frameLocation(line);
        if (location) {
          located = true;
          events.push({ type: "location", path: failure, location });
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
