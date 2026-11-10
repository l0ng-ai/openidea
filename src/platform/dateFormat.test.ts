import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_FORMAT, formatClock, formatDay, formatPattern } from "./dateFormat";

describe("dateFormat", () => {
  const d = new Date(2026, 10, 5, 9, 7);
  const system = { ...DEFAULT_DATE_FORMAT, overrideSystem: false };
  const long = { year: "numeric", month: "short", day: "numeric" } as const;

  it("formats like the locale methods it replaces", () => {
    expect(formatDay(d, system)).toBe(d.toLocaleDateString(undefined, long));
    expect(formatDay(d, system, true)).toBe(
      d.toLocaleDateString(undefined, { year: "2-digit", month: "2-digit", day: "2-digit" }),
    );
    expect(formatClock(d, system)).toBe(d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
    expect(formatPattern(d, "MMMM MMM dd.MM.yyyy")).toBe("November Nov 05.11.2026");
  });

  it("formats another date with the same cached formatter", () => {
    const e = new Date(2025, 0, 31);
    formatDay(d, system);
    expect(formatDay(e, system)).toBe(e.toLocaleDateString(undefined, long));
  });
});
