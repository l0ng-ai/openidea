import type { JvmClassRow, JvmMemorySource } from "@/platform/ipc";

export type SortKey = "name" | "instances" | "deltaInstances" | "bytes" | "retained";

export interface RowQuery {
  filter: string;
  sort: SortKey;
  desc: boolean;
  changedOnly: boolean;
}

/**
 * The debugger counts objects without sizes, so its table has no Shallow Size column; Retained Size comes from a heap
 * snapshot of the same stop, joined by class name, and exists only while there is one.
 */
export function columnsOf(source: JvmMemorySource, retained = false): SortKey[] {
  const columns: SortKey[] =
    source === "debugger" ? ["name", "instances", "deltaInstances"] : ["name", "instances", "deltaInstances", "bytes"];
  return retained ? [...columns, "retained"] : columns;
}

/** `q` sorted by a column the table has: a size sort falls back to the count. */
export function queryFor(q: RowQuery, source: JvmMemorySource, retained = false): RowQuery {
  return columnsOf(source, retained).includes(q.sort) ? q : { ...q, sort: "instances" };
}

/**
 * Filter, then sort a copy of `rows`; rows without a delta or a retained size always sort last so a baseline-less
 * table stays readable.
 */
export function visibleRows(
  rows: readonly JvmClassRow[],
  q: RowQuery,
  retained?: ReadonlyMap<string, number>,
): JvmClassRow[] {
  const needle = q.filter.trim().toLowerCase();
  const kept = rows.filter(
    (r) =>
      (!needle || r.name.toLowerCase().includes(needle)) &&
      (!q.changedOnly || (r.deltaInstances != null && r.deltaInstances !== 0)),
  );
  const dir = q.desc ? -1 : 1;
  return kept.sort((a, b) => {
    if (q.sort === "name") return dir * a.name.localeCompare(b.name);
    if (q.sort === "deltaInstances") {
      if (a.deltaInstances == null || b.deltaInstances == null) {
        return (a.deltaInstances == null ? 1 : 0) - (b.deltaInstances == null ? 1 : 0);
      }
      return dir * (a.deltaInstances - b.deltaInstances);
    }
    if (q.sort === "retained") {
      const ra = retained?.get(a.name);
      const rb = retained?.get(b.name);
      if (ra === undefined || rb === undefined) return (ra === undefined ? 1 : 0) - (rb === undefined ? 1 : 0);
      return dir * (ra - rb);
    }
    return dir * (a[q.sort] - b[q.sort]);
  });
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Thousands-grouped count; shared by the Count and Diff columns so they read alike. */
export const formatCount = (n: number): string => n.toLocaleString();

export function formatBytes(n: number): string {
  let value = n;
  let unit = 0;
  // Compare the rounded value so 1048575 B becomes "1.0 MB", not "1024.0 KB".
  while (Math.abs(Number(value.toFixed(1))) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** `null` (no baseline) renders empty; negatives use U+2212 so they align with `+`. */
export function formatDelta(n: number | null): string {
  if (n == null) return "";
  if (n > 0) return `+${formatCount(n)}`;
  return n < 0 ? `−${formatCount(-n)}` : "0";
}
