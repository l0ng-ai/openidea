import type { HeapClassDiff, HeapClassRow, HeapObjectRow } from "@/platform/ipc";
import { formatBytes } from "../../memory/rows";

export type ClassSort = "name" | "count" | "shallow" | "retained" | "countDiff" | "retainedDiff";

export interface ClassQuery {
  filter: string;
  sort: ClassSort;
  desc: boolean;
}

export const DEFAULT_CLASS_QUERY: ClassQuery = { filter: "", sort: "retained", desc: true };

/** Change against the compared snapshot; `null` for a name several classes share, which cannot be matched (F19). */
export type ClassChange = { count: number; retained: number } | null;

export function changesByName(diffs: readonly HeapClassDiff[]): Map<string, ClassChange> {
  return new Map(
    diffs.map((d) => [
      d.name,
      d.ambiguous ? null : { count: d.count - d.baseCount, retained: d.retained - d.baseRetained },
    ]),
  );
}

/**
 * Filter, then sort a copy of `rows`. A row without a change (unmatched name) sorts last both ways, like the Memory
 * table's rows without a baseline.
 */
export function visibleClasses(
  rows: readonly HeapClassRow[],
  q: ClassQuery,
  changes?: ReadonlyMap<string, ClassChange>,
): HeapClassRow[] {
  const needle = q.filter.trim().toLowerCase();
  const kept = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : [...rows];
  const dir = q.desc ? -1 : 1;
  const sort = q.sort;
  if (sort === "countDiff" || sort === "retainedDiff") {
    const field = sort === "countDiff" ? "count" : "retained";
    return kept.sort((a, b) => {
      const ca = changes?.get(a.name)?.[field];
      const cb = changes?.get(b.name)?.[field];
      if (ca === undefined || cb === undefined) return (ca === undefined ? 1 : 0) - (cb === undefined ? 1 : 0);
      return dir * (ca - cb);
    });
  }
  if (sort === "name") return kept.sort((a, b) => dir * a.name.localeCompare(b.name));
  return kept.sort((a, b) => dir * (a[sort] - b[sort]));
}

/** A size change; negatives use U+2212 so they align with `+`, as `formatDelta` does for counts. */
export function formatBytesDelta(n: number): string {
  if (n > 0) return `+${formatBytes(n)}`;
  return n < 0 ? `−${formatBytes(-n)}` : formatBytes(0);
}

/** Share of the reachable heap an object keeps alive. */
export function retainedShare(retained: number, reachableBytes: number): string {
  return reachableBytes > 0 ? `${((100 * retained) / reachableBytes).toFixed(1)}%` : "—";
}

export const objectName = (o: HeapObjectRow): string => `${o.className}@${o.address}`;
