// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SAMPLE_TUI_START, sampleTuiFrame } from "./sampleTui";

function screen(term: Terminal): string[] {
  const buffer = term.buffer.active;
  return Array.from({ length: term.rows }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? "");
}

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

describe("sampleTuiFrame", () => {
  it("repaints the full screen and retitles, with only the spinner row changing", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    await write(term, SAMPLE_TUI_START + sampleTuiFrame(0, 80, 24));
    const first = screen(term);
    await write(term, sampleTuiFrame(1, 80, 24));
    const second = screen(term);

    expect(term.buffer.active.type).toBe("alternate");
    expect(first.filter((line) => line.trim()).length).toBeGreaterThan(20);
    const changed = first.map((line, y) => (line === second[y] ? -1 : y)).filter((y) => y >= 0);
    expect(changed).toEqual([24 - 7]);
    expect(titles).toEqual(["⠋ Thinking - sample", "⠙ Thinking - sample"]);
    term.dispose();
  });
});
