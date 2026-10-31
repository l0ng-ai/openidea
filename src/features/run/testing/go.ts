/**
 * `go test` (plain and `-v`). Results are printed per package and the package
 * name only appears in the trailing `ok`/`FAIL` line, so events are buffered
 * per package and emitted under it once that line arrives.
 */
import { parseDuration, type TestEvent, type TestOutputParser } from "./types";

const RUN_RE = /^=== (?:RUN|CONT|PAUSE)\s+(\S+)/;
const RESULT_RE = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+s)\)/;
const PKG_RE = /^(ok|FAIL|---)\s+(\S+)\s+(?:\(cached\)|([\d.]+s)|\[[^\]]+\])/;
const LOCATION_RE = /^\s+([\w.-]+\.go):(\d+):/;

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

export function goJsonEvent(line: string): GoEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || typeof event.Action !== "string") return null;
    const pkg = event.Package ?? event.ImportPath;
    if (
      typeof pkg !== "string" ||
      !pkg ||
      !["start", "run", "pause", "cont", "output", "pass", "fail", "skip", "build-output", "build-fail"].includes(
        event.Action,
      )
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
  const packages = new Map<string, { tests: boolean; failed: boolean }>();
  const totals = { passed: 0, failed: 0, skipped: 0 };
  return {
    feed(line) {
      const e = goJsonEvent(line);
      if (!e) return plain.feed(line);
      const pkg = packages.get(e.Package) ?? { tests: false, failed: false };
      packages.set(e.Package, pkg);
      const path = [e.Package, ...(e.Test ? e.Test.split("/") : [])];
      if (e.Test) pkg.tests = true;
      if (e.Action === "run") return [{ type: "start", path }];
      if (e.Action === "output" || e.Action === "build-output") {
        if (!e.Output) return [];
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
      const key = path.join("\0");
      if (finished.has(key)) return [];
      finished.add(key);
      const status = e.Action === "pass" ? "passed" : e.Action === "skip" ? "skipped" : "failed";
      if (e.Test && path.length === 2) {
        totals[status]++;
        if (status === "failed") pkg.failed = true;
      } else if (!e.Test && (!pkg.tests || (status === "failed" && !pkg.failed))) totals[status]++;
      const durationMs =
        typeof e.Elapsed === "number" && Number.isFinite(e.Elapsed) && e.Elapsed >= 0 ? e.Elapsed * 1000 : undefined;
      return [
        { type: "result", path, status, durationMs },
        { type: "summary", ...totals },
      ];
    },
    end: () => plain.end?.() ?? [],
  };
}

/** Decode stdout for the console while feeding complete, unsplit JSON records to the test parser. */
export class GoTestOutput {
  private pending = "";
  constructor(private readonly feedLine: (line: string) => void) {}
  feed(text: string): string {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    return lines.map((line) => this.line(line)).join("");
  }
  end(): string {
    const pending = this.pending;
    this.pending = "";
    return pending ? this.line(pending) : "";
  }
  private line(raw: string): string {
    const line = raw.replace(/\r$/, "");
    this.feedLine(line);
    const event = goJsonEvent(line);
    return event ? (event.Output ?? "") : line + "\n";
  }
}
