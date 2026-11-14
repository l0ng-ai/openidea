/** `zig test` (the runner's progress lines) and `zig build test` (failure blocks from the build runner). */
import type { TestEvent, TestOutputParser } from "./types";

// `1/3 tally.test.total adds the prices...OK` — the status lands here when the test printed nothing.
const PROGRESS_RE = /^(\d+)\/(\d+)\s+(.+?)\.\.\.(.*)$/;
// `…/src/tally.zig:22:5: 0x… in test.total of nothing is zero (test)` — error-return trace frames.
const FRAME_RE = /^\s*(.+\.zig):(\d+):(\d+): 0x[0-9a-fA-F]+ in /;
const SUMMARY_RE = /^(\d+) passed(?:; (\d+) skipped)?(?:; (\d+) failed)?\.?$/;
const BUILD_SUMMARY_RE = /^Build Summary: .*?(\d+)\/\d+ tests passed(?: \((\d+) failed\))?/;
const STEP_RE = /^\s*\+- run [^()]*?(\d+) pass(?:, (\d+) skip)?(?:, (\d+) fail)? \(\d+ total\)/;
const FAILED_RE = /^error: '(.+)' failed:$/;
// Frames inside the toolchain's standard library (`<zig>/lib/std/…`; stage3 builds `/lib/zig/std/…`).
const STD_LIB_RE = /\/lib\/(?:zig\/)?std\//;

interface Frame {
  path: string;
  line: number;
  col: number;
}

interface Awaiting {
  path: string[];
  frames: Frame[];
}

/** `tally.test.total adds the prices` → module `tally`, name `total adds the prices` (the last `.test.` wins). */
function splitName(full: string): { stem: string | null; name: string } {
  const at = full.lastIndexOf(".test.");
  return at < 0 ? { stem: null, name: full } : { stem: full.slice(0, at), name: full.slice(at + 6) };
}

/**
 * The runner writes the status right after whatever the test printed, on the same line
 * (`…boomOK`) or, when the print ended in a newline, alone on the next one.
 */
function statusOf(text: string): { status: "passed" | "skipped" | "failed"; output: string } | null {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.endsWith("OK")) return { status: "passed", output: trimmed.slice(0, -2) };
  if (trimmed.endsWith("SKIP")) return { status: "skipped", output: trimmed.slice(0, -4) };
  const failed = /^(.*)FAIL(?: \([^)]*\))?$/.exec(trimmed);
  return failed ? { status: "failed", output: failed[1]! } : null;
}

export function zigParser(): TestOutputParser {
  let pending: Awaiting | null = null;
  let block: Awaiting | null = null;
  let trace: Awaiting | null = null;

  const pathOf = (stem: string | null, name: string) => (stem ? [stem, name] : [name]);
  const location = (events: TestEvent[], path: string[], frames: Frame[]) => {
    // The error originates in the first non-library frame; the outermost is the fallback.
    const frame = frames.find((f) => !STD_LIB_RE.test(f.path)) ?? frames[frames.length - 1];
    if (frame)
      events.push({
        type: "location",
        path,
        location: { path: frame.path, line: frame.line, col: frame.col, resolve: "path" },
      });
  };
  /** A failed test's error-return trace: indented source lines and frames, up to the next unindented line. */
  const traced = (events: TestEvent[], text: Awaiting, line: string): boolean => {
    const m = FRAME_RE.exec(line);
    if (m) {
      text.frames.push({ path: m[1]!, line: Number(m[2]), col: Number(m[3]) });
      return true;
    }
    if (line === "" || /^\s/.test(line)) {
      if (line.trim()) events.push({ type: "output", path: text.path, line: line.trim() });
      return true;
    }
    location(events, text.path, text.frames);
    return false;
  };

  return {
    feed(line) {
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;
      // Inside a `zig build` failure block: indented (or blank) lines are the test's captured output.
      if (block) {
        if (traced(events, block, line)) return events;
        block = null;
      }
      // After a `zig test` FAIL: the error-return trace follows on the next lines.
      if (trace) {
        if (traced(events, trace, line)) return events;
        trace = null;
      }
      if (pending && (m = /^(OK|SKIP|FAIL(?: \([^)]*\))?)$/.exec(line))) {
        const status = m[1] === "OK" ? "passed" : m[1] === "SKIP" ? "skipped" : "failed";
        events.push({ type: "result", path: pending.path, status });
        // A failure's trace follows on the next lines; the summary must not become its output.
        trace = status === "failed" ? pending : null;
        pending = null;
        return events;
      }
      if (pending && (m = FRAME_RE.exec(line))) {
        pending.frames.push({ path: m[1]!, line: Number(m[2]), col: Number(m[3]) });
        return events;
      }
      if ((m = PROGRESS_RE.exec(line))) {
        const { stem, name } = splitName(m[3]!);
        pending = { path: pathOf(stem, name), frames: [] };
        events.push({ type: "start", path: pending.path });
        const status = statusOf(m[4]!);
        if (status) {
          if (status.output) events.push({ type: "output", path: pending.path, line: status.output });
          events.push({ type: "result", path: pending.path, status: status.status });
          trace = status.status === "failed" ? pending : null;
          pending = null;
        } else if (m[4]) {
          events.push({ type: "output", path: pending.path, line: m[4] });
        }
        return events;
      }
      if ((m = FAILED_RE.exec(line))) {
        const { stem, name } = splitName(m[1]!);
        block = { path: pathOf(stem, name), frames: [] };
        events.push({ type: "result", path: block.path, status: "failed" });
        return events;
      }
      if (pending) {
        // Anything else before the status is the running test's output (prints, panic text).
        events.push({ type: "output", path: pending.path, line });
        return events;
      }
      if ((m = SUMMARY_RE.exec(line))) {
        events.push({ type: "summary", passed: Number(m[1]), skipped: Number(m[2] ?? 0), failed: Number(m[3] ?? 0) });
      } else if ((m = BUILD_SUMMARY_RE.exec(line))) {
        events.push({ type: "summary", passed: Number(m[1]), failed: Number(m[2] ?? 0) });
      } else if ((m = STEP_RE.exec(line))) {
        events.push({ type: "summary", passed: Number(m[1]), skipped: Number(m[2] ?? 0), failed: Number(m[3] ?? 0) });
      }
      return events;
    },
    end() {
      const events: TestEvent[] = [];
      if (trace) {
        location(events, trace.path, trace.frames);
        trace = null;
      }
      if (block) {
        location(events, block.path, block.frames);
        block = null;
      }
      return events;
    },
  };
}
