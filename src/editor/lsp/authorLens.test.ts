import { describe, expect, it } from "vitest";
import type { BlameLine } from "@/platform/ipc";
import { useI18n } from "@/platform/i18n";
import { authorLabel, authorSummary, authorTooltip } from "./authorLens";

const { useProject } = await import("@/platform/project");

const line = (author: string, timeMs: number | null, commit = "a".repeat(40)): BlameLine => ({
  commit,
  author,
  timeMs,
  summary: "",
});
const UNCOMMITTED = "0".repeat(40);

/** The label's numeric date suffix in `tag` for an epoch-ms time (the same formatting the hint uses). */
const dateOf = (ms: number, tag?: string) =>
  new Intl.DateTimeFormat(tag, { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(ms));

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
    expect(authorLabel(s)).toBe(`Thomas +2 ${dateOf(300, "en")}`);
    expect(authorTooltip(s)).toBe("Last changed by Thomas; also Bob, Ann");
  });

  it("shows a single author without a count", () => {
    const s = authorSummary(blame, 3, 3)!;
    expect(s.timeMs).toBe(50);
    expect(authorLabel(s)).toBe(`Ann ${dateOf(50, "en")}`);
    expect(authorTooltip(s)).toBe("Last changed by Ann");
  });

  it("formats the date in the UI language", () => {
    useI18n.setState({ locale: "zh" });
    try {
      expect(authorLabel(authorSummary(blame, 3, 3)!)).toBe(`Ann ${dateOf(50, "zh-CN")}`);
    } finally {
      useI18n.setState({ locale: "en" });
    }
  });

  it("uses the Date Formats override pattern when enabled", () => {
    useProject.setState({
      settings: { general: { dateFormat: { overrideSystem: true, pattern: "dd.MM.yyyy" } } } as never,
    });
    try {
      expect(authorLabel(authorSummary(blame, 3, 3)!)).toBe("Ann 01.01.1970");
    } finally {
      useProject.setState({ settings: null });
    }
  });

  it("ignores uncommitted lines and lines past the blame", () => {
    expect(authorSummary(blame, 4, 4)).toBeNull();
    expect(authorLabel(authorSummary(blame, 4, 99)!)).toBe(`Carol ${dateOf(900, "en")}`);
    expect(authorSummary(blame, 10, 12)).toBeNull();
  });

  it("leaves the date off when the latest change has no timestamp", () => {
    const s = authorSummary([line("Carol", null, "c".repeat(40))], 0, 0)!;
    expect(s.timeMs).toBe(0);
    expect(authorLabel(s)).toBe("Carol");
  });
});
