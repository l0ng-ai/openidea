/** Budget / baseline evaluation and the console + Markdown report. */
import { readFileSync } from "node:fs";
import type { Metrics } from "./harness.ts";

export interface ScenarioResult {
  id: string;
  title: string;
  metrics: Metrics;
  error?: string;
}

/** `<scenario>.<metric>` → upper bound, plus regression tolerance. */
export interface Budgets {
  ui: Record<string, number>;
  rust: Record<string, number>;
  /** Relative slack before a metric counts as regressed against the baseline. */
  regressionTolerance: number;
  /** Absolute slack (metric units) so sub-millisecond noise is not a regression. */
  regressionFloor: number;
}

export function loadBudgets(file: string): Budgets & { ui: Record<string, number> } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Budgets> & Record<string, unknown>;
  return {
    ui: raw.ui ?? {},
    rust: raw.rust ?? {},
    regressionTolerance: raw.regressionTolerance ?? 0.2,
    regressionFloor: raw.regressionFloor ?? 1,
  };
}

/** `over-budget-info`: over budget in a run that does not enforce budgets (CPU throttling). */
export type Verdict = "ok" | "over-budget" | "over-budget-info" | "regressed" | "improved" | "error";

export interface Row {
  key: string;
  value: number;
  budget?: number;
  baseline?: number;
  verdict: Verdict;
}

export interface Report {
  rows: Row[];
  errors: Array<{ id: string; error: string }>;
  /** Budget misses + failed scenarios + budgeted metrics that went missing. */
  failures: number;
  regressions: number;
}

export function evaluate(
  results: ScenarioResult[],
  budgets: Record<string, number>,
  baseline: ScenarioResult[] | null,
  opts: { expected: readonly string[]; enforceBudgets: boolean; tolerance?: number; floor?: number },
): Report {
  const tol = opts.tolerance ?? 0.2;
  const floor = opts.floor ?? 1;
  const base = new Map<string, number>();
  for (const r of baseline ?? []) for (const [k, v] of Object.entries(r.metrics)) base.set(`${r.id}.${k}`, v);

  const rows: Row[] = [];
  const errors: Report["errors"] = [];
  const seen = new Set<string>();
  const expected = new Set(opts.expected);
  const produced = new Set<string>();
  if (!expected.size) errors.push({ id: "run", error: "empty workload" });
  if (expected.size !== opts.expected.length) errors.push({ id: "run", error: "duplicate expected scenario" });
  for (const r of results) {
    if (!expected.has(r.id)) {
      errors.push({ id: r.id, error: "unexpected scenario result" });
      continue;
    }
    if (produced.has(r.id)) {
      errors.push({ id: r.id, error: "duplicate scenario result" });
      continue;
    }
    produced.add(r.id);
    if (!r.error && !Object.keys(r.metrics).length) errors.push({ id: r.id, error: "no metrics produced" });
    if (r.error) errors.push({ id: r.id, error: r.error });
    for (const [m, value] of Object.entries(r.metrics)) {
      const key = `${r.id}.${m}`;
      seen.add(key);
      const budget = budgets[key];
      const before = base.get(key);
      let verdict: Verdict = "ok";
      if (!Number.isFinite(value)) verdict = "error";
      else if (budget !== undefined && value > budget)
        verdict = opts.enforceBudgets ? "over-budget" : "over-budget-info";
      else if (before !== undefined && value > before * (1 + tol) && value - before > floor) verdict = "regressed";
      else if (before !== undefined && value < before * (1 - tol) && before - value > floor) verdict = "improved";
      rows.push({ key, value, budget, baseline: before, verdict });
    }
  }
  for (const id of expected) {
    if (!produced.has(id)) errors.push({ id, error: "missing scenario result" });
  }
  // Required metrics are scoped by the declared workload, never by returned data.
  for (const key of Object.keys(budgets)) {
    if (!seen.has(key) && expected.has(key.slice(0, key.indexOf(".")))) {
      rows.push({ key, value: NaN, budget: budgets[key], verdict: "error" });
    }
  }
  return {
    rows,
    errors,
    failures: errors.length + rows.filter((r) => r.verdict === "over-budget" || r.verdict === "error").length,
    regressions: rows.filter((r) => r.verdict === "regressed").length,
  };
}

const fmt = (v: number | undefined) =>
  v === undefined
    ? ""
    : !Number.isFinite(v)
      ? "–"
      : Math.abs(v) >= 100
        ? v.toFixed(0)
        : Math.abs(v) >= 10
          ? v.toFixed(1)
          : v.toFixed(2);

const MARK: Record<Verdict, string> = {
  ok: "ok",
  "over-budget": "OVER BUDGET",
  "over-budget-info": "over budget (not enforced)",
  regressed: "regressed",
  improved: "improved",
  error: "ERROR",
};

/** Prints the report to stdout and returns it as Markdown. */
export function printReport(report: Report, meta: Record<string, unknown>): string {
  const header = ["metric", "value", "budget", "baseline", ""];
  const lines = report.rows.map((r) => [r.key, fmt(r.value), fmt(r.budget), fmt(r.baseline), MARK[r.verdict]]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const row = (cells: string[]) =>
    cells.map((c, i) => (i === 0 || i === 4 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  console.log();
  console.log(row(header));
  for (const l of lines) console.log(row(l));
  for (const e of report.errors) console.log(`\n${e.id} failed: ${e.error}`);
  console.log(
    `\n${report.failures === 0 ? "PASS" : "FAIL"}: ${report.failures} failure(s), ${report.regressions} regression(s) vs baseline.`,
  );

  const md = [
    "# OpenIDEA performance report",
    "",
    Object.entries(meta)
      .map(([k, v]) => `${k}: \`${String(v)}\``)
      .join(" · "),
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, i) => (i === 0 || i === 4 ? "---" : "---:")).join(" | ")} |`,
    ...lines.map((l) => `| ${l.join(" | ")} |`),
    "",
    ...report.errors.map((e) => `- **${e.id}** failed: ${e.error}`),
  ];
  return md.join("\n") + "\n";
}
