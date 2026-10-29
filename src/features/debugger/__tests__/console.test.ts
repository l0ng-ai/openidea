import { afterEach, describe, expect, it } from "vitest";
import { appendConsole, clearConsole, useDebug } from "../state";

const lines = (session: number) => useDebug.getState().console[session] ?? [];

afterEach(() => useDebug.setState({ console: {} }));

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
