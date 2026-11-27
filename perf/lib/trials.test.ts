import { describe, expect, test } from "vitest";
import { evidenceJson, metricErrors, summarizeMetrics, summarizeTrials, type Trial } from "./trials.ts";

const measured = (metrics: Record<string, number>, index: number): Trial => {
  const errors = metricErrors(metrics, ["ms"]);
  return {
    phase: "measured",
    index,
    metrics,
    status: errors.length ? "invalid" : "ok",
    error: errors.join("; ") || undefined,
  };
};

describe("trial integrity", () => {
  test.each([NaN, Infinity, -Infinity])("does not hide a nonfinite repetition (%s)", (bad) => {
    const trials = [measured({ ms: 1 }, 1), measured({ ms: bad }, 2), measured({ ms: 3 }, 3)];
    const summary = summarizeTrials(trials, 3);
    expect(summary.metrics.ms).toBeNaN();
    expect(summary.error).toContain("measured 2");
    expect(summary.counts).toMatchObject({ valid: 2, attempted: 3, planned: 3 });
    expect(JSON.parse(evidenceJson(trials))[1].metrics.ms).toBe(String(bad));
  });
  test("missing required metrics and missing repetitions cannot shrink the denominator", () => {
    const trials = [measured({ ms: 1 }, 1), measured({ other: 2 }, 2)];
    const summary = summarizeTrials(trials, 3);
    expect(summary.metrics.ms).toBeNaN();
    expect(summary.error).toContain("ms is missing");
    expect(summary.error).toContain("2/3 attempted");
    expect(summary.counts).toMatchObject({ valid: 1, attempted: 2, planned: 3 });
  });
  test("a failed warmup remains fatal alongside good measured runs", () => {
    const trials: Trial[] = [
      { phase: "warmup", index: 1, status: "error", metrics: {}, error: "startup failed" },
      measured({ ms: 1 }, 1),
    ];
    const summary = summarizeTrials(trials, 1);
    expect(summary.metrics.ms).toBe(1);
    expect(summary.error).toContain("warmup 1: startup failed");
    expect(summary.counts).toMatchObject({ warmupValid: 0, warmupAttempted: 1 });
  });
  test("retains worst correctness and median timing without filtering invalid entries", () => {
    expect(
      summarizeMetrics(
        [
          { ms: 3, recall: 1 },
          { ms: 1, recall: 0.5 },
        ],
        ["recall"],
      ),
    ).toEqual({ ms: 1, recall: 0.5 });
    expect(summarizeMetrics([{ ms: 1 }, { ms: NaN }]).ms).toBeNaN();
  });
});
