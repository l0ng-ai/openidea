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

  it("overwrites the line after a carriage return, as a progress bar expects (#4280)", () => {
    appendConsole(7, "stdout", "Network: http://localhost:8090/\n");
    appendConsole(7, "stdout", "\x1b[32m━━\x1b[0m (10%) build modules");
    appendConsole(7, "stdout", "\r");
    appendConsole(7, "stdout", "\x1b[32m━━━━━━\x1b[0m (63%) build modules\r");
    // An erase-line escape counts as a carriage return too.
    appendConsole(7, "stdout", "\x1b[2K\x1b[1Gdone in 1.2 s\r");
    appendConsole(7, "stdout", "\n");
    appendConsole(7, "stdout", "next\r\nline\n");
    expect(lines(7).map((l) => l.text)).toEqual([
      "Network: http://localhost:8090/\n",
      "done in 1.2 s\n",
      "next\n",
      "line\n",
    ]);
    expect(lines(7)[1]!.spans).toEqual([{ text: "done in 1.2 s\n" }]);
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

  it("keeps only the newest output of a flood that outpaces the console, and counts what it dropped", () => {
    vi.useFakeTimers();
    adoptSession(14);
    // 8 MiB arrives before the next frame: twice what may wait for it.
    const line = "x".repeat(1023) + "\n";
    for (let i = 0; i < 64; i++) appendConsoleQueued(14, "stdout", line.repeat(128));
    appendConsoleQueued(14, "stdout", "last\n");
    vi.advanceTimersToNextFrame();
    const output = lines(14);
    expect(output.at(-1)!.text).toBe("last\n");
    expect(output.slice(0, -1).every((l) => l.text === line)).toBe(true);
    // At most 4 MiB was parsed; every line that never reached the console is counted.
    expect(output.length).toBeLessThanOrEqual(4097);
    expect(useDebug.getState().consoleDropped[14]).toBe(64 * 128 + 1 - output.length);
  });

  it("counts lines trimmed past the line cap and resets the count on Clear", () => {
    adoptSession(15);
    appendConsole(15, "stdout", "line\n".repeat(60_000));
    expect(useDebug.getState().consoleDropped[15]).toBe(60_000 - lines(15).length);
    clearConsole(15);
    expect(useDebug.getState().consoleDropped[15]).toBe(0);
  });

  it("breaks a line longer than the Run console's limit", () => {
    appendConsole(16, "stdout", "y".repeat(20_000) + "\n");
    expect(lines(16).map((l) => l.text.length)).toEqual([8000, 8000, 4001]);
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

it("flushes output while an unfocused webview suspends animation frames", () => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  adoptSession(13);
  appendConsoleQueued(13, "stdout", "Spring Boot starting…\n");
  expect(lines(13)).toEqual([]);
  vi.advanceTimersByTime(100);
  expect(lines(13).map((l) => l.text)).toEqual(["Spring Boot starting…\n"]);
  expect(useDebug.getState().sessions[13]?.status).toBe("running");
});

it("shows queued output at most at the Max FPS rate (#5897)", () => {
  vi.useFakeTimers();
  const workflow = settings.workflowSettings();
  vi.spyOn(settings, "workflowSettings").mockReturnValue({
    ...workflow,
    terminal: { ...workflow.terminal, maxFps: "5" },
  });
  adoptSession(15);
  appendConsoleQueued(15, "stdout", "one\n");
  vi.advanceTimersToNextFrame();
  expect(lines(15).map((l) => l.text)).toEqual(["one\n"]);
  appendConsoleQueued(15, "stdout", "two\n");
  appendConsoleQueued(15, "stdout", "three\n");
  vi.advanceTimersByTime(150);
  expect(lines(15)).toHaveLength(1);
  vi.advanceTimersByTime(60);
  expect(lines(15).map((l) => l.text)).toEqual(["one\n", "two\n", "three\n"]);
});
