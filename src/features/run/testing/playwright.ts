/**
 * Playwright Test's `list` reporter (the run adds `--reporter=list`): one line per finished
 * test, `  ✓  3 [chromium] › tests/cart.spec.ts:12:3 › cart › adds (25ms)` (`ok` / `x` on
 * Windows consoles), then the failures' details and the summary.
 */
import { parseDuration, type TestEvent, type TestOutputParser, type TestStatus } from "./types";

const SEP = " › ";
const RESULT_RE = /^\s+(✓|ok|✘|x|-)\s+\d+\s+(.+)$/;
const FAILURE_HEADER_RE = /^\s+\d+\) (.+?) ─+$/;
const SUMMARY_RE = /^\s+(\d+) (passed|failed|flaky|skipped|did not run|interrupted)(?: \(([^)]+)\))?$/;
const TITLE_LOCATION_RE = /^(.+):(\d+):(\d+)$/;
const DURATION_RE = /\s\((\d+(?:\.\d+)?(?:ms|s|m|h))\)$/;
const RETRY_RE = /\s\(retry #\d+\)$/;

/** A printed test title: `[project] › file:line:col › describe › test`. */
export interface PlaywrightTitle {
  /** Results tree path: the file, `[project]` when the run names projects, then the titles. */
  path: string[];
  file: string;
  line: number;
  col: number;
}

export function parsePlaywrightTitle(text: string): PlaywrightTitle | null {
  const parts = text.split(SEP);
  const project = /^\[(.+)\]$/.exec(parts[0] ?? "");
  if (project) parts.shift();
  const loc = TITLE_LOCATION_RE.exec(parts.shift() ?? "");
  if (!loc || !parts.length) return null;
  const file = loc[1]!.replace(/\\/g, "/");
  return {
    path: [file, ...(project ? [`[${project[1]}]`] : []), ...parts],
    file,
    line: Number(loc[2]),
    col: Number(loc[3]),
  };
}

/** The `[project]` segment of a results path, if any. */
export function playwrightProject(path: readonly string[]): string | null {
  const m = /^\[(.+)\]$/.exec(path[1] ?? "");
  return m && path.length > 2 ? m[1]! : null;
}

/** The describe chain and test title of a results path (without the file and project). */
export function playwrightTitles(path: readonly string[]): string[] {
  return path.slice(playwrightProject(path) === null ? 1 : 2);
}

function markStatus(mark: string): Exclude<TestStatus, "running"> {
  if (mark === "✓" || mark === "ok") return "passed";
  return mark === "-" ? "skipped" : "failed";
}

export function playwrightParser(): TestOutputParser {
  /** The test whose failure details the following lines are. */
  let failure: string[] | null = null;
  return {
    feed(raw) {
      const line = raw.replace(/\s+$/, "");
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;
      if ((m = SUMMARY_RE.exec(line))) {
        failure = null;
        const n = Number(m[1]);
        const durationMs = parseDuration(m[3]);
        if (m[2] === "passed") events.push({ type: "summary", passed: n, durationMs });
        else if (m[2] === "failed") events.push({ type: "summary", failed: n });
        else if (m[2] === "skipped") events.push({ type: "summary", skipped: n });
        return events;
      }
      if ((m = FAILURE_HEADER_RE.exec(line))) {
        const title = parsePlaywrightTitle(m[1]!);
        failure = title?.path ?? null;
        return events;
      }
      const result = RESULT_RE.exec(line);
      const duration = result && DURATION_RE.exec(result[2]!);
      const title = result && parsePlaywrightTitle(result[2]!.slice(0, duration?.index).replace(RETRY_RE, ""));
      if (result && title) {
        // Failures print at the end, or after their test with PLAYWRIGHT_LIST_PRINT_FAILURES_INLINE.
        failure = null;
        events.push({
          type: "result",
          path: title.path,
          status: markStatus(result[1]!),
          durationMs: parseDuration(duration?.[1]),
        });
        events.push({
          type: "location",
          path: title.path,
          location: { path: title.file, line: title.line, col: title.col, resolve: "path" },
        });
        return events;
      }
      if (failure) events.push({ type: "output", path: failure, line: raw });
      return events;
    },
  };
}
