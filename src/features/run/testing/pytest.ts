/** pytest: verbose lines, `-rA` / short summary lines, progress dots and failure sections. */
import { parseDuration, type TestEvent, type TestOutputParser, type TestStatus } from "./types";

type Outcome = "PASSED" | "FAILED" | "ERROR" | "SKIPPED" | "XFAIL" | "XPASS";

const OUTCOME = String.raw`(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)`;
// `tests/test_x.py::TestC::test_y[1] PASSED   [ 50%]`
const VERBOSE_RE = new RegExp(String.raw`^(\S+\.py::.+?)\s+${OUTCOME}(?:\s|$)`);
// `[gw0] PASSED tests/test_x.py::test_add` (xdist) and short summary `FAILED tests/test_x.py::test_sub - msg`
const PREFIX_RE = new RegExp(
  String.raw`^(?:\[gw\d+\]\s+(?:\[\s*\d+%\]\s+)?)?${OUTCOME}\s+(\S+\.py::.+?)(?:\s+-\s+.*)?$`,
);
// `tests/test_x.py .F.s                                   [100%]`
const PROGRESS_RE = /^(\S+\.py) ([.FEsxX]+)\s*(?:\[\s*\d+%\])?$/;
const SECTION_RE = /^_{3,} (.+?) _{3,}$/;
const LOCATION_RE = /^(\S+\.py):(\d+): /;
const SUMMARY_RE = /^=+ (.*\b(?:passed|failed|error|errors|skipped|deselected|xfailed|xpassed|no tests ran)\b.*?) =+$/;
const BANNER_RE = /^=+ .* =+$/;

function status(outcome: Outcome): Exclude<TestStatus, "running"> {
  switch (outcome) {
    case "PASSED":
    case "XFAIL":
      return "passed";
    case "SKIPPED":
      return "skipped";
    default:
      return "failed";
  }
}

/**
 * `file.py::Class::test[id]` → `[file.py, Class, test, [id]]`: a parametrized case is a child of its
 * test. The id is kept whole (it may hold `::`, `.` or `[`); test names never contain `[`.
 */
const split = (nodeid: string) => {
  const file = nodeid.indexOf("::");
  const open = nodeid.indexOf("[", file + 2);
  const parts = (open < 0 ? nodeid : nodeid.slice(0, open)).split("::").filter(Boolean);
  if (open >= 0 && parts.length > 1) parts.push(nodeid.slice(open));
  return parts;
};

const isCase = (part: string | undefined) => !!part?.startsWith("[");

/** pytest node id of a test path: a case's `[id]` follows its test without `::`. */
export function pytestNodeId(path: readonly string[]): string {
  return isCase(path[path.length - 1]) && path.length > 2
    ? `${path.slice(0, -1).join("::")}${path[path.length - 1]}`
    : path.join("::");
}

/**
 * Where a test is declared, for a test that has no failure line to go to (and for the node
 * grouping a test's cases): its `def` in the file.
 */
function declarations(path: string[], status: TestStatus): TestEvent[] {
  if (path.length < 2) return [];
  const test = path.slice(1).filter((p) => !isCase(p));
  const at = (p: string[]): TestEvent => ({
    type: "location",
    path: p,
    location: { path: path[0]!, resolve: "path", test },
  });
  const out: TestEvent[] = [];
  if (isCase(path[path.length - 1])) out.push(at(path.slice(0, -1)));
  // A failure's own line comes with its section.
  if (status !== "failed") out.push(at(path));
  return out;
}

export function pytestParser(): TestOutputParser {
  /** Node ids reported so far, used to resolve failure section titles. */
  const known: string[][] = [];
  let failure: string[] | null = null;
  let locationFound = false;
  /**
   * Failure sections seen before the test's node id (non-verbose runs print
   * names only in the short summary at the end): buffered until resolved.
   */
  let pending: { parts: string[]; events: TestEvent[] } | null = null;
  const unresolved: Array<{ parts: string[]; events: TestEvent[] }> = [];

  const endsWith = (path: string[], parts: string[]) => {
    const tail = path.slice(path.length - parts.length);
    return tail.length === parts.length && tail.every((p, i) => p === parts[i]);
  };

  /** Records a node id; returns buffered failure events that now belong to it. */
  const remember = (path: string[]): TestEvent[] => {
    if (!known.some((k) => k.join("::") === path.join("::"))) known.push(path);
    const out: TestEvent[] = [];
    for (let i = unresolved.length - 1; i >= 0; i--) {
      const u = unresolved[i]!;
      if (!endsWith(path, u.parts)) continue;
      unresolved.splice(i, 1);
      for (const e of u.events) if (e.type === "output" || e.type === "location") out.push({ ...e, path });
    }
    return out;
  };

  /** Section titles are `test_name`, `TestClass.test_name` or either with a case id (`test_name[1.5]`). */
  const titleParts = (title: string) => {
    const name = title.replace(/^(ERROR at \w+ of |ERROR collecting )/, "");
    const open = name.indexOf("[");
    const parts = (open < 0 ? name : name.slice(0, open)).split(".");
    if (open > 0) parts.push(name.slice(open));
    return parts;
  };

  return {
    feed(line) {
      const events: TestEvent[] = [];
      let m: RegExpExecArray | null;
      if ((m = VERBOSE_RE.exec(line))) {
        const path = split(m[1]!);
        const outcome = status(m[2] as Outcome);
        events.push({ type: "result", path, status: outcome }, ...declarations(path, outcome), ...remember(path));
        return events;
      }
      if ((m = PREFIX_RE.exec(line))) {
        const path = split(m[2]!);
        const outcome = status(m[1] as Outcome);
        events.push({ type: "result", path, status: outcome }, ...declarations(path, outcome), ...remember(path));
        failure = null;
        pending = null;
        return events;
      }
      if ((m = PROGRESS_RE.exec(line))) {
        const failed = /[FE]/.test(m[2]!);
        const allSkipped = /^[sx]+$/.test(m[2]!);
        events.push({
          type: "result",
          path: [m[1]!],
          status: failed ? "failed" : allSkipped ? "skipped" : "passed",
        });
        return events;
      }
      if ((m = SUMMARY_RE.exec(line))) {
        failure = null;
        const counts: { passed?: number; failed?: number; skipped?: number } = {};
        for (const c of m[1]!.matchAll(/(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)/g)) {
          const n = Number(c[1]);
          if (c[2] === "passed" || c[2] === "xfailed") counts.passed = (counts.passed ?? 0) + n;
          else if (c[2] === "skipped") counts.skipped = n;
          else counts.failed = (counts.failed ?? 0) + n;
        }
        const d = / in ([\d.]+s)/.exec(m[1]!);
        events.push({
          type: "summary",
          ...counts,
          durationMs: parseDuration(d?.[1]),
        });
        return events;
      }
      if ((m = SECTION_RE.exec(line))) {
        const parts = titleParts(m[1]!);
        const hit = known.find((k) => endsWith(k, parts));
        failure = hit ?? parts;
        pending = hit ? null : { parts, events: [] };
        if (pending) unresolved.push(pending);
        locationFound = false;
        return events;
      }
      if (BANNER_RE.test(line)) {
        failure = null;
        pending = null;
        return events;
      }
      if (failure) {
        const sink = pending ? pending.events : events;
        sink.push({ type: "output", path: failure, line });
        const loc = LOCATION_RE.exec(line);
        if (loc && !locationFound) {
          locationFound = true;
          sink.push({
            type: "location",
            path: failure,
            location: { path: loc[1]!, line: Number(loc[2]), resolve: "path" },
          });
        }
      }
      return events;
    },
    end() {
      // Sections that never got a node id: report them under their title.
      const out: TestEvent[] = [];
      for (const u of unresolved.splice(0)) {
        out.push({ type: "result", path: u.parts, status: "failed" }, ...u.events);
      }
      return out;
    },
  };
}
