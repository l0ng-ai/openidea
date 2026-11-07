import type { JvmClassRow } from "@/platform/ipc";

export type SortKey = "name" | "instances" | "deltaInstances" | "bytes";

export interface RowQuery {
  filter: string;
  sort: SortKey;
  desc: boolean;
  changedOnly: boolean;
}

/** Filter, then sort a copy of `rows`; rows without a delta always sort last so a baseline-less table stays readable. */
export function visibleRows(rows: readonly JvmClassRow[], q: RowQuery): JvmClassRow[] {
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
    return dir * (a[q.sort] - b[q.sort]);
  });
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(n: number): string {
  let value = n;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** `null` (no baseline) renders empty; negatives use U+2212 so they align with `+`. */
export function formatDelta(n: number | null): string {
  if (n == null) return "";
  if (n > 0) return `+${n}`;
  return n < 0 ? `−${-n}` : "0";
}
