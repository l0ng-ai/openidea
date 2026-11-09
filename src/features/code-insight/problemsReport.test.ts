import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, FileProblems } from "@/bindings";

const state = vi.hoisted(() => ({
  projectChanged: () => {},
  remoteChanged: () => {},
  report: vi.fn(),
}));
const reports = vi.hoisted(() => [] as [boolean, FileProblems[]][]);
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  call: (promise: Promise<unknown>) => promise,
  commands: {
    mcpReportProblems: async (reset: boolean, files: FileProblems[]) => {
      reports.push([reset, files]);
      await state.report();
    },
  },
}));

vi.mock("@/platform/project", () => ({
  useProject: {
    getState: () => ({ project: { root: "/p" } }),
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      state.projectChanged = () => fn({ project: { root: "/p" } }, { project: null });
      return () => {};
    },
  },
}));

vi.mock("@/platform/remote", () => ({
  isRemoteWindow: () => true,
  useRemote: {
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      state.remoteChanged = () => fn({ session: {} }, { session: {} });
      return () => {};
    },
  },
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
    state.report.mockReset();
    applyDiagnosticsEvent("/p/a.rs", "ra", [d(1), d(2)]);
    stop = reportProblems();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it.each(["projectChanged", "remoteChanged"] as const)("resends the full snapshot after %s", async (change) => {
    await vi.advanceTimersByTimeAsync(1000);
    state[change]();
    await vi.advanceTimersByTimeAsync(1000);
    expect(summary()).toEqual([
      [true, [["/p/a.rs", 2]]],
      [true, [["/p/a.rs", 2]]],
    ]);
  });

  it("retries a failed delta with the full snapshot", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    state.report.mockRejectedValueOnce(new Error("disconnected"));
    applyDiagnosticsEvent("/p/b.rs", "ra", [d(0)]);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(summary()).toEqual([
      [true, [["/p/a.rs", 2]]],
      [false, [["/p/b.rs", 1]]],
      [
        true,
        [
          ["/p/a.rs", 2],
          ["/p/b.rs", 1],
        ],
      ],
    ]);
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
