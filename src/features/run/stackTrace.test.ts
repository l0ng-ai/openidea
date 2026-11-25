import { describe, expect, it } from "vitest";
import { addStackTrace, countFrames, normalizeTrace, traceTitle, useStackTraces } from "./stackTrace";
import { useRun } from "./store";
import jdk25Sync from "./threadDump/__fixtures__/jdk25-sync.txt?raw";

const JVM = `Exception in thread "main" java.lang.IllegalStateException: boom\r
\tat com.acme.OrderController.list(OrderController.kt:22)   \r
\tat com.acme.Main.main(Main.java:7)\r
`;

describe("Analyze Stack Trace", () => {
  it("normalises pasted text", () => {
    expect(normalizeTrace(`\n\n${JVM}\n\n`)).toBe(
      'Exception in thread "main" java.lang.IllegalStateException: boom\n\tat com.acme.OrderController.list(OrderController.kt:22)\n\tat com.acme.Main.main(Main.java:7)',
    );
  });

  it("titles tabs by the exception", () => {
    expect(traceTitle(normalizeTrace(JVM))).toBe("IllegalStateException");
    expect(traceTitle('Traceback (most recent call last):\n  File "a.py", line 3, in <module>')).toBe(
      "Traceback (most recent call last):",
    );
    expect(traceTitle("thread 'main' panicked at src/main.rs:4:5:\nboom")).toBe(
      "thread 'main' panicked at src/main.rs:4…",
    );
  });

  it("counts frames with source links", () => {
    expect(countFrames(normalizeTrace(JVM))).toBe(2);
    expect(countFrames("just some text")).toBe(0);
    expect(countFrames('  File "app/main.py", line 12, in <module>')).toBe(1);
  });

  it("opens a tab per trace with the trace as console lines", () => {
    expect(addStackTrace("   \n ")).toBeNull();
    const id = addStackTrace(JVM)!;
    const s = useStackTraces.getState();
    expect(useRun.getState().activeSession).toBe(id);
    const tab = s.tabs.find((t) => t.id === id)!;
    if (tab.kind !== "trace") throw new Error("expected a trace tab");
    expect(tab.title).toBe("IllegalStateException");
    expect(tab.model.lines.map((l) => l.text)).toHaveLength(3);
    expect(tab.model.lines[1]!.text).toContain("OrderController.kt:22");
  });

  it("opens a pasted thread dump in the thread viewer", () => {
    const id = addStackTrace(jdk25Sync)!;
    const tab = useStackTraces.getState().tabs.find((t) => t.id === id)!;
    expect(useRun.getState().activeSession).toBe(id);
    if (tab.kind !== "threads") throw new Error("expected a thread dump tab");
    expect(tab.title).toBe("Thread dump");
    expect(tab.source).toBeNull();
    expect(tab.dump.deadlocks).toHaveLength(1);
    expect(tab.dump.threads[tab.selected!]!.name).toBe("sync-1");
  });
});
