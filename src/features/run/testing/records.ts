/**
 * Records the IDE's JavaScript test reporters print, one line per finished test
 * (`@@openidea:test@@{…}`, see `nodeTestReporter.js`): the test tree reads them, the console hides them.
 */
import { TestStdout, type TestEvent, type TestOutputParser } from "./types";

export const RECORD_MARK = "@@openidea:test@@";

interface TestRecord {
  /** The file (relative to the working directory), then the describe chain and the test's name. */
  path: string[];
  status: "passed" | "failed" | "skipped";
  ms?: number;
  /** 1-based declaration line and column. */
  line?: number;
  col?: number;
  error?: string;
}

export function recordsParser(): TestOutputParser {
  return {
    feed(line) {
      const at = line.indexOf(RECORD_MARK);
      if (at < 0) return [];
      let r: TestRecord;
      try {
        r = JSON.parse(line.slice(at + RECORD_MARK.length)) as TestRecord;
      } catch {
        return [];
      }
      if (!Array.isArray(r.path) || !r.path.length) return [];
      const events: TestEvent[] = [{ type: "result", path: r.path, status: r.status, durationMs: r.ms }];
      if (r.line !== undefined && r.path.length > 1)
        events.push({
          type: "location",
          path: r.path,
          location: { path: r.path[0]!, line: r.line, col: r.col, resolve: "path" },
        });
      for (const text of r.error?.split("\n") ?? []) events.push({ type: "output", path: r.path, line: text });
      return events;
    },
  };
}

/** The console side: the records are the tree's, the runner's own reporter's lines the console's. */
export class RecordsOutput extends TestStdout {
  constructor(feedLine: (line: string) => void) {
    super(feedLine, (line) => (line.includes(RECORD_MARK) ? "" : line + "\n"));
  }
}
