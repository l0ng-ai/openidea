import { describe, expect, it } from "vitest";
import type { ConsoleRule } from "@/bindings";
import { compileConsoleRules, matchConsoleRules, styleSpans } from "./consoleRules";

const rule = (pattern: string, extra: Partial<ConsoleRule> = {}): ConsoleRule => ({
  pattern,
  ignoreCase: false,
  foreground: "red",
  background: null,
  styles: [],
  wholeLine: false,
  enabled: true,
  ...extra,
});

const rulesOf = (...lists: [string, ConsoleRule[]][]) => compileConsoleRules(new Map(lists));

describe("console highlight rules", () => {
  it("styles the whole line with the first enabled whole-line rule that matches", () => {
    const set = rulesOf([
      "p",
      [
        rule("AUDIT", { wholeLine: true, enabled: false, foreground: "green" }),
        rule("\\[AUDIT\\]", { wholeLine: true, foreground: "bright-yellow", styles: ["bold", "blink"] }),
        rule("AUDIT", { wholeLine: true, foreground: "blue" }),
      ],
    ]);
    expect(matchConsoleRules("[AUDIT] user=1", "stdout", set)).toEqual({
      line: { fg: "var(--ansi-bright-yellow)", bold: true },
      ranges: [],
    });
    expect(matchConsoleRules("nothing", "stdout", set)).toBeUndefined();
  });

  it("styles every match of match-only rules, an earlier rule winning where they overlap", () => {
    const set = rulesOf([
      "p",
      [rule("job-\\d+", { ignoreCase: true, foreground: "cyan" }), rule("\\d+ done", { foreground: "green" })],
    ]);
    const m = matchConsoleRules("JOB-12 and job-3 done", "stderr", set)!;
    expect(m.line).toBeUndefined();
    expect(m.ranges.map((r) => [r.start, r.end, r.style.fg])).toEqual([
      [0, 6, "var(--ansi-cyan)"],
      [11, 16, "var(--ansi-cyan)"],
      [16, 21, "var(--ansi-green)"],
    ]);
  });

  it("orders plugins by id, skips patterns this engine rejects and colours it doesn't know", () => {
    const set = rulesOf(
      ["b.plugin", [rule("x", { wholeLine: true, foreground: "blue" })]],
      ["a.plugin", [rule("(", { wholeLine: true }), rule("x", { wholeLine: true, foreground: "#ff0000" })]],
    );
    expect(matchConsoleRules("x", "stdout", set)!.line).toEqual({});
  });

  it("leaves streams the IDE owns alone and caches the result per text", () => {
    const set = rulesOf(["p", [rule("x", { wholeLine: true })]]);
    expect(matchConsoleRules("x", "system", set)).toBeUndefined();
    expect(matchConsoleRules("x", "input", set)).toBeUndefined();
    expect(matchConsoleRules("x", "stdout", set)).toBe(matchConsoleRules("x", "stdout", set));
    expect(compileConsoleRules(new Map())).toEqual({ rules: [], cache: new Map() });
  });

  it("matches only the start of a very long line and skips empty matches", () => {
    const set = rulesOf(["p", [rule("x"), rule("y*")]]);
    const text = `x${"-".repeat(3000)}x`;
    expect(matchConsoleRules(text, "stdout", set)!.ranges.map((r) => r.start)).toEqual([0]);
  });

  it("lays rule styles over the program's spans, replacing its colours", () => {
    const set = rulesOf([
      "p",
      [
        rule("ERR", { wholeLine: true, foreground: "red" }),
        rule("id=\\d+", { foreground: null, styles: ["underline"] }),
      ],
    ]);
    const m = matchConsoleRules("ERR id=7 x", "stdout", set)!;
    expect(styleSpans([{ text: "ERR " }, { text: "id=7 x", fg: "var(--ansi-blue)", bold: true }], m)).toEqual([
      { text: "ERR ", fg: "var(--ansi-red)" },
      { text: "id=7", fg: "var(--ansi-red)", bold: true, underline: true },
      { text: " x", fg: "var(--ansi-red)", bold: true },
    ]);
  });
});
