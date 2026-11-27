import { describe, expect, test } from "vitest";
import { compare, toolDrift } from "./golden.ts";

describe("compare", () => {
  test("a perfect answer", () => {
    expect(compare({ usages: ["a:1", "b:2"] }, { usages: ["b:2", "a:1"] })).toEqual({
      recall: 1,
      precision: 1,
      missing: [],
      extra: [],
    });
  });

  test("dropped and extra results lower recall and precision", () => {
    const c = compare({ usages: ["a:1", "c:3"] }, { usages: ["a:1", "b:2"] });
    expect(c.recall).toBe(0.5);
    expect(c.precision).toBe(0.5);
    expect(c.missing).toEqual(["usages: b:2"]);
    expect(c.extra).toEqual(["usages: c:3"]);
  });

  test("groups are part of the identity", () => {
    expect(compare({ read: ["a:1"] }, { write: ["a:1"] }).recall).toBe(0);
  });

  test("nothing expected", () => {
    expect(compare({}, {})).toMatchObject({ recall: 1, precision: 1 });
    expect(compare({ usages: ["a:1"] }, {})).toMatchObject({ recall: 1, precision: 0 });
  });

  test("nothing found", () => {
    expect(compare({}, { usages: ["a:1"] })).toMatchObject({ recall: 0, precision: 0 });
  });
});

test("toolDrift lists tools that changed since the recording", () => {
  expect(toolDrift({ tools: { jdtls: "1.63.0", java: "21" }, groups: {} }, { jdtls: "1.64.0", java: "21" })).toEqual([
    "jdtls: 1.63.0 → 1.64.0",
  ]);
});
