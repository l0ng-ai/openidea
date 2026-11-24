import { describe, expect, test } from "vitest";
import { judge, table, type Budgets, type Outcome } from "./verdict.ts";

const budgets: Budgets = {
  regressionTolerance: 0.2,
  regressionFloorMs: 200,
  defaults: { feedbackMs: 100, recall: 1, precision: 1 },
  scenarios: { usages: { completeMs: 2000 }, "usages@cold": { completeMs: 10_000 } },
};

const outcome = (o: Partial<Outcome>): Outcome => ({
  scenario: "usages",
  title: "Show Usages",
  condition: "warm",
  metrics: { feedbackMs: 40, firstResultMs: 300, completeMs: 500, recall: 1, precision: 1 },
  samples: {},
  results: { usages: ["a:1"] },
  comparison: { recall: 1, precision: 1, missing: [], extra: [] },
  ...o,
});

const repro = () => "pnpm eval --only usages";
const expected = [{ scenario: "usages", title: "Show Usages", condition: "warm" as const }];

describe("judge", () => {
  test("within budgets and matching the golden passes", () => {
    const [v] = judge([outcome({})], budgets, null, repro, expected);
    expect(v).toMatchObject({ id: "usages@warm", status: "pass", failures: [], repro: "pnpm eval --only usages" });
  });

  test("slow feedback, dropped results and silent degradation each fail", () => {
    const [v] = judge(
      [
        outcome({
          metrics: { feedbackMs: 250, firstResultMs: 300, completeMs: 2500, recall: 0.5, precision: 1 },
          comparison: { recall: 0.5, precision: 1, missing: ["usages: b:2"], extra: [] },
          degraded: "Based on syntax",
        }),
      ],
      budgets,
      null,
      repro,
      expected,
    );
    expect(v!.status).toBe("fail");
    expect(v!.failures.map((f) => [f.kind, f.metric])).toEqual([
      ["degraded", undefined],
      ["budget", "feedbackMs"],
      ["correctness", "recall"],
      ["budget", "completeMs"],
    ]);
    expect(v!.failures.find((f) => f.metric === "recall")!.detail).toContain("usages: b:2");
  });

  test("condition budgets override scenario budgets", () => {
    const [v] = judge(
      [
        outcome({
          condition: "cold",
          metrics: { feedbackMs: 40, firstResultMs: 300, completeMs: 5000, recall: 1, precision: 1 },
        }),
      ],
      budgets,
      null,
      repro,
      [{ ...expected[0]!, condition: "cold" }],
    );
    expect(v!.status).toBe("pass");
  });

  test("timeouts and missing goldens fail", () => {
    const [timedOut] = judge(
      [outcome({ error: "find.showUsages timed out after 30000 ms" })],
      budgets,
      null,
      repro,
      expected,
    );
    const [noGolden] = judge([outcome({ comparison: undefined })], budgets, null, repro, expected);
    expect(timedOut!.failures[0]!.kind).toBe("timeout");
    expect(noGolden!.failures[0]!.kind).toBe("golden");
  });

  test("regressions need both the relative tolerance and the absolute floor", () => {
    const baseline = [outcome({ metrics: { feedbackMs: 40, firstResultMs: 300, completeMs: 500 } })];
    const [v] = judge(
      [outcome({ metrics: { feedbackMs: 90, firstResultMs: 450, completeMs: 1200, recall: 1, precision: 1 } })],
      budgets,
      baseline,
      repro,
      expected,
    );
    expect(v!.status).toBe("pass");
    expect(v!.regressions.map((r) => r.metric)).toEqual(["completeMs"]);
    expect(table([v!], false)).toContain("regressed: completeMs");
  });

  test("missing, duplicate, unexpected and empty workloads fail", () => {
    for (const actual of [[], [outcome({}), outcome({})], [outcome({ scenario: "other" })]]) {
      expect(judge(actual, budgets, null, repro, expected).some((v) => v.status === "fail")).toBe(true);
    }
    expect(judge([], budgets, null, repro, []).some((v) => v.status === "fail")).toBe(true);
  });

  test.each(["feedbackMs", "firstResultMs", "completeMs", "recall", "precision"])("requires finite %s", (metric) => {
    for (const value of [undefined, NaN, Infinity, -Infinity]) {
      const o = outcome({});
      if (value === undefined) delete o.metrics[metric];
      else o.metrics[metric] = value;
      const [v] = judge([o], budgets, null, repro, expected);
      expect(v!.status).toBe("fail");
      expect(v!.failures.some((f) => f.metric === metric)).toBe(true);
    }
  });

  test("requires scenario budget metrics and rejects nonfinite unbudgeted values", () => {
    const custom = { ...budgets, scenarios: { usages: { readyMs: 100 } } };
    expect(judge([outcome({})], custom, null, repro, expected)[0]!.status).toBe("fail");
    const o = outcome({});
    o.metrics.extraMs = NaN;
    expect(judge([o], budgets, null, repro, expected)[0]!.status).toBe("fail");
  });

  test("a clean empty result set with a perfect comparison passes", () => {
    const o = outcome({ results: { problems: [] } });
    expect(judge([o], budgets, null, repro, expected)[0]!.status).toBe("pass");
  });
});
