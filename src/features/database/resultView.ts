/**
 * Pure helpers of the result views: IDEA's local filter and client-side sort
 * of loaded rows, the Aggregates of a selection, and the series of the chart.
 */
import type { Cell } from "./model";

/** Column index → the values still shown (IDEA's local filter: checked values). */
export type LocalFilter = ReadonlyMap<number, ReadonlySet<Cell>>;

export interface LocalSort {
  column: number;
  descending: boolean;
}

const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Numbers by value, then text; NULL first (as most databases sort ascending). */
export function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (NUMBER.test(a) && NUMBER.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : 1;
}

/**
 * The loaded rows to show, in order: those passing every column filter,
 * sorted by `sort` (stable, original order otherwise). Rows past `fixed`
 * (the table editor's added rows) always stay, last.
 */
export function visibleRows(
  rowCount: number,
  value: (row: number, col: number) => Cell,
  filter: LocalFilter,
  sort: LocalSort | null,
  fixed = rowCount,
): number[] {
  const rows: number[] = [];
  for (let r = 0; r < Math.min(rowCount, fixed); r++) {
    let shown = true;
    for (const [col, allowed] of filter) {
      if (!allowed.has(value(r, col))) {
        shown = false;
        break;
      }
    }
    if (shown) rows.push(r);
  }
  if (sort) {
    const dir = sort.descending ? -1 : 1;
    rows.sort((a, b) => dir * compareCells(value(a, sort.column), value(b, sort.column)) || a - b);
  }
  for (let r = fixed; r < rowCount; r++) rows.push(r);
  return rows;
}

/** Distinct values of a column with their counts, sorted (the filter popup's list). */
export function distinctValues(
  rowCount: number,
  value: (row: number, col: number) => Cell,
  col: number,
  limit = 1000,
): Array<{ value: Cell; count: number }> {
  const counts = new Map<Cell, number>();
  for (let r = 0; r < rowCount; r++) {
    const v = value(r, col);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts]
    .map(([v, count]) => ({ value: v, count }))
    .sort((a, b) => compareCells(a.value, b.value))
    .slice(0, limit);
}

/** The new filter after toggling `v` of column `col` (all checked again: no filter). */
export function toggleFilterValue(
  filter: LocalFilter,
  col: number,
  all: readonly Cell[],
  v: Cell,
  checked: boolean,
): LocalFilter {
  const next = new Map(filter);
  const current = new Set(filter.get(col) ?? all);
  if (checked) current.add(v);
  else current.delete(v);
  if (all.every((x) => current.has(x))) next.delete(col);
  else next.set(col, current);
  return next;
}

export interface Aggregates {
  count: number;
  distinct: number;
  nulls: number;
  /** When every non-NULL value is a number; null otherwise. */
  sum: number | null;
  avg: number | null;
  min: Cell;
  max: Cell;
  median: number | null;
}

/** IDEA's Aggregates view of the selected cells. */
export function aggregates(cells: readonly Cell[]): Aggregates {
  const present = cells.filter((c): c is string => c !== null);
  const numbers = present.filter((c) => NUMBER.test(c)).map(Number);
  const numeric = numbers.length > 0 && numbers.length === present.length;
  const sorted = [...present].sort(compareCells);
  let median: number | null = null;
  if (numeric) {
    const n = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(n.length / 2);
    median = n.length % 2 ? n[mid]! : (n[mid - 1]! + n[mid]!) / 2;
  }
  const sum = numeric ? numbers.reduce((a, b) => a + b, 0) : null;
  return {
    count: cells.length,
    distinct: new Set(cells).size,
    nulls: cells.length - present.length,
    sum,
    avg: sum === null ? null : sum / numbers.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median,
  };
}

/** A number for display: integers as is, others to at most 6 significant decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

export type ChartAggregate = "sum" | "avg" | "count" | "min" | "max" | "none";

export interface ChartPoint {
  label: string;
  value: number;
}

/**
 * The chart's series: `y` per distinct `x` (in first-seen order), combined with
 * `agg`; `none` plots every row as is. Non-numeric `y` values are skipped
 * (except for `count`).
 */
export function chartSeries(
  rows: ReadonlyArray<readonly Cell[]>,
  x: number,
  y: number,
  agg: ChartAggregate,
): ChartPoint[] {
  if (agg === "none")
    return rows
      .filter((r) => r[y] !== null && NUMBER.test(r[y]!))
      .map((r) => ({ label: r[x] ?? "<null>", value: Number(r[y]) }));
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const label = r[x] ?? "<null>";
    const v = r[y] ?? null;
    if (!groups.has(label)) groups.set(label, []);
    if (agg === "count") groups.get(label)!.push(1);
    else if (v !== null && NUMBER.test(v)) groups.get(label)!.push(Number(v));
  }
  const combine = (v: number[]): number => {
    if (!v.length) return 0;
    switch (agg) {
      case "sum":
      case "count":
        return v.reduce((a, b) => a + b, 0);
      case "avg":
        return v.reduce((a, b) => a + b, 0) / v.length;
      case "min":
        return Math.min(...v);
      case "max":
        return Math.max(...v);
    }
  };
  return [...groups].map(([label, v]) => ({ label, value: combine(v) }));
}

/** Round axis ticks from 0 (or the minimum, when negative) to `max`. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  if (out.at(-1)! < hi) out.push(Number((out.at(-1)! + step).toPrecision(12)));
  return out;
}
