/**
 * Test runner output parsing. Each framework parser turns plain output lines
 * (ANSI already stripped) into events; `TestResults` folds them into a tree.
 */
import type { OutputChunk } from "@/bindings";

export type TestStatus = "running" | "passed" | "failed" | "skipped";

export interface TestLocation {
  path: string;
  /** 1-based, as printed. */
  line?: number;
  col?: number;
  /** `name`: a file name to look up in the project (JVM / Go frames); `rubyTest`: a test to search for (`rubyTests.ts`). */
  resolve: "path" | "name" | "rubyTest";
  /** JVM frames: the class's binary name; `path` is then the file under its package directory. */
  className?: string;
  /** No line: the describe chain and name of a JS test to find in the file (Cypress reports none). */
  test?: string[];
}

export type TestEvent =
  | { type: "start"; path: string[] }
  | { type: "result"; path: string[]; status: Exclude<TestStatus, "running">; durationMs?: number }
  | { type: "location"; path: string[]; location: TestLocation }
  | { type: "output"; path: string[]; line: string }
  | { type: "summary"; passed?: number; failed?: number; skipped?: number; durationMs?: number }
  /** A watch mode cycle begins: its results replace the previous ones. */
  | { type: "reset" }
  /** A watch mode cycle has reported all its results. */
  | { type: "end" };

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

/** Formats a duration the way the test tree shows it: `850 ms`, `1.25 s`, `2 m 5 s`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace(/\.?0+$/, "")} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} m ${s % 60} s`;
}

/**
 * Stdout of a runner that prints machine-readable records (`go test -json`, PHPUnit `--teamcity`):
 * feeds complete, unsplit lines to the test parser and returns their console text. A line shows as
 * stdout, or as a chunk of its own kind (a test's stderr reported on stdout, `testStdErr`).
 */
export class TestStdout {
  private pending = "";
  constructor(
    private readonly feedLine: (line: string) => void,
    private readonly display: (line: string) => string | OutputChunk,
  ) {}
  feed(text: string): OutputChunk[] {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    return this.chunks(lines);
  }
  end(): OutputChunk[] {
    const pending = this.pending;
    this.pending = "";
    return pending ? this.chunks([pending]) : [];
  }
  /** Consecutive lines of one kind in one chunk. */
  private chunks(lines: string[]): OutputChunk[] {
    const out: OutputChunk[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      this.feedLine(line);
      const shown = this.display(line);
      const chunk = typeof shown === "string" ? { kind: "stdout" as const, text: shown } : shown;
      if (!chunk.text) continue;
      const last = out[out.length - 1];
      if (last?.kind === chunk.kind) last.text += chunk.text;
      else out.push({ ...chunk });
    }
    return out;
  }
}
