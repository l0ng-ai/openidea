/** Steps side by side, each element linked by a curve to the element of the step before it came from. */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { formatCount } from "../memory/rows";
import { formatJvmValue } from "../memory/values";
import type { Column, Edge } from "./layout";
import styles from "./StreamTraceEditor.module.css";

const ROW = 24;
const GAP = 48;
/** Cells drawn per column; a 50 000-record trace would otherwise mount that many buttons and curves. */
export const CELL_LIMIT = 1000;

export interface TraceSelection {
  selected: number | null;
  related: ReadonlySet<number>;
  onSelect: (index: number) => void;
}

/** `slots[i]` is the row of record `i` in its column; `edgesInto[step]` the edges ending in that step. */
export function TraceColumns({
  columns,
  slots,
  edgesInto,
  selection,
  trailing,
}: {
  columns: Column[];
  slots: Int32Array;
  edgesInto: ReadonlyMap<number, Edge[]>;
  selection: TraceSelection;
  trailing?: ReactNode;
}) {
  return (
    <div className={styles.flow} style={{ "--trace-row": `${ROW}px`, "--trace-gap": `${GAP}px` } as CSSProperties}>
      {columns.map((c, i) => (
        <Fragment key={c.step}>
          {i > 0 && (
            <Curves
              rows={Math.max(shown(columns[i - 1]!), shown(c))}
              edges={edgesInto.get(c.step) ?? []}
              slots={slots}
              related={selection.related}
            />
          )}
          <TraceColumn column={c} selection={selection} />
        </Fragment>
      ))}
      {trailing}
    </div>
  );
}

const shown = (c: Column) => Math.min(c.items.length, CELL_LIMIT);

function TraceColumn({ column, selection }: { column: Column; selection: TraceSelection }) {
  const { selected, related, onSelect } = selection;
  return (
    <section className={styles.column} data-testid="stream-trace-column" data-step={column.step}>
      <ColumnHead title={column.title} count={column.items.length} />
      <ul className={styles.cells} aria-label={column.title}>
        {column.items.slice(0, CELL_LIMIT).map(({ index, value }) => (
          <li key={index} className={styles.cellRow}>
            <button
              type="button"
              className={clsx(styles.cell, related.has(index) && styles.related)}
              data-related={related.has(index) || undefined}
              aria-pressed={selected === index}
              onClick={() => onSelect(index)}
            >
              {formatJvmValue(value)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ColumnHead({ title, count }: { title: string; count?: number }) {
  return (
    <div className={styles.columnHead} title={title}>
      <span className={styles.columnTitle}>{title}</span>
      {count !== undefined && <span className={styles.count}>{formatCount(count)}</span>}
    </div>
  );
}

function Curves({
  rows,
  edges,
  slots,
  related,
}: {
  rows: number;
  edges: Edge[];
  slots: Int32Array;
  related: ReadonlySet<number>;
}) {
  const y = (i: number) => slots[i]! * ROW + ROW / 2;
  const mid = GAP / 2;
  return (
    <svg className={styles.curves} width={GAP} height={rows * ROW} aria-hidden="true">
      {edges
        .filter((e) => slots[e.from]! < CELL_LIMIT && slots[e.to]! < CELL_LIMIT)
        .map((e) => (
          <path
            key={e.to}
            d={`M0 ${y(e.from)} C${mid} ${y(e.from)} ${mid} ${y(e.to)} ${GAP} ${y(e.to)}`}
            className={clsx(
              styles.curve,
              e.ambiguous && styles.ambiguous,
              related.has(e.from) && related.has(e.to) && styles.relatedCurve,
            )}
          />
        ))}
    </svg>
  );
}
