import { describe, expect, it } from "vitest";
import { textColumns, WidestColumns } from "./consoleColumns";

describe("console columns", () => {
  it("counts tabs to the next stop and wide characters twice", () => {
    expect(textColumns("abc", 4)).toBe(3);
    expect(textColumns("a\tb", 4)).toBe(5);
    expect(textColumns("\t\t", 4)).toBe(8);
    expect(textColumns("中文ok", 4)).toBe(6);
    expect(textColumns("😀", 4)).toBe(2);
    expect(textColumns("long line\nshort\n", 4)).toBe(9);
  });

  it("measures only new lines and the growing last one", () => {
    const widest = new WidestColumns();
    const lines = [{ text: "12345" }, { text: "12" }];
    expect(widest.measure(lines)).toBe(5);
    lines[1]!.text = "1234567";
    expect(widest.measure(lines)).toBe(7);
    // Dropping lines from the front keeps the width.
    lines.splice(0, 1);
    lines.push({ text: "1" });
    expect(widest.measure(lines)).toBe(7);
    // A new array of the same line objects (an immutable append) continues from the last one.
    const next = [...lines, { text: "123456789" }];
    expect(widest.measure(next)).toBe(9);
    // A cleared console starts over.
    expect(widest.measure([])).toBe(0);
    expect(widest.measure([{ text: "abc" }])).toBe(3);
  });
});
