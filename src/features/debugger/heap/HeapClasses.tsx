/** The Classes view of a heap snapshot: one row per class, sortable, filterable, with the change against another snapshot. */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Input, List, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import type { HeapClassRow } from "@/platform/ipc";
import { formatBytes, formatCount, formatDelta } from "../memory/rows";
import {
  DEFAULT_CLASS_QUERY,
  formatBytesDelta,
  visibleClasses,
  type ClassChange,
  type ClassQuery,
  type ClassSort,
} from "./editor/classRows";
import styles from "./HeapSnapshotEditor.module.css";

const COLUMNS: ReadonlyArray<{ key: ClassSort; label: string; numeric: boolean; diff?: boolean }> = [
  { key: "name", label: "Class", numeric: false },
  { key: "count", label: "Count", numeric: true },
  { key: "shallow", label: "Shallow Size", numeric: true },
  { key: "retained", label: "Retained Size", numeric: true },
  { key: "countDiff", label: "Count Diff", numeric: true, diff: true },
  { key: "retainedDiff", label: "Retained Diff", numeric: true, diff: true },
];

function ClassRow({ row, changes }: { row: HeapClassRow; changes: ReadonlyMap<string, ClassChange> | null }) {
  const change = changes?.get(row.name);
  return (
    <div className={styles.row} role="none">
      <span role="gridcell" className={clsx(styles.cell, styles.className)}>
        {row.name}
      </span>
      <span role="gridcell" className={clsx(styles.cell, styles.num)}>
        {formatCount(row.count)}
      </span>
      <span role="gridcell" className={clsx(styles.cell, styles.num)}>
        {formatBytes(row.shallow)}
      </span>
      <span role="gridcell" className={clsx(styles.cell, styles.num)}>
        {formatBytes(row.retained)}
      </span>
      {changes && (
        <>
          <span role="gridcell" className={clsx(styles.cell, styles.num, !change?.count && styles.muted)}>
            {change ? formatDelta(change.count) : "—"}
          </span>
          <span role="gridcell" className={clsx(styles.cell, styles.num, !change?.retained && styles.muted)}>
            {change ? formatBytesDelta(change.retained) : "—"}
          </span>
        </>
      )}
    </div>
  );
}

/** `changes`: by class name against the compared snapshot, or `null` when nothing is compared. */
export function HeapClasses({
  classes,
  changes,
  selected,
  onSelect,
}: {
  classes: readonly HeapClassRow[];
  changes: ReadonlyMap<string, ClassChange> | null;
  selected: number | null;
  onSelect: (row: HeapClassRow | null) => void;
}) {
  const tx = useTx();
  const [query, setQuery] = useState<ClassQuery>(DEFAULT_CLASS_QUERY);
  const compared = changes !== null;
  const columns = COLUMNS.filter((c) => compared || !c.diff);
  // A diff sort outlives the comparison it sorted by: fall back to the default order.
  const sorted = useMemo(
    () =>
      compared || !COLUMNS.find((c) => c.key === query.sort)?.diff
        ? query
        : { ...query, sort: DEFAULT_CLASS_QUERY.sort },
    [query, compared],
  );
  const rows = useMemo(() => visibleClasses(classes, sorted, changes ?? undefined), [classes, sorted, changes]);
  const sortBy = (key: ClassSort) =>
    setQuery((q) =>
      sorted.sort === key ? { ...q, sort: key, desc: !sorted.desc } : { ...q, sort: key, desc: key !== "name" },
    );

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Input
          className={styles.filter}
          value={query.filter}
          onChange={(e) => setQuery((q) => ({ ...q, filter: e.target.value }))}
          placeholder="Filter classes"
          aria-label="Filter classes"
        />
      </div>
      <div
        className={clsx(styles.table, styles.classColumns, changes && styles.withDiff)}
        role="grid"
        aria-label={tx("Classes")}
        aria-rowcount={rows.length + 1}
      >
        <div role="rowgroup">
          <div className={styles.head} role="row" aria-rowindex={1}>
            {columns.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                aria-sort={sorted.sort === c.key ? (sorted.desc ? "descending" : "ascending") : "none"}
                className={clsx(styles.headCell, c.numeric && styles.numeric, sorted.sort === c.key && styles.sorted)}
              >
                <button type="button" onClick={() => sortBy(c.key)}>
                  <T>{c.label}</T>
                </button>
              </div>
            ))}
          </div>
        </div>
        <List
          className={styles.list}
          items={rows}
          getKey={(r) => String(r.classIndex)}
          renderItem={(r) => <ClassRow row={r} changes={changes} />}
          activeIndex={selected === null ? -1 : rows.findIndex((r) => r.classIndex === selected)}
          onActiveChange={(i) => onSelect(rows[i] ?? null)}
          rowHeight={22}
          tableBody={{ headerRows: 1 }}
          empty={<span className={styles.note}>{tx("No matches")}</span>}
        />
      </div>
    </div>
  );
}
