/**
 * Verdicts: each scenario run under each condition passes or fails on its own numbers
 * (budgets, correctness, degradation, errors), and is compared with the local baseline.
 */
import { readFileSync } from "node:fs";
import type { Comparison, ResultSet } from "./golden.ts";

export type Condition = "warm" | "cold";

export interface Diagnostics {
  /** Commands sent to the server during the slowest measured run (session ms). */
  calls: Array<{ cmd: string; start: number; ms: number; ok: boolean; bytes: number; items?: number; pending?: true }>;
  tasks: Array<{ title: string; start: number; end: number | null }>;
  servers: Array<{ at: number; name: string; status: string; message: string | null }>;
  /** The slowest run's window in session milliseconds. */
  window: [number, number];
  serverLog: string;
  trace?: string;
}

export interface Outcome {
  scenario: string;
  title: string;
  condition: Condition;
  /** Medians of the measured runs (correctness: the worst run). */
  metrics: Record<string, number>;
  samples: Record<string, number[]>;
  results?: ResultSet;
  comparison?: Comparison;
  /** Notes of the tools whose versions differ from the golden's. */
  drift?: string[];
  /** Why the answer is weaker than a semantic one (syntax fallback, incomplete search), if it is. */
  degraded?: string | null;
  error?: string;
  diagnostics?: Diagnostics;
}

export type FailureKind = "error" | "timeout" | "degraded" | "correctness" | "budget" | "golden";

export interface Failure {
  kind: FailureKind;
  metric?: string;
  value?: number;
  limit?: number;
  detail: string;
}

export interface Regression {
  metric: string;
  value: number;
  baseline: number;
}

export interface Verdict {
  id: string;
  scenario: string;
  condition: Condition;
  title: string;
  status: "pass" | "fail";
  failures: Failure[];
  regressions: Regression[];
  improvements: Regression[];
  metrics: Record<string, number>;
  baseline?: Record<string, number>;
  repro: string;
}

export interface Budgets {
  regressionTolerance: number;
  regressionFloorMs: number;
  /** Applied to every scenario. `*Ms`: upper bounds; `recall` / `precision`: lower bounds. */
  defaults: Record<string, number>;
  /** By `<scenario>` or `<scenario>@<condition>` (the latter wins). */
  scenarios: Record<string, Record<string, number>>;
}

export function loadBudgets(file: string): Budgets {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Budgets>;
  return {
    regressionTolerance: raw.regressionTolerance ?? 0.2,
    regressionFloorMs: raw.regressionFloorMs ?? 200,
    defaults: raw.defaults ?? {},
    scenarios: raw.scenarios ?? {},
  };
}

export const idOf = (o: { scenario: string; condition: Condition }) => `${o.scenario}@${o.condition}`;

function budgetsFor(b: Budgets, o: Outcome): Record<string, number> {
  return { ...b.defaults, ...b.scenarios[o.scenario], ...b.scenarios[idOf(o)] };
}

const lowerBound = (metric: string) => metric === "recall" || metric === "precision";

export function judge(
  outcomes: Outcome[],
  budgets: Budgets,
  baseline: Outcome[] | null,
  repro: (o: Outcome) => string,
): Verdict[] {
  const base = new Map((baseline ?? []).map((o) => [idOf(o), o.metrics]));
  return outcomes.map((o) => {
    const failures: Failure[] = [];
    if (o.error) failures.push({ kind: /timed out/.test(o.error) ? "timeout" : "error", detail: o.error });
    if (o.degraded) failures.push({ kind: "degraded", detail: o.degraded });
    if (o.results && !o.comparison && !o.error)
      failures.push({ kind: "golden", detail: "no golden recorded: run with --update-golden and review it" });
    for (const [metric, limit] of Object.entries(budgetsFor(budgets, o))) {
      const value = o.metrics[metric];
      if (value === undefined || !Number.isFinite(value)) continue;
      const over = lowerBound(metric) ? value < limit : value > limit;
      if (!over) continue;
      if (lowerBound(metric)) {
        const c = o.comparison;
        const list = metric === "recall" ? c?.missing : c?.extra;
        const shown = (list ?? []).slice(0, 8).join("; ");
        failures.push({
          kind: "correctness",
          metric,
          value,
          limit,
          detail: `${metric} ${value.toFixed(2)} < ${limit} (${metric === "recall" ? "missing" : "unexpected"}: ${shown}${(list?.length ?? 0) > 8 ? "; …" : ""})`,
        });
      } else {
        failures.push({
          kind: "budget",
          metric,
          value,
          limit,
          detail: `${metric} ${Math.round(value)} ms > ${limit} ms`,
        });
      }
    }
    const before = base.get(idOf(o));
    const regressions: Regression[] = [];
    const improvements: Regression[] = [];
    if (before) {
      for (const [metric, value] of Object.entries(o.metrics)) {
        const was = before[metric];
        if (was === undefined || !metric.endsWith("Ms") || !Number.isFinite(value) || !Number.isFinite(was)) continue;
        const slack = Math.max(was * budgets.regressionTolerance, budgets.regressionFloorMs);
        if (value > was + slack) regressions.push({ metric, value, baseline: was });
        else if (value < was - slack) improvements.push({ metric, value, baseline: was });
      }
    }
    return {
      id: idOf(o),
      scenario: o.scenario,
      condition: o.condition,
      title: o.title,
      status: failures.length ? "fail" : "pass",
      failures,
      regressions,
      improvements,
      metrics: o.metrics,
      baseline: before,
      repro: repro(o),
    };
  });
}

const fmt = (metric: string, v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? "–" : metric.endsWith("Ms") ? String(Math.round(v)) : v.toFixed(2);

const COLUMNS = ["feedbackMs", "firstResultMs", "completeMs", "recall", "precision"];

/** The verdicts as a table (Markdown when `md`), with the baseline in parentheses. */
export function table(verdicts: Verdict[], md: boolean): string {
  const head = ["scenario", ...COLUMNS, "verdict"];
  const rows = verdicts.map((v) => [
    v.id,
    ...COLUMNS.map((m) => {
      const now = fmt(m, v.metrics[m]);
      const was = v.baseline?.[m];
      return was === undefined || !m.endsWith("Ms") ? now : `${now} (${fmt(m, was)})`;
    }),
    v.status === "fail"
      ? `FAIL: ${v.failures.map((f) => f.kind + (f.metric ? ` ${f.metric}` : "")).join(", ")}`
      : v.regressions.length
        ? `regressed: ${v.regressions.map((r) => r.metric).join(", ")}`
        : v.improvements.length
          ? `improved: ${v.improvements.map((r) => r.metric).join(", ")}`
          : "ok",
  ]);
  if (md) {
    return [
      `| ${head.join(" | ")} |`,
      `| ${head.map((_, i) => (i === 0 || i === head.length - 1 ? "---" : "---:")).join(" | ")} |`,
      ...rows.map((r) => `| ${r.join(" | ")} |`),
    ].join("\n");
  }
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 || i === head.length - 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}
