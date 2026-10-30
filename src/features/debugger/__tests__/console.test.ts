import * as settings from "@/platform/workflowSettings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptSession, appendConsole, appendConsoleQueued, clearConsole, useDebug } from "../state";

const lines = (session: number) => useDebug.getState().console[session] ?? [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const id of Object.keys(useDebug.getState().console)) clearConsole(+id);
  useDebug.setState({ console: {}, sessions: {}, active: null });
});

describe("debug console", () => {
  it("renders ANSI colours instead of showing the escapes", () => {
    // A logback pattern whose colour spans the line break (`%boldMagenta(%logger{36}%n)`), with CRLF.
    appendConsole(
      5,
      "stdout",
      "\x1b[36m2026-10-29 09:13:55\x1b[0;39m \x1b[32m[main]\x1b[0;39m \x1b[1;35mo.d.c.p.l.MessageTopicListener\r\n",
    );
    appendConsole(5, "stdout", "\x1b[0;39m - 初始化消息主题订阅监听器成功\r\n");
    const [first, second] = lines(5);
    expect(first!.text).toBe("2026-10-29 09:13:55 [main] o.d.c.p.l.MessageTopicListener\n");
    expect(first!.spans[0]).toEqual({ text: "2026-10-29 09:13:55", fg: "var(--ansi-cyan)" });
    expect(first!.spans).toContainEqual({ text: "[main]", fg: "var(--ansi-green)" });
    expect(first!.spans.at(-1)).toEqual({
      text: "o.d.c.p.l.MessageTopicListener\n",
      fg: "var(--ansi-magenta)",
      bold: true,
    });
    expect(second!.text).toBe(" - 初始化消息主题订阅监听器成功\n");
    expect(second!.spans).toEqual([{ text: " - 初始化消息主题订阅监听器成功\n" }]);
    expect(lines(5).some((l) => l.text.includes("\x1b"))).toBe(false);
  });

  it("keeps a colour across output events and an escape split between them", () => {
    appendConsole(6, "stderr", "\x1b[3");
    appendConsole(6, "stderr", "1mred ");
    appendConsole(6, "stderr", "still\x1b[0m plain\n");
    const [line] = lines(6);
    expect(line!.text).toBe("red still plain\n");
    expect(line!.spans).toEqual([{ text: "red still", fg: "var(--ansi-red)" }, { text: " plain\n" }]);
    // Streams of other categories and sessions have their own state.
    appendConsole(6, "stdout", "\x1b[32mgreen");
    appendConsole(7, "stdout", "plain\n");
    expect(lines(7)[0]!.spans).toEqual([{ text: "plain\n" }]);
    clearConsole(6);
    appendConsole(6, "stdout", "after clear\n");
    expect(lines(6)[0]!.spans).toEqual([{ text: "after clear\n" }]);
  });
});

describe("multiline output", () => {
  it("splits styled chunks into physical lines and keeps partial-line identity", () => {
    appendConsole(10, "stdout", "prefix ");
    const first = lines(10)[0]!;
    appendConsole(10, "stdout", "\x1b[31mred\n\nlast\x1b[0m");
    expect(lines(10).map((line) => line.text)).toEqual(["prefix red\n", "\n", "last"]);
    expect(lines(10)[0]!.id).toBe(first.id);
    expect(first.text).toBe("prefix ");
    expect(lines(10)[1]!.spans).toEqual([{ text: "\n", fg: "var(--ansi-red)" }]);
    appendConsole(10, "stderr", "error\n");
    appendConsole(10, "stdout", "next\n");
    expect(lines(10).map((line) => line.category)).toEqual(["stdout", "stdout", "stdout", "stderr", "stdout"]);
  });

  it("keeps per-frame batching while bounding one event containing 60k lines", () => {
    vi.useFakeTimers();
    adoptSession(11);
    const listener = vi.fn();
    const unsubscribe = useDebug.subscribe(listener);
    appendConsoleQueued(11, "stdout", "line\n".repeat(60_000));
    appendConsoleQueued(11, "stdout", "tail\n");
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(lines(11).length).toBeLessThanOrEqual(50_000);
    expect(lines(11).length).toBeGreaterThan(40_000);
    expect(lines(11).at(-1)!.text).toBe("tail\n");
    expect(lines(11).every((line) => line.text === "line\n" || line.text === "tail\n")).toBe(true);
    expect(new Set(lines(11).map((line) => line.id)).size).toBe(lines(11).length);
  });

  it("trims a multiline event by the configured character buffer", () => {
    const current = settings.workflowSettings();
    vi.spyOn(settings, "workflowSettings").mockReturnValue({
      ...current,
      console: { ...current.console, overrideBuffer: true, bufferKb: 8 },
    });
    appendConsole(12, "stdout", ("x".repeat(4000) + "\n").repeat(6000));
    const output = lines(12);
    expect(output.length).toBeGreaterThan(0);
    expect(output.reduce((n, line) => n + line.text.length + 1, 0)).toBeLessThanOrEqual(8 * 1024);
    expect(output.every((line) => line.text.length === 4001)).toBe(true);
  });
});
