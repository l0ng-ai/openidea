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

describe("judge", () => {
  test("within budgets and matching the golden passes", () => {
    const [v] = judge([outcome({})], budgets, null, repro);
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
      [outcome({ condition: "cold", metrics: { feedbackMs: 40, completeMs: 5000, recall: 1, precision: 1 } })],
      budgets,
      null,
      repro,
    );
    expect(v!.status).toBe("pass");
  });

  test("timeouts and missing goldens fail", () => {
    const [timedOut, noGolden] = judge(
      [outcome({ error: "find.showUsages timed out after 30000 ms" }), outcome({ comparison: undefined })],
      budgets,
      null,
      repro,
    );
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
    );
    expect(v!.status).toBe("pass");
    expect(v!.regressions.map((r) => r.metric)).toEqual(["completeMs"]);
    expect(table([v!], false)).toContain("regressed: completeMs");
  });
});
