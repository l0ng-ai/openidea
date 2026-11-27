/**
 * `go test` (plain and `-v`). Results are printed per package and the package
 * name only appears in the trailing `ok`/`FAIL` line, so events are buffered
 * per package and emitted under it once that line arrives.
 */
import { parseDuration, TestStdout, type TestEvent, type TestOutputParser } from "./types";

const RUN_RE = /^=== (?:RUN|CONT|PAUSE)\s+(\S+)/;
const RESULT_RE = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+s)\)/;
const PKG_RE = /^(ok|FAIL|---)\s+(\S+)\s+(?:\(cached\)|([\d.]+s)|\[[^\]]+\])/;
const LOCATION_RE = /^\s+([\w.-]+\.go):(\d+):/;
const BENCHMARK_RE = /^(Benchmark\S*) *\t[ \t]*\d+ *(?:\t|$)/m;

function plainGoParser(): TestOutputParser {
  let buffer: TestEvent[] = [];
  let current: string[] | null = null;
  let totals = { passed: 0, failed: 0, skipped: 0 };
  const located = new Set<string>();

  const flush = (pkg: string | null): TestEvent[] => {
    const out = buffer.map((e) => (pkg && "path" in e ? { ...e, path: [pkg, ...e.path] } : e));
    buffer = [];
    current = null;
    located.clear();
    return out;
  };

  return {
    feed(line) {
      let m: RegExpExecArray | null;
      if ((m = RUN_RE.exec(line))) {
        const path = m[1]!.split("/");
        buffer.push({ type: "start", path });
        current = path;
        return [];
      }
      if ((m = RESULT_RE.exec(line))) {
        const status = m[1] === "PASS" ? "passed" : m[1] === "FAIL" ? "failed" : "skipped";
        const path = m[2]!.split("/");
        buffer.push({ type: "result", path, status, durationMs: parseDuration(m[3]) });
        current = path;
        if (path.length === 1) totals = { ...totals, [status]: totals[status] + 1 };
        return [];
      }
      if ((m = PKG_RE.exec(line)) && m[1] !== "---") {
        const pkg = m[2]!;
        const events = flush(pkg);
        // Without -v a passing package prints nothing per test: show the package itself.
        if (!events.some((e) => e.type === "result")) {
          events.push({
            type: "result",
            path: [pkg],
            status: m[1] === "ok" ? "passed" : "failed",
            durationMs: parseDuration(m[3]),
          });
        }
        events.push({ type: "summary", ...totals });
        return events;
      }
      if (current && /^\s+/.test(line)) {
        buffer.push({ type: "output", path: current, line });
        const loc = LOCATION_RE.exec(line);
        const key = current.join("/");
        if (loc && !located.has(key)) {
          located.add(key);
          buffer.push({
            type: "location",
            path: current,
            location: { path: loc[1]!, line: Number(loc[2]), resolve: "name" },
          });
        }
      }
      return [];
    },
    end() {
      return flush(null);
    },
  };
}

interface GoEvent {
  Action: string;
  Package: string;
  Test?: string;
  Output?: string;
  Elapsed?: number;
}

interface GoPackage {
  tests: boolean;
  failed: boolean;
  /** Benchmark names, with whether Go reported a successful measurement or bench event. */
  benchmarks: Map<string, boolean>;
}

function benchmarkName(pkg: GoPackage, name: string): string {
  if (pkg.benchmarks.has(name)) return name;
  const withoutCpu = name.replace(/-\d+$/, "");
  return pkg.benchmarks.has(withoutCpu) ? withoutCpu : name;
}

export function goJsonEvent(line: string): GoEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || typeof event.Action !== "string") return null;
    const pkg = event.Package ?? event.ImportPath;
    if (
      typeof pkg !== "string" ||
      !pkg ||
      ![
        "start",
        "run",
        "pause",
        "cont",
        "output",
        "pass",
        "bench",
        "fail",
        "skip",
        "build-output",
        "build-fail",
      ].includes(event.Action)
    )
      return null;
    if (event.Test !== undefined && typeof event.Test !== "string") return null;
    if (event.Output !== undefined && typeof event.Output !== "string") return null;
    return { ...event, Package: pkg };
  } catch {
    return null;
  }
}

export function goParser(): TestOutputParser {
  const plain = plainGoParser();
  const located = new Set<string>();
  const finished = new Set<string>();
  const packages = new Map<string, GoPackage>();
  const totals = { passed: 0, failed: 0, skipped: 0 };

  function finish(pkg: GoPackage, path: string[], status: keyof typeof totals, durationMs?: number): TestEvent[] {
    const key = path.join("\0");
    if (finished.has(key)) return [];
    finished.add(key);
    if (path.length === 2) {
      totals[status]++;
      if (status === "failed") pkg.failed = true;
    } else if (path.length === 1 && (!pkg.tests || (status === "failed" && !pkg.failed))) totals[status]++;
    return [{ type: "result", path, status, durationMs }];
  }

  return {
    feed(line) {
      const e = goJsonEvent(line);
      if (!e) return plain.feed(line);
      const pkg = packages.get(e.Package) ?? { tests: false, failed: false, benchmarks: new Map() };
      packages.set(e.Package, pkg);
      const benchmark = e.Test?.startsWith("Benchmark") ? e.Test : undefined;
      const name = benchmark && e.Action !== "run" ? benchmarkName(pkg, benchmark) : e.Test;
      const path = [e.Package, ...(name ? name.split("/") : [])];
      if (name) pkg.tests = true;
      if (e.Action === "run") {
        finished.delete(path.join("\0"));
        if (benchmark) pkg.benchmarks.set(benchmark, false);
        return [{ type: "start", path }];
      }
      if (e.Action === "bench") {
        if (name) pkg.benchmarks.set(name, true);
        return [];
      }
      if (e.Action === "output" || e.Action === "build-output") {
        if (!e.Output) return [];
        if (e.Action === "output" && (!name || benchmark)) {
          const measurement = BENCHMARK_RE.exec(e.Output)?.[1];
          if (measurement) {
            const measured = benchmarkName(pkg, measurement);
            if (pkg.benchmarks.has(measured) && (!name || name === measured)) pkg.benchmarks.set(measured, true);
          }
        }
        const lines = e.Output.replace(/\n$/, "").split("\n");
        const events: TestEvent[] = lines.map((line) => ({ type: "output", path, line }));
        const key = path.join("\0");
        const loc = lines.map((line) => /^\s*(.+\.go):(\d+)(?::(\d+))?:/.exec(line)).find(Boolean);
        if (loc && !located.has(key)) {
          located.add(key);
          events.push({
            type: "location",
            path,
            location: {
              path: loc[1]!,
              line: Number(loc[2]),
              ...(loc[3] ? { col: Number(loc[3]) } : {}),
              resolve: loc[1]!.startsWith("/") ? "path" : "name",
            },
          });
        }
        return events;
      }
      if (!["pass", "fail", "skip", "build-fail"].includes(e.Action)) return [];
      const status = e.Action === "pass" ? "passed" : e.Action === "skip" ? "skipped" : "failed";
      const durationMs =
        typeof e.Elapsed === "number" && Number.isFinite(e.Elapsed) && e.Elapsed >= 0 ? e.Elapsed * 1000 : undefined;
      const events: TestEvent[] = [];
      if (!name) {
        // Quiet benchmarks can emit measurements without a terminal event. Wait for the
        // package result so a failure from a later CPU setting can take precedence.
        for (const [test, measured] of pkg.benchmarks) {
          if (measured) events.push(...finish(pkg, [e.Package, ...test.split("/")], "passed"));
        }
        pkg.benchmarks.clear();
      }
      events.push(...finish(pkg, path, status, durationMs));
      if (events.length) events.push({ type: "summary", ...totals });
      return events;
    },
    end: () => plain.end?.() ?? [],
  };
}

/** Decode stdout for the console while feeding complete, unsplit JSON records to the test parser. */
export class GoTestOutput extends TestStdout {
  constructor(feedLine: (line: string) => void) {
    super(feedLine, (line) => {
      const event = goJsonEvent(line);
      return event ? (event.Output ?? "") : line + "\n";
    });
  }
}
