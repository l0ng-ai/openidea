import { describe, expect, it } from "vitest";
import type { BlameLine } from "@/platform/ipc";
import { authorLabel, authorSummary, authorTooltip } from "./authorLens";

const line = (author: string, timeMs: number | null, commit = "a".repeat(40)): BlameLine => ({
  commit,
  author,
  timeMs,
  summary: "",
});
const UNCOMMITTED = "0".repeat(40);

/** What the label's date suffix looks like for an epoch-ms time (the same formatting `formatDay` uses). */
const dateOf = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(ms));

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
    expect(authorLabel(s)).toBe(`Thomas +2 ${dateOf(300)}`);
    expect(authorTooltip(s)).toBe("Last changed by Thomas; also Bob, Ann");
  });

  it("shows a single author without a count", () => {
    const s = authorSummary(blame, 3, 3)!;
    expect(s.timeMs).toBe(50);
    expect(authorLabel(s)).toBe(`Ann ${dateOf(50)}`);
    expect(authorTooltip(s)).toBe("Last changed by Ann");
  });

  it("ignores uncommitted lines and lines past the blame", () => {
    expect(authorSummary(blame, 4, 4)).toBeNull();
    expect(authorLabel(authorSummary(blame, 4, 99)!)).toBe(`Carol ${dateOf(900)}`);
    expect(authorSummary(blame, 10, 12)).toBeNull();
  });

  it("leaves the date off when the latest change has no timestamp", () => {
    const s = authorSummary([line("Carol", null, "c".repeat(40))], 0, 0)!;
    expect(s.timeMs).toBe(0);
    expect(authorLabel(s)).toBe("Carol");
  });
});
