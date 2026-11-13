import { describe, expect, it } from "vitest";
import type { BlameLine } from "@/platform/ipc";
import { dateFormatOptions, formatDay } from "@/platform/dateFormat";
import { authorLabel, authorSummary, authorTooltip } from "./authorLens";

const { useProject } = await import("@/platform/project");

const line = (author: string, timeMs: number | null, commit = "a".repeat(40)): BlameLine => ({
  commit,
  author,
  timeMs,
  summary: "",
});
const UNCOMMITTED = "0".repeat(40);

/** What the app renders for `ms`: the same call the blame gutter and the hints make. */
const appDate = (ms: number, short = false) => formatDay(new Date(ms), dateFormatOptions(), short);

describe("code vision author", () => {
  const blame = [
    line("Ann", 100),
    line("Thomas", 300),
    line("Bob", 200),
    line("Ann", 50),
    line("Not Committed Yet", null, UNCOMMITTED),
    line("Carol", 900),
  ];

  it("names the latest author of the range and counts the others", () => {
    const s = authorSummary(blame, 0, 4)!;
    expect(s.authors).toEqual(["Thomas", "Bob", "Ann"]);
    expect(s.timeMs).toBe(300);
    expect(authorLabel(s)).toBe(`Thomas +2 ${appDate(300, true)}`);
    expect(authorTooltip(s)).toBe(`Last changed by Thomas on ${appDate(300)}; also Bob, Ann`);
  });

  it("shows a single author without a count", () => {
    const s = authorSummary(blame, 3, 3)!;
    expect(s.timeMs).toBe(50);
    expect(authorLabel(s)).toBe(`Ann ${appDate(50, true)}`);
    expect(authorTooltip(s)).toBe(`Last changed by Ann on ${appDate(50)}`);
  });

  it("uses the Date Formats override pattern when enabled", () => {
    useProject.setState({
      settings: { general: { dateFormat: { overrideSystem: true, pattern: "yyyy/MM/dd" } } } as never,
    });
    try {
      expect(authorLabel(authorSummary(blame, 3, 3)!)).toBe("Ann 1970/01/01");
      expect(authorTooltip(authorSummary(blame, 3, 3)!)).toBe("Last changed by Ann on 1970/01/01");
    } finally {
      useProject.setState({ settings: null });
    }
  });

  it("ignores uncommitted lines and lines past the blame", () => {
    expect(authorSummary(blame, 4, 4)).toBeNull();
    expect(authorLabel(authorSummary(blame, 4, 99)!)).toBe(`Carol ${appDate(900, true)}`);
    expect(authorSummary(blame, 10, 12)).toBeNull();
  });

  it("leaves the date off when the latest change has no timestamp", () => {
    const s = authorSummary([line("Carol", null, "c".repeat(40))], 0, 0)!;
    expect(s.timeMs).toBe(0);
    expect(authorLabel(s)).toBe("Carol");
    expect(authorTooltip(s)).toBe("Last changed by Carol");
  });
});
