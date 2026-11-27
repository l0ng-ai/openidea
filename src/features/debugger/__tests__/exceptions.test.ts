import { describe, expect, it } from "vitest";
import type { ExceptionFilter } from "@/platform/ipc";
import {
  anyException,
  exceptionGroups,
  isFilterEnabled,
  mergeKnown,
  sanitizeChoices,
  sanitizeKnown,
} from "../breakpoints/exceptions";

const f = (filter: string, def = false): ExceptionFilter => ({
  filter,
  label: filter[0]!.toUpperCase() + filter.slice(1),
  description: null,
  default: def,
  supportsCondition: false,
});

describe("exception breakpoints", () => {
  it("explicit choices win over adapter defaults", () => {
    expect(isFilterEnabled(f("uncaught", true), {})).toBe(true);
    expect(isFilterEnabled(f("uncaught", true), { uncaught: false })).toBe(false);
    expect(isFilterEnabled(f("raised"), { raised: true })).toBe(true);
  });

  it("groups filters by adapter with effective state", () => {
    const groups = exceptionGroups(
      { debugpy: [f("raised"), f("uncaught", true)], codelldb: [f("rust_panic")] },
      { raised: true },
    );
    expect(groups.map((g) => g.adapter)).toEqual(["codelldb", "debugpy"]);
    expect(groups[1]!.filters.map((x) => [x.filter, x.enabled])).toEqual([
      ["raised", true],
      ["uncaught", true],
    ]);
  });

  it("merges session filters into the cache without churn", () => {
    const known = { debugpy: [f("raised")] };
    expect(mergeKnown(known, [{ adapter: "debugpy", filters: [f("raised")] }])).toBe(known);
    expect(mergeKnown(known, [{ adapter: "debugpy", filters: [] }])).toBe(known);
    expect(mergeKnown(known, [{ adapter: "delve", filters: [f("panic")] }])).toEqual({ ...known, delve: [f("panic")] });
  });

  it("sanitizes persisted data", () => {
    expect(sanitizeChoices({ a: true, b: "x", c: false })).toEqual({ a: true, c: false });
    expect(sanitizeChoices([1])).toEqual({});
    expect(sanitizeKnown({ x: [f("a"), { nope: 1 }], y: "z" })).toEqual({ x: [f("a")] });
  });

  it("reads Any exception from the choices java-debug's filters were stored under", () => {
    const known = { "java-debug": [f("caught"), f("uncaught")] };
    expect(anyException(known, {})).toEqual({ caught: false, uncaught: false });
    expect(anyException(known, { "java-debug:caught": true, uncaught: true })).toEqual({
      caught: true,
      uncaught: true,
    });
    expect(anyException({}, { "java-debug:uncaught": true })).toEqual({ caught: false, uncaught: true });
  });
});
