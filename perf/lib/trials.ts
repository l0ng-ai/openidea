import { median } from "./stats.ts";

export interface Trial {
  phase: "warmup" | "measured";
  index: number;
  status: "ok" | "invalid" | "error" | "timeout";
  metrics: Record<string, number>;
  error?: string;
}

export function metricErrors(metrics: Record<string, number>, required: readonly string[]): string[] {
  const errors: string[] = [];
  if (!Object.keys(metrics).length) errors.push("no metrics produced");
  for (const key of new Set([...required, ...Object.keys(metrics)])) {
    if (!Number.isFinite(metrics[key])) errors.push(`${key} is missing or nonfinite (${String(metrics[key])})`);
  }
  return errors;
}

/** Missing or invalid repetitions poison the summary, never shrink its denominator. */
export function summarizeMetrics(samples: readonly Record<string, number>[], minima: readonly string[] = []) {
  const keys = [...new Set(samples.flatMap((s) => Object.keys(s)))];
  return Object.fromEntries(
    keys.map((key) => {
      const values = samples.map((s) => s[key]!);
      return [key, values.every(Number.isFinite) ? (minima.includes(key) ? Math.min(...values) : median(values)) : NaN];
    }),
  );
}

export function summarizeTrials(trials: readonly Trial[], planned: number) {
  const measured = trials.filter((t) => t.phase === "measured");
  const errors = trials.filter((t) => t.status !== "ok").map((t) => `${t.phase} ${t.index}: ${t.error ?? t.status}`);
  if (measured.length !== planned) errors.push(`measured trials: ${measured.length}/${planned} attempted`);
  return {
    metrics: summarizeMetrics(measured.map((t) => t.metrics)),
    error: errors.length ? errors.join("; ") : undefined,
    counts: {
      planned,
      attempted: measured.length,
      valid: measured.filter((t) => t.status === "ok").length,
      warmupAttempted: trials.length - measured.length,
      warmupValid: trials.filter((t) => t.phase === "warmup" && t.status === "ok").length,
    },
  };
}

export const errorMessage = (error: unknown): string =>
  error instanceof AggregateError
    ? `${error.message}: ${error.errors.map(errorMessage).join("; ")}`
    : error instanceof Error
      ? error.message
      : String(error);

/** JSON has no nonfinite numbers; retain their identity rather than turning them into null. */
export const evidenceJson = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v), 2);
