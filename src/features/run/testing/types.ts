/**
 * Test runner output parsing. Each framework parser turns plain output lines
 * (ANSI already stripped) into events; `TestResults` folds them into a tree.
 */

export type TestStatus = "running" | "passed" | "failed" | "skipped";

export interface TestLocation {
  path: string;
  /** 1-based, as printed. */
  line?: number;
  col?: number;
  /** `name`: a file name to look up in the project (JVM / Go frames). */
  resolve: "path" | "name";
  /** JVM frames: the class's binary name; `path` is then the file under its package directory. */
  className?: string;
}

export type TestEvent =
  | { type: "start"; path: string[] }
  | { type: "result"; path: string[]; status: Exclude<TestStatus, "running">; durationMs?: number }
  | { type: "location"; path: string[]; location: TestLocation }
  | { type: "output"; path: string[]; line: string }
  | { type: "summary"; passed?: number; failed?: number; skipped?: number; durationMs?: number };

export interface TestOutputParser {
  feed(line: string): TestEvent[];
  /** Emits anything buffered (process exit). */
  end?(): TestEvent[];
}

/** Parses `3 ms`, `(1.2 s)`, `0.00s`, `12ms`, `1m 3s` into milliseconds. */
export function parseDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const s = text.replace(/[()]/g, "").trim();
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min)\b/g)) {
    matched = true;
    const v = Number(m[1]);
    total += m[2] === "ms" ? v : m[2] === "m" || m[2] === "min" ? v * 60_000 : v * 1000;
  }
  return matched ? Math.round(total * 1000) / 1000 : undefined;
}

/**
 * Stdout of a runner that prints machine-readable records (`go test -json`, PHPUnit `--teamcity`):
 * feeds complete, unsplit lines to the test parser and returns each line's console text.
 */
export class TestStdout {
  private pending = "";
  constructor(
    private readonly feedLine: (line: string) => void,
    private readonly display: (line: string) => string,
  ) {}
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
    return this.display(line);
  }
}
