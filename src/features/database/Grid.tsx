/**
 * Result / table data grid: virtualised rows, resizable columns, rectangular
 * cell selection (click, ⇧-click, arrows, ⌘A), copy as TSV / CSV, `<null>`
 * rendering, sortable headers and in-place editing (table editor).
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { Icon, showContextMenu, type MenuItem } from "@/ui";
import { parseDelimited, toCsv, toTsv, type Cell } from "./model";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

export interface GridColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
}

const NUMERIC_TYPE = /int|num|dec|real|float|double|money|serial|^bit$/i;
const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Numbers are right-aligned (IDEA): by type, else when every sampled value is one. */
export function isNumericColumn(type: string, sample: readonly Cell[]): boolean {
  if (type && !/^(null|unknown)?$/i.test(type)) return NUMERIC_TYPE.test(type) && !/point|interval/i.test(type);
  const values = sample.filter((v): v is string => v !== null);
  return values.length > 0 && values.every((v) => NUMBER.test(v));
}

export interface GridProps {
  columns: readonly GridColumn[];
  rowCount: number;
  /** Displayed value (pending edits applied). */
  value: (row: number, col: number) => Cell;
  rowState?: (row: number) => "deleted" | "inserted" | null;
  isModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: Cell) => void;
  sort?: ReadonlyArray<{ column: string; descending: boolean }>;
  onSort?: (column: string, add: boolean) => void;
  /** Extra context menu items for the selected rows. */
  rowMenu?: (rows: number[]) => MenuItem[];
  /** Row number shown for row 0 (paging). */
  firstRowNumber?: number;
  /** Row number shown for a row (local sort / filter reorder them); `firstRowNumber + row` otherwise. */
  rowNumber?: (row: number) => number;
  /** The selected range changed (the Record / Value / Aggregates panel follows it). */
  onSelectionChange?: (range: GridRange | null) => void;
  /** The header's filter button (IDEA's local filter); `filtered` marks the columns with one. */
  onFilter?: (col: number, anchor: HTMLElement) => void;
  filtered?: (col: number) => boolean;
  "aria-label"?: string;
}

/** A selected block of cells, inclusive; `lead` is the cell last moved to. */
export interface GridRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
  lead: { row: number; col: number };
}

interface Sel {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

const ROW_H = 24;
const NUM_W = 48;

/** Wide enough for the whole header (icon, name, filter, sort) and the longest sampled value. */
function initialWidth(c: GridColumn, sample: Cell[], decorations: number): number {
  const header = c.name.length * 8 + 32 + decorations;
  const longest = Math.max(...sample.map((v) => Math.min((v ?? "<null>").length, 60)), 0) * 7.5 + 20;
  return Math.max(64, Math.min(360, Math.max(header, longest)));
}

/** SQLite renders whole REALs as `3108.0`; IDEA shows `3108`. */
const displayed = (v: string, numeric: boolean) => (numeric && /^-?\d+\.0$/.test(v) ? v.slice(0, -2) : v);

function norm(s: Sel) {
  return {
    top: Math.min(s.r0, s.r1),
    bottom: Math.max(s.r0, s.r1),
    left: Math.min(s.c0, s.c1),
    right: Math.max(s.c0, s.c1),
  };
}

export function Grid(props: GridProps) {
  const { columns, rowCount, value, editable, onEdit, sort, onSort, rowMenu, firstRowNumber = 1 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const columnKey = columns.map((c) => c.name).join("\u0000");
  const [widths, setWidths] = useState<number[]>([]);
  const [numeric, setNumeric] = useState<boolean[]>([]);
  useEffect(() => {
    const sampleRows = Math.min(rowCount, 50);
    const samples = columns.map((_, ci) => Array.from({ length: sampleRows }, (_, r) => value(r, ci)));
    const decorations = (props.onFilter ? 20 : 0) + (onSort ? 20 : 0);
    setWidths(columns.map((c, ci) => initialWidth(c, samples[ci]!, decorations)));
    setNumeric(columns.map((c, ci) => isNumericColumn(c.type, samples[ci]!)));
    setSel(null);
    setEditing(null);
    // Re-measure only when the column set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKey]);

  const { onSelectionChange } = props;
  useEffect(() => {
    onSelectionChange?.(
      sel && rowCount ? { ...norm(sel), lead: { row: Math.min(sel.r1, rowCount - 1), col: sel.c1 } } : null,
    );
  }, [sel, rowCount, onSelectionChange]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const totalWidth = useMemo(() => NUM_W + widths.reduce((a, b) => a + b, 0), [widths]);
  const template = `${NUM_W}px ${widths.map((w) => `${w}px`).join(" ")}`;

  const selected = (r: number, c: number) => {
    if (!sel) return false;
    const n = norm(sel);
    return r >= n.top && r <= n.bottom && c >= n.left && c <= n.right;
  };

  const selectedRows = (): number[] => {
    if (!sel) return [];
    const n = norm(sel);
    return Array.from({ length: n.bottom - n.top + 1 }, (_, i) => n.top + i);
  };

  const copy = (format: "tsv" | "csv", header: boolean, wholeRows = false) => {
    if (!sel) return;
    const n = norm(sel);
    const cols = wholeRows
      ? columns.map((_, i) => i)
      : Array.from({ length: n.right - n.left + 1 }, (_, i) => n.left + i);
    const rows = selectedRows().map((r) => cols.map((c) => value(r, c)));
    const head = header ? cols.map((c) => columns[c]!.name) : null;
    const text = format === "tsv" ? toTsv(head, rows) : toCsv(head, rows);
    void navigator.clipboard?.writeText(text);
  };

  const commit = () => {
    if (!editing) return;
    const prev = value(editing.row, editing.col);
    if (editing.text !== (prev ?? "") || prev === null) {
      if (!(prev === null && editing.text === "")) onEdit?.(editing.row, editing.col, editing.text);
    }
    setEditing(null);
    scrollRef.current?.focus();
  };

  const startEdit = (row: number, col: number) => {
    if (!editable || props.rowState?.(row) === "deleted") return;
    setEditing({ row, col, text: value(row, col) ?? "" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copy("tsv", false);
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (rowCount && columns.length) setSel({ r0: 0, c0: 0, r1: rowCount - 1, c1: columns.length - 1 });
      return;
    }
    if (!sel) return;
    if ((e.key === "Enter" || e.key === "F2") && editable) {
      e.preventDefault();
      startEdit(sel.r1, sel.c1);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const r = Math.max(0, Math.min(rowCount - 1, sel.r1 + m[0]));
    const c = Math.max(0, Math.min(columns.length - 1, sel.c1 + m[1]));
    setSel(e.shiftKey ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
    virtualizer.scrollToIndex(r, { align: "auto" });
  };

  const onCellMouseDown = (e: MouseEvent, r: number, c: number) => {
    if (e.button !== 0) {
      if (!selected(r, c)) setSel({ r0: r, c0: c, r1: r, c1: c });
      return;
    }
    if (editing) commit();
    e.preventDefault();
    scrollRef.current?.focus();
    dragging.current = true;
    setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !editable || !onEdit || !sel) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const rows = parseDelimited(text, "\t");
    const { top, left } = norm(sel);
    let bottom = top;
    let right = left;
    rows.forEach((cells, dr) =>
      cells.forEach((cell, dc) => {
        const row = top + dr,
          col = left + dc;
        if (row >= rowCount || col >= columns.length || props.rowState?.(row) === "deleted") return;
        onEdit(row, col, cell);
        bottom = Math.max(bottom, row);
        right = Math.max(right, col);
      }),
    );
    setSel({ r0: top, c0: left, r1: bottom, c1: right });
  };

  const onRowNumberMouseDown = (e: MouseEvent, r: number) => {
    if (e.button !== 0 && sel && selected(r, 0)) return;
    const last = columns.length - 1;
    setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: last } : { r0: r, c0: 0, r1: r, c1: last });
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (!sel) return;
    const items: MenuItem[] = [
      { label: "Copy", shortcut: "⌘C", run: () => copy("tsv", false) },
      { label: "Copy with Header", run: () => copy("tsv", true) },
      { label: "Copy Rows as TSV", run: () => copy("tsv", true, true) },
      { label: "Copy Rows as CSV", run: () => copy("csv", true, true) },
    ];
    if (editable && onEdit) {
      const n = norm(sel);
      items.push(
        { kind: "separator" },
        { label: "Edit Cell", disabled: n.top !== n.bottom || n.left !== n.right, run: () => startEdit(n.top, n.left) },
        {
          label: "Set NULL",
          run: () => {
            for (let r = n.top; r <= n.bottom; r++) for (let c = n.left; c <= n.right; c++) onEdit(r, c, null);
          },
        },
      );
    }
    const extra = rowMenu?.(selectedRows()) ?? [];
    if (extra.length) items.push({ kind: "separator" }, ...extra);
    showContextMenu(e, items);
  };

  const startResize = (e: MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths[col] ?? 100;
    const move = (ev: globalThis.MouseEvent) =>
      setWidths((w) => w.map((x, i) => (i === col ? Math.max(40, start + ev.clientX - startX) : x)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      ref={scrollRef}
      className={styles.grid}
      tabIndex={0}
      role="grid"
      aria-label={props["aria-label"] ?? "Results"}
      aria-rowcount={rowCount}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onContextMenu={onContextMenu}
    >
      <div className={styles.gridInner} style={{ width: totalWidth, height: virtualizer.getTotalSize() + ROW_H }}>
        <div className={clsx(styles.gridRow, styles.gridHeader)} style={{ gridTemplateColumns: template }} role="row">
          <div className={styles.rowNumber} />
          {columns.map((c, ci) => {
            const s = sort?.find((k) => k.column === c.name);
            return (
              <div
                key={ci}
                role="columnheader"
                className={clsx(styles.headerCell, onSort && styles.sortable)}
                title={`${c.name}: ${c.type}${onSort ? "\nClick to sort, ⇧-click to add to the sort" : ""}`}
                onClick={(e) => onSort?.(c.name, e.shiftKey)}
              >
                <Icon
                  name={c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column"}
                  size={16}
                  className={styles.headerIcon}
                />
                <span className={styles.headerName}>{c.name}</span>
                {props.onFilter && (
                  <button
                    type="button"
                    className={clsx(styles.headerFilter, props.filtered?.(ci) && styles.headerFilterOn)}
                    aria-label={`Filter ${c.name}`}
                    title={tx("Local filter")}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onFilter?.(ci, e.currentTarget);
                    }}
                  >
                    <Icon name="filter" size={12} />
                  </button>
                )}
                {s ? (
                  <Icon name={s.descending ? "arrow-down" : "arrow-up"} size={12} className={styles.headerSort} />
                ) : (
                  onSort && <Icon name="db-sort" size={16} className={styles.headerSort} />
                )}
                <span
                  className={styles.resizer}
                  onMouseDown={(e) => startResize(e, ci)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>
        {virtualizer.getVirtualItems().map((v) => {
          const r = v.index;
          const state = props.rowState?.(r) ?? null;
          return (
            <div
              key={v.key}
              role="row"
              className={clsx(
                styles.gridRow,
                state === "deleted" && styles.rowDeleted,
                state === "inserted" && styles.rowInserted,
              )}
              style={{ gridTemplateColumns: template, transform: `translateY(${v.start + ROW_H}px)` }}
            >
              <div className={styles.rowNumber} onMouseDown={(e) => onRowNumberMouseDown(e, r)}>
                {state === "inserted" ? "+" : (props.rowNumber?.(r) ?? firstRowNumber + r)}
              </div>
              {columns.map((_, c) => {
                if (editing && editing.row === r && editing.col === c) {
                  return (
                    <input
                      key={c}
                      className={styles.cellEditor}
                      autoFocus
                      aria-label={`Edit ${columns[c]!.name}`}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") {
                          setEditing(null);
                          scrollRef.current?.focus();
                        }
                      }}
                    />
                  );
                }
                const val = value(r, c);
                return (
                  <div
                    key={c}
                    role="gridcell"
                    className={clsx(
                      styles.cell,
                      numeric[c] && styles.cellNumber,
                      selected(r, c) && styles.cellSelected,
                      props.isModified?.(r, c) && styles.cellModified,
                    )}
                    onMouseDown={(e) => onCellMouseDown(e, r, c)}
                    onMouseEnter={() => {
                      if (dragging.current) setSel((s) => (s ? { ...s, r1: r, c1: c } : s));
                    }}
                    onDoubleClick={() => startEdit(r, c)}
                    title={val != null && val.length > 40 ? val.slice(0, 2000) : undefined}
                  >
                    {val === null ? <span className={styles.null}>&lt;null&gt;</span> : displayed(val, !!numeric[c])}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
