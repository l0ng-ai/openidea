import { describe, expect, it } from "vitest";
import { evaluate } from "./report.ts";
import { frameSummary, keySummary, percentile, totalBlockingTime } from "./stats.ts";

describe("stats", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
  });

  it("counts a frame spanning k refresh intervals as k − 1 dropped", () => {
    const s = frameSummary([16.7, 16.7, 33.4, 50.1], 16.7);
    // 1 + 1 + 2 + 3 = 7 intervals, 3 dropped.
    expect(s.droppedFramesPct).toBeCloseTo((100 * 3) / 7);
  });

  it("flags keys whose frame started more than one interval late", () => {
    const s = keySummary([3, 10, 16, 20, 40], 16.7);
    expect(s.missedFramePct).toBe(40);
    expect(s.maxMs).toBe(40);
  });

  it("total blocking time only counts the part above 50 ms", () => {
    expect(totalBlockingTime([{ duration: 30 }, { duration: 80 }, { duration: 120 }])).toBe(100);
  });
});

describe("evaluate", () => {
  const results = [{ id: "typing", title: "", metrics: { p95Ms: 18, maxMs: 40, layoutsPerKey: 3 } }];

  it("fails metrics over budget and budgeted metrics that are missing", () => {
    const r = evaluate(results, { "typing.maxMs": 33, "typing.missedFramePct": 2, "other.x": 1 }, null, {
      enforceBudgets: true,
      expected: ["typing"],
    });
    expect(r.rows.find((x) => x.key === "typing.maxMs")?.verdict).toBe("over-budget");
    expect(r.rows.find((x) => x.key === "typing.missedFramePct")?.verdict).toBe("error");
    // Scenario `other` did not run: its budget is not checked.
    expect(r.rows.some((x) => x.key === "other.x")).toBe(false);
    expect(r.failures).toBe(2);
  });

  it("reports but does not fail budgets when not enforced", () => {
    const r = evaluate(results, { "typing.maxMs": 33 }, null, { enforceBudgets: false, expected: ["typing"] });
    expect(r.rows.find((x) => x.key === "typing.maxMs")?.verdict).toBe("over-budget-info");
    expect(r.failures).toBe(0);
  });

  it("compares against the baseline with relative and absolute slack", () => {
    const baseline = [{ id: "typing", title: "", metrics: { p95Ms: 14, maxMs: 39.5, layoutsPerKey: 2 } }];
    const r = evaluate(results, {}, baseline, {
      enforceBudgets: true,
      expected: ["typing"],
      tolerance: 0.2,
      floor: 1,
    });
    const verdict = (k: string) => r.rows.find((x) => x.key === k)?.verdict;
    expect(verdict("typing.p95Ms")).toBe("regressed"); // +28 %, +4 ms
    expect(verdict("typing.maxMs")).toBe("ok"); // within 20 %
    expect(verdict("typing.layoutsPerKey")).toBe("ok"); // +50 % but only +1 (floor)
    expect(r.regressions).toBe(1);
  });

  it("fails when a declared scenario disappears from the results", () => {
    const report = evaluate(results, { "scroll.jumpMs": 50 }, null, {
      enforceBudgets: true,
      expected: ["typing", "scroll"],
    });
    expect(report.errors).toContainEqual({ id: "scroll", error: "missing scenario result" });
    expect(report.rows.find((r) => r.key === "scroll.jumpMs")?.verdict).toBe("error");
    expect(report.failures).toBeGreaterThan(0);
  });

  it("rejects duplicate and unexpected scenario results", () => {
    const report = evaluate([...results, ...results, { id: "other", title: "", metrics: { ms: 1 } }], {}, null, {
      enforceBudgets: true,
      expected: ["typing"],
    });
    expect(report.errors).toEqual([
      { id: "typing", error: "duplicate scenario result" },
      { id: "other", error: "unexpected scenario result" },
    ]);
  });

  it("rejects an empty workload instead of returning a passing report", () => {
    expect(evaluate([], {}, null, { enforceBudgets: true, expected: [] }).failures).toBeGreaterThan(0);
  });

  it("fails nonfinite metrics even without an absolute budget", () => {
    const report = evaluate([{ id: "typing", title: "", metrics: { ms: Infinity } }], {}, null, {
      enforceBudgets: false,
      expected: ["typing"],
    });
    expect(report.rows[0]?.verdict).toBe("error");
    expect(report.failures).toBe(1);
  });
});
