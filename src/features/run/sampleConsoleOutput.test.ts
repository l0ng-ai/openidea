import { describe, expect, it, vi } from "vitest";
import { openSampleConsoleSession, runtime, startSampleConsoleOutput, useRun } from "./store";

describe("sample console output for the perf harness", () => {
  it("generates unique long lines in startSampleConsoleOutput", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    try {
      await startSampleConsoleOutput({ mode: "long", count: 6, perFrame: 3, lineLength: 10_240 });
      const activeId = useRun.getState().activeSession!;
      const lines = runtime(activeId)!.console.lines;
      // Six 10 KiB lines split into six 8,000-char heads and six 2,239-char tails: all 12 chunks must be unique.
      const longChunks = lines.filter((l) => l.text.length >= 2_000).map((l) => l.text);
      expect(longChunks).toHaveLength(12);
      expect(new Set(longChunks).size).toBe(12);
    } finally {
      rafSpy.mockRestore();
    }
  });

  it("opens an empty perf session before streaming into it for no-newline output", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    try {
      const sessionId = openSampleConsoleSession("no-lf");
      expect(useRun.getState().activeSession).toBe(sessionId);
      expect(runtime(sessionId)!.console.lines).toHaveLength(0);

      const sessionsBefore = useRun.getState().sessions.length;
      await startSampleConsoleOutput({ mode: "no-lf", sessionId, count: 300, perFrame: 100 });
      // Must stream into the already-mounted session rather than opening a second one.
      expect(useRun.getState().sessions).toHaveLength(sessionsBefore);
      const wideLines = runtime(sessionId)!.console.lines.filter((l) => l.text.length === 8_000);
      expect(wideLines.length).toBeGreaterThanOrEqual(2);
      expect(new Set(wideLines.map((l) => l.text)).size).toBe(wideLines.length);
    } finally {
      rafSpy.mockRestore();
    }
  });
});
