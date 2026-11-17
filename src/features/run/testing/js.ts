/** Jest and Vitest reporters (default + verbose). */
import { parseDuration, type TestEvent, type TestOutputParser, type TestStatus } from "./types";

const PASS_MARKS = "✓✔√";
const FAIL_MARKS = "✕×✗✖";
const SKIP_MARKS = "○↓⊘";
const TODO_MARKS = "✎";

const TEST_FILE = String.raw`[^\s>()]+\.(?:[cm]?[jt]sx?|vue|svelte|astro)`;
const JEST_FILE_RE = new RegExp(String.raw`^\s*(PASS|FAIL)\s+(${TEST_FILE})(?:\s+\(.*\))?\s*$`);
const VITEST_FAIL_HEADER_RE = new RegExp(String.raw`^\s*FAIL\s+(${TEST_FILE})\s+>\s+(.+?)\s*$`);
const JEST_FAIL_HEADER_RE = /^\s*● (.+)$/;
/** Vitest: `stdout | src/a.test.ts > suite > test` heads the console output of that test, up to a blank line. */
const VITEST_CONSOLE_RE = new RegExp(String.raw`^(?:stdout|stderr) \| (${TEST_FILE})(?:\s+>\s+(.+?))?\s*$`);
const LOCATION_RE = new RegExp(String.raw`(?:\(|\s|^)(?:file:\/\/)?((?:\/|\.{0,2}\/?)?${TEST_FILE}):(\d+):(\d+)\)?`);
const JEST_SUMMARY_RE = /^Tests:\s+(.+?)\s*$/;
const VITEST_SUMMARY_RE = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/;
const DURATION_SUMMARY_RE = /^\s*(?:Time:|Duration)\s+([\d.]+\s*m?s)/;
const TRAILING_DURATION_RE = /\s+\(?(\d+(?:\.\d+)?\s?m?s)\)?\s*$/;
const FILE_COUNT_RE = /\s+\((\d+) tests?(?:\s*\|[^)]*)?\)/;

function markStatus(mark: string): Exclude<TestStatus, "running"> | null {
  if (PASS_MARKS.includes(mark)) return "passed";
  if (FAIL_MARKS.includes(mark)) return "failed";
  if (SKIP_MARKS.includes(mark) || TODO_MARKS.includes(mark)) return "skipped";
  return null;
}

function counts(text: string) {
  const out: { passed?: number; failed?: number; skipped?: number } = {};
  for (const m of text.matchAll(/(\d+) (passed|failed|skipped|todo|pending)/g)) {
    const n = Number(m[1]);
    if (m[2] === "passed") out.passed = n;
    else if (m[2] === "failed") out.failed = n;
    else out.skipped = (out.skipped ?? 0) + n;
  }
  return out;
}

export function jsParser(): TestOutputParser {
  let file: string | null = null;
  /** Jest verbose describe blocks: indentation → name. */
  let describes: Array<{ indent: number; name: string }> = [];
  let inVerboseBlock = false;
  let failure: string[] | null = null;
  let locationFound = false;
  /** The test whose console output (Vitest `stdout | …` block) the next lines are. */
  let consoleOf: string[] | null = null;

  const startFailure = (path: string[]) => {
    failure = path;
    locationFound = false;
  };

  return {
    feed(raw) {
      const events: TestEvent[] = [];
      const line = raw.replace(/\s+$/, "");
      let m: RegExpExecArray | null;

      if (consoleOf) {
        if (line) events.push({ type: "output", path: consoleOf, line: raw });
        else consoleOf = null;
        return events;
      }
      if ((m = VITEST_CONSOLE_RE.exec(line))) {
        consoleOf = [m[1]!, ...(m[2] ? m[2].split(/\s+>\s+/) : [])];
        return events;
      }

      if ((m = JEST_FILE_RE.exec(line))) {
        file = m[2]!;
        describes = [];
        inVerboseBlock = true;
        failure = null;
        events.push({ type: "result", path: [file], status: m[1] === "PASS" ? "passed" : "failed" });
        return events;
      }
      // Vitest separators (`⎯⎯ Failed Tests 1 ⎯⎯`, `⎯⎯[1/2]⎯`) end a failure's details.
      if (line.trimStart().startsWith("⎯")) {
        failure = null;
        return events;
      }
      if ((m = VITEST_FAIL_HEADER_RE.exec(line))) {
        const path = [m[1]!, ...m[2]!.split(/\s+>\s+/)];
        events.push({ type: "result", path, status: "failed" });
        startFailure(path);
        return events;
      }
      if ((m = JEST_SUMMARY_RE.exec(line))) {
        events.push({ type: "summary", ...counts(m[1]!) });
        failure = null;
        return events;
      }
      if ((m = VITEST_SUMMARY_RE.exec(line))) {
        events.push({ type: "summary", ...counts(m[1]!) });
        failure = null;
        return events;
      }
      if ((m = DURATION_SUMMARY_RE.exec(line))) {
        events.push({ type: "summary", durationMs: parseDuration(m[1]) });
        return events;
      }

      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      const mark = trimmed[0] ?? "";
      const status = trimmed[1] === " " ? markStatus(mark) : null;

      // Vitest: ` ❯ src/a.test.ts:5:13` (failure location) or ` ❯ src/a.test.ts (2 tests | 1 failed)`.
      if (mark === "❯" || mark === "→") {
        const loc = LOCATION_RE.exec(trimmed.slice(2));
        if (loc && failure && !locationFound) {
          locationFound = true;
          events.push({
            type: "location",
            path: failure,
            location: { path: loc[1]!, line: Number(loc[2]), col: Number(loc[3]), resolve: "path" },
          });
          return events;
        }
        const body = trimmed.slice(2);
        const fm = new RegExp(`^(${TEST_FILE})`).exec(body);
        if (fm && FILE_COUNT_RE.test(body)) {
          file = fm[1]!;
          events.push({ type: "result", path: [file], status: "failed", durationMs: trailingDuration(body) });
          return events;
        }
        // Vitest default reporter: `   ❯ Cart (4)` opens a suite with failed tests; its tests follow, indented.
        const suite = /^(.+?) \(\d+\)$/.exec(body);
        if (suite && file && !failure) {
          while (describes.length && describes[describes.length - 1]!.indent >= indent) describes.pop();
          describes.push({ indent, name: suite[1]! });
          return events;
        }
        if (failure) events.push({ type: "output", path: failure, line: raw });
        return events;
      }

      if (status) {
        let body = trimmed.slice(2);
        const durationMs = trailingDuration(body);
        body = body.replace(TRAILING_DURATION_RE, "");
        const fileMatch = new RegExp(`^(${TEST_FILE})(?=\\s|$)`).exec(body);
        if (fileMatch) {
          const rest = body.slice(fileMatch[0].length);
          const sub = /^\s+>\s+(.+)$/.exec(rest);
          if (sub) {
            // Vitest verbose (flat): `✓ src/a.test.ts > suite > test 2ms`.
            events.push({ type: "result", path: [fileMatch[1]!, ...sub[1]!.split(/\s+>\s+/)], status, durationMs });
          } else {
            // Vitest file line: `✓ src/a.test.ts (3 tests) 5ms`.
            file = fileMatch[1]!;
            describes = [];
            events.push({ type: "result", path: [file], status, durationMs });
          }
          return events;
        }
        body = body.replace(FILE_COUNT_RE, "");
        while (describes.length && describes[describes.length - 1]!.indent >= indent) describes.pop();
        const names = body.split(/\s+(?:>|›)\s+/);
        const path = [...(file ? [file] : []), ...describes.map((d) => d.name), ...names];
        events.push({ type: "result", path, status, durationMs });
        return events;
      }

      if ((m = JEST_FAIL_HEADER_RE.exec(line))) {
        const names = m[1]!.split(/\s+›\s+/);
        if (names[0] === "Test suite failed to run") {
          if (file) startFailure([file]);
        } else {
          const path = [...(file ? [file] : []), ...names];
          events.push({ type: "result", path, status: "failed" });
          startFailure(path);
        }
        inVerboseBlock = false;
        return events;
      }

      if (inVerboseBlock && file && trimmed && indent > 0 && !failure) {
        // Jest verbose describe header (indented, no mark).
        while (describes.length && describes[describes.length - 1]!.indent >= indent) describes.pop();
        describes.push({ indent, name: trimmed });
        return events;
      }
      if (inVerboseBlock && !trimmed) inVerboseBlock = false;

      if (failure) {
        events.push({ type: "output", path: failure, line: raw });
        if (!locationFound && !line.includes("node_modules")) {
          const loc = /\bat\b/.test(line) || /^\s*❯/.test(line) ? LOCATION_RE.exec(line) : null;
          if (loc) {
            locationFound = true;
            events.push({
              type: "location",
              path: failure,
              location: { path: loc[1]!, line: Number(loc[2]), col: Number(loc[3]), resolve: "path" },
            });
          }
        }
      }
      return events;
    },
  };
}

function trailingDuration(body: string): number | undefined {
  const m = TRAILING_DURATION_RE.exec(body);
  return m ? parseDuration(m[1]) : undefined;
}
