import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, FileProblems } from "@/bindings";

const reports = vi.hoisted(() => [] as [boolean, FileProblems[]][]);
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  call: (promise: Promise<unknown>) => promise,
  commands: {
    mcpReportProblems: async (reset: boolean, files: FileProblems[]) => {
      reports.push([reset, files]);
    },
  },
}));

vi.mock("@/platform/project", () => ({
  useProject: { getState: () => ({ project: { root: "/p" } }), subscribe: () => () => {} },
}));

const { applyDiagnosticsEvent, clearProblems } = await import("./problemsStore");
const { reportProblems } = await import("./problemsReport");

const d = (line: number): Diagnostic => ({
  range: { start: { line, col: 0 }, end: { line, col: 1 } },
  severity: "error",
  message: `line ${line}`,
  source: null,
  code: null,
});

const summary = () => reports.map(([reset, files]) => [reset, files.map((f) => [f.path, f.items.length])]);

describe("reportProblems", () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    clearProblems();
    reports.length = 0;
    applyDiagnosticsEvent("/p/a.rs", "ra", [d(1), d(2)]);
    stop = reportProblems();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("sends everything first, then only the files that changed once diagnostics settle", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    applyDiagnosticsEvent("/p/b.rs", "ra", [d(0)]);
    applyDiagnosticsEvent("/p/a.rs", "ra", []);
    await vi.advanceTimersByTimeAsync(500);
    expect(reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    applyDiagnosticsEvent("/p/b.rs", "clippy", [d(3)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(summary()).toEqual([
      [true, [["/p/a.rs", 2]]],
      [
        false,
        [
          ["/p/b.rs", 1],
          ["/p/a.rs", 0],
        ],
      ],
      [false, [["/p/b.rs", 2]]],
    ]);
  });
});
