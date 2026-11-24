import { describe, expect, test } from "vitest";
import { planSelection } from "./selection.ts";

const scenarios = [
  { id: "java.a.one", title: "One", conditions: ["warm", "cold"] as const },
  { id: "java.b.two", title: "Two", conditions: ["warm"] as const },
];

describe("eval workload planning", () => {
  test("full and deduplicated subset plans are independent of collected outcomes", () => {
    expect(planSelection(scenarios, {}).expected).toHaveLength(3);
    const plan = planSelection(scenarios, { only: " java.a, java.a.one ", condition: "cold" });
    expect(plan.selected).toEqual([scenarios[0]]);
    expect(plan.expected).toEqual([{ scenario: "java.a.one", title: "One", condition: "cold" }]);
  });
  test.each([
    { condition: "hot" },
    { only: "java.a,unknown" },
    { only: "" },
    { only: "java.a," },
    { only: "java.b", condition: "cold" },
    { only: "java.a,java.b", condition: "cold" },
    { runs: "0" },
    { runs: "NaN" },
    { runs: "Infinity" },
    { runs: "1.5" },
    { runs: "9007199254740992" },
    { warmup: "-1" },
    { warmup: "Infinity" },
    { warmup: "0.5" },
  ])("rejects invalid selection/counts %j", (args) => {
    expect(() => planSelection(scenarios, args)).toThrow();
  });
  test("rejects zero work", () => {
    expect(() => planSelection([], {})).toThrow(/no compatible/);
  });
});
