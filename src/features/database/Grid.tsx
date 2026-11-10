/**
 * Result / table data grid: virtualised rows, resizable columns, rectangular
 * cell selection (click, ⇧-click, arrows, ⌘A), copy as TSV / CSV / One-Row,
 * `<null>` rendering, sortable headers and type-aware in-place editing
 * (booleans toggle, enums pick from their values, Set NULL / Set DEFAULT).
 */
import { writeClipboardText } from "@/platform/clipboard";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { Checkbox, Dialog, Icon, lockDragCursor, Popup, SelectListbox, showContextMenu, type MenuItem } from "@/ui";
import { parseDelimited, toCsv, toOneRow, toTsv, type Cell } from "./model";
import { initialJsonText, isJsonColumn, isJsonValue } from "./jsonValue";
import { JsonValueWindow } from "./JsonValueEditor";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";
import { CELL_PREVIEW_LIMIT, cellPreview, hasLineBreak } from "./cellPreview";
import {
  booleanLiterals,
  defaultLiteralOf,
  enumValuesOfType,
  isBooleanType,
  NULL_INPUT,
  type BooleanLiterals,
} from "./cellEditors";
import { registerCellGrid, type CellActions } from "./cellActions";
import type { DbDriver } from "@/platform/ipc";

export interface GridColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
  /** Whether the column accepts SQL NULL (`undefined`: unknown — the editor assumes it does). */
  nullable?: boolean;
  /** The column's introspected default expression (Set DEFAULT); `null` when it has none. */
  default?: string | null;
  /** The column's allowed values (a caller that knows them; else parsed from the type string). */
  enumValues?: readonly string[];
}

const NUMERIC_TYPE = /int|num|dec|real|float|double|money|serial|^bit$/i;
const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Numbers are right-aligned (IDEA): by type, else when every sampled value is one. */
export function isNumericColumn(type: string, sample: readonly Cell[]): boolean {
  if (type && !/^(null|unknown)?$/i.test(type)) return NUMERIC_TYPE.test(type) && !/point|interval/i.test(type);
  const values = sample.filter((v): v is string => v !== null);
  return values.length > 0 && values.every((v) => NUMBER.test(v));
}

/** The grid's own copy formats (the extractor drop-down chooses one for plain ⌘C). */
export type CopyFormat = "tsv" | "csv" | "onerow";

export interface GridProps {
  columns: readonly GridColumn[];
  rowCount: number;
  /** Displayed value (pending edits applied). */
  value: (row: number, col: number) => Cell;
  /** The format plain ⌘C copies in (the toolbar's extractor; TSV by default). */
  copyFormat?: CopyFormat;
  rowState?: (row: number) => "deleted" | "inserted" | null;
  isModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: Cell) => void;
  /** The data source's driver: which literals boolean editors write (`t`/`f`, `1`/`0`…). */
  driver?: DbDriver;
  /** Omit an inserted cell from the INSERT, so its database default applies. */
  onResetCell?: (row: number, col: number) => void;
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
  /** Cells matching the search bar's query. */
  isMatch?: (row: number, col: number) => boolean;
  /** The search bar's current match: selected and scrolled into view when it changes. */
  currentMatch?: { row: number; col: number } | null;
  /** ⌘F / Ctrl+F in the grid (opens the search bar). */
  onFind?: () => void;
  /** Go to Column: a new object selects that column's cell in the current row, scrolls to it and focuses the grid. */
  revealColumn?: { col: number } | null;
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

/** A cell's text on one line: each line break shows as a muted `↵`. */
function cellText(value: string) {
  const parts = cellPreview(value).split(/\r\n|\r|\n/);
  if (parts.length === 1) return parts[0];
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <span key={i} className={styles.lineBreak}>
            ↵
          </span>,
          part,
        ],
  );
}

function norm(s: Sel) {
  return {
    top: Math.min(s.r0, s.r1),
    bottom: Math.max(s.r0, s.r1),
    left: Math.min(s.c0, s.c1),
    right: Math.max(s.c0, s.c1),
  };
}

export function Grid(props: GridProps) {
  const {
    columns,
    rowCount,
    value,
    editable,
    onEdit,
    sort,
    onSort,
    rowMenu,
    firstRowNumber = 1,
    copyFormat = "tsv",
  } = props;
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
  const [editing, setEditing] = useState<{
    row: number;
    col: number;
    text: string;
    json: boolean;
    dialog: boolean;
  } | null>(null);
  /** The inline editor is being replaced or closed: its blur must not commit again. */
  const skipBlurCommit = useRef(false);
  useEffect(() => {
    if (!editing?.dialog) skipBlurCommit.current = false;
  }, [editing?.dialog]);
  const columnKey = columns.map((c) => c.name).join("\u0000");
  const [widths, setWidths] = useState<number[]>([]);
  const [numeric, setNumeric] = useState<boolean[]>([]);
  /** Boolean columns edit as a checkbox; enum columns offer their allowed values. */
  const bools = columns.map((c) => isBooleanType(c.type, props.driver));
  const enums = columns.map((c) => c.enumValues ?? enumValuesOfType(c.type));
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
  /** Scrolls sideways so column `c` is visible (the first one with the row numbers). */
  const scrollColumnIntoView = (c: number) => {
    const el = scrollRef.current;
    if (!el || c < 0 || c >= widths.length) return;
    const left = c ? NUM_W + widths.slice(0, c).reduce((a, b) => a + b, 0) : 0;
    const right = NUM_W + widths.slice(0, c + 1).reduce((a, b) => a + b, 0);
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(left, right - el.clientWidth);
  };
  const { currentMatch } = props;
  useEffect(() => {
    if (!currentMatch) return;
    const { row, col } = currentMatch;
    setSel({ r0: row, c0: col, r1: row, c1: col });
    virtualizer.scrollToIndex(row, { align: "auto" });
    scrollColumnIntoView(col);
    // Follows the match only, not the virtualizer's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch?.row, currentMatch?.col]);
  const { revealColumn } = props;
  useEffect(() => {
    if (!revealColumn || !rowCount) return;
    const { col } = revealColumn;
    const row = sel ? Math.min(sel.r1, rowCount - 1) : 0;
    setSel({ r0: row, c0: col, r1: row, c1: col });
    virtualizer.scrollToIndex(row, { align: "auto" });
    scrollColumnIntoView(col);
    scrollRef.current?.focus({ preventScroll: true });
    // Runs once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealColumn]);
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

  const copy = (format: CopyFormat, header: boolean, wholeRows = false) => {
    if (!sel) return;
    const n = norm(sel);
    const cols = wholeRows
      ? columns.map((_, i) => i)
      : Array.from({ length: n.right - n.left + 1 }, (_, i) => n.left + i);
    const rows = selectedRows().map((r) => cols.map((c) => value(r, c)));
    const head = header ? cols.map((c) => columns[c]!.name) : null;
    const text =
      format === "onerow"
        ? toOneRow(rows, (c) => !!numeric[cols[c]!])
        : format === "tsv"
          ? toTsv(head, rows)
          : toCsv(head, rows);
    void writeClipboardText(text);
  };

  const commit = () => {
    if (!editing) return;
    skipBlurCommit.current = true;
    const prev = value(editing.row, editing.col);
    // A textarea turns CRLF into LF; a value that used CRLF throughout keeps it.
    const text =
      prev && prev.includes("\r\n") && !/(^|[^\r])\n/.test(prev)
        ? editing.text.replace(/\r?\n/g, "\r\n")
        : editing.text;
    if (text !== (prev ?? "") || prev === null) {
      if (!(prev === null && text === "")) onEdit?.(editing.row, editing.col, text);
    }
    setEditing(null);
    scrollRef.current?.focus();
  };

  /** The JSON value window's Apply / Set NULL: the same pending-edit pipeline as the inline editor. */
  const commitJsonWindow = (text: string | null) => {
    if (!editing) return;
    if (text !== value(editing.row, editing.col)) onEdit?.(editing.row, editing.col, text);
    setEditing(null);
    scrollRef.current?.focus();
  };

  /** `maximized` (⇧Enter): the multi-line editor, which multi-line and long values always use. */
  const startEdit = (row: number, col: number, maximized = false) => {
    if (!editable || props.rowState?.(row) === "deleted") return;
    const cell = value(row, col);
    const text = cell ?? "";
    // JSON cells (type or content) edit in the JSON value editor when the dialog opens (#2333).
    const json = isJsonValue(columns[col]?.type ?? "", cell);
    setEditing({ row, col, text, json, dialog: maximized || text.length > CELL_PREVIEW_LIMIT || hasLineBreak(text) });
  };

  /** The select editor's pick: values are final, so it commits at once (Escape still cancels). */
  const pickSelect = (v: string) => {
    if (!editing) return;
    onEdit?.(editing.row, editing.col, v === NULL_INPUT ? null : v);
    setEditing(null);
    scrollRef.current?.focus();
  };

  const toggleBoolean = (r: number, c: number, lit: BooleanLiterals) => {
    if (!onEdit || props.rowState?.(r) === "deleted") return;
    onEdit(r, c, value(r, c) === lit.t ? lit.f : lit.t);
  };

  /** Set NULL over a range, unless a column is known to reject it. */
  const nullOk = (n: { left: number; right: number }) =>
    Array.from({ length: n.right - n.left + 1 }, (_, i) => columns[n.left + i]!).every((c) => c.nullable !== false);

  /** Set DEFAULT over a range: added rows drop the cell's value (the DB default applies); */
  /** otherwise the column's default is used, when introspected as a plain literal. */
  const defaultable = (n: { top: number; bottom: number; left: number; right: number }): boolean => {
    let usable = false;
    for (let r = n.top; r <= n.bottom; r++) {
      if (props.rowState?.(r) === "deleted") continue;
      usable = true;
      if (props.rowState?.(r) === "inserted") {
        if (!props.onResetCell) return false;
        continue;
      }
      for (let c = n.left; c <= n.right; c++) {
        const d = columns[c]!.default;
        if (d == null || defaultLiteralOf(d) === null) return false;
      }
    }
    return usable;
  };
  const setNulls = (n: { top: number; bottom: number; left: number; right: number }) => {
    if (!onEdit || !nullOk(n)) return;
    for (let r = n.top; r <= n.bottom; r++)
      for (let c = n.left; c <= n.right; c++) if (props.rowState?.(r) !== "deleted") onEdit(r, c, null);
  };
  const setDefaults = (n: { top: number; bottom: number; left: number; right: number }) => {
    if (!onEdit || !defaultable(n)) return;
    for (let r = n.top; r <= n.bottom; r++) {
      if (props.rowState?.(r) === "deleted") continue;
      for (let c = n.left; c <= n.right; c++) {
        if (props.rowState?.(r) === "inserted") {
          // An added row's untouched cells are omitted from the INSERT: the DB default applies.
          props.onResetCell?.(r, c);
          continue;
        }
        const d = columns[c]!.default;
        const literal = d != null ? defaultLiteralOf(d) : null;
        if (literal !== null) {
          const lit = booleanLiterals(props.driver);
          const text =
            bools[c] && /^(true|false|t|f|1|0)$/i.test(literal)
              ? /^(true|t|1)$/i.test(literal)
                ? lit.t
                : lit.f
              : literal;
          onEdit(r, c, text);
        }
      }
    }
  };
  const jsonWindowChanged = editing?.dialog && editing.json && editing.text !== (value(editing.row, editing.col) ?? "");

  const cellActions = useRef<CellActions>(null!);
  useLayoutEffect(() => {
    const canEdit = () =>
      !!editable && !!onEdit && !!sel && !editing && selectedRows().some((r) => props.rowState?.(r) !== "deleted");
    const actions: CellActions = {
      canToggle: () => canEdit() && !!bools[sel!.c1] && props.rowState?.(sel!.r1) !== "deleted",
      canSetNull: () => canEdit() && nullOk(norm(sel!)),
      canSetDefault: () => canEdit() && defaultable(norm(sel!)),
      toggle: () => {
        if (actions.canToggle()) toggleBoolean(sel!.r1, sel!.c1, booleanLiterals(props.driver));
      },
      setNull: () => {
        if (actions.canSetNull()) setNulls(norm(sel!));
      },
      setDefault: () => {
        if (actions.canSetDefault()) setDefaults(norm(sel!));
      },
    };
    Object.assign((cellActions.current ??= {} as CellActions), actions);
  });
  useEffect(() => registerCellGrid(scrollRef.current!, cellActions.current), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copy(copyFormat, false);
      return;
    }
    if (mod && e.key.toLowerCase() === "f" && props.onFind) {
      e.preventDefault();
      props.onFind();
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
      startEdit(sel.r1, sel.c1, e.key === "Enter" && e.shiftKey);
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
    scrollColumnIntoView(c);
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
      { label: "Copy", shortcut: "⌘C", run: () => copy(copyFormat, false) },
      {
        label: "Copy as",
        submenu: [
          { label: "TSV", verbatim: true, run: () => copy("tsv", false) },
          { label: "CSV", verbatim: true, run: () => copy("csv", false) },
          { label: "One-Row", run: () => copy("onerow", false) },
        ],
      },
      { label: "Copy with Header", run: () => copy("tsv", true) },
      { label: "Copy Rows as TSV", run: () => copy("tsv", true, true) },
      { label: "Copy Rows as CSV", run: () => copy("csv", true, true) },
    ];
    if (editable && onEdit) {
      const n = norm(sel);
      items.push(
        { kind: "separator" },
        { label: "Edit Cell", disabled: n.top !== n.bottom || n.left !== n.right, run: () => startEdit(n.top, n.left) },
        { kind: "action", action: "db.setCellNull", arg: cellActions.current },
        { kind: "action", action: "db.setCellDefault", arg: cellActions.current },
      );
    }
    const extra = rowMenu?.(selectedRows()) ?? [];
    if (extra.length) items.push({ kind: "separator" }, ...extra);
    showContextMenu(e, items);
  };

  const startResize = (e: MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const releaseCursor = lockDragCursor("ew-resize");
    const startX = e.clientX;
    const start = widths[col] ?? 100;
    const move = (ev: globalThis.MouseEvent) => {
      if (!(ev.buttons & 1)) return up();
      setWidths((w) => w.map((x, i) => (i === col ? Math.max(40, start + ev.clientX - startX) : x)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      releaseCursor();
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
      data-db-cell-grid=""
      aria-label={props["aria-label"] ?? "Results"}
      aria-rowcount={rowCount}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onContextMenu={onContextMenu}
    >
      {editing?.dialog && editing.json && (
        <JsonValueWindow
          title={tx`Edit ${columns[editing.col]!.name}`}
          initial={jsonWindowChanged ? editing.text : initialJsonText(editing.text)}
          baseline={jsonWindowChanged ? (value(editing.row, editing.col) ?? "") : undefined}
          validate={isJsonColumn(columns[editing.col]!.type)}
          emptyIsNull={value(editing.row, editing.col) === null}
          onClose={() => {
            setEditing(null);
            scrollRef.current?.focus();
          }}
          onApply={(text) => commitJsonWindow(text)}
          onSetNull={() => commitJsonWindow(null)}
        />
      )}
      {editing?.dialog && !editing.json && (
        <Dialog
          open
          title={tx`Edit ${columns[editing.col]!.name}`}
          width={720}
          onClose={() => setEditing(null)}
          buttons={[
            { label: "Cancel", role: "cancel", onClick: () => setEditing(null) },
            { label: "Apply", role: "default", onClick: commit },
          ]}
        >
          <textarea
            className={styles.largeCellEditor}
            aria-label={`Edit ${columns[editing.col]!.name}`}
            value={editing.text}
            spellCheck={false}
            wrap="soft"
            onContextMenu={(e) => e.stopPropagation()}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
          />
        </Dialog>
      )}
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
                if (editing && !editing.dialog && editing.row === r && editing.col === c) {
                  const col = columns[c]!;
                  const lit = bools[c] ? booleanLiterals(props.driver) : null;
                  const values = enums[c];
                  const cell = value(editing.row, editing.col);
                  // A cell that is NULL in a NOT NULL column (a pending edit) is anomalous: plain editor.
                  if ((lit || values) && !(cell === null && col.nullable === false)) {
                    const options: Array<{ value: string; label: string }> = [];
                    const known = (v: string) => options.some((o) => o.value === v);
                    if (lit) options.push({ value: lit.t, label: tx("true") }, { value: lit.f, label: tx("false") });
                    else for (const v of values!) if (!known(v)) options.push({ value: v, label: v });
                    // A value the editor doesn't offer stays selectable instead of silently changing on commit.
                    if (cell !== null && !known(cell)) options.unshift({ value: cell, label: cell });
                    if (col.nullable !== false) options.push({ value: NULL_INPUT, label: "NULL" });
                    return (
                      <CellSelect
                        key={c}
                        label={tx`Edit ${col.name}`}
                        value={cell === null ? NULL_INPUT : cell}
                        options={options}
                        onChoose={pickSelect}
                        onClose={() => {
                          setEditing(null);
                          scrollRef.current?.focus();
                        }}
                      />
                    );
                  }
                  return (
                    <input
                      key={c}
                      className={styles.cellEditor}
                      data-cell-editor=""
                      autoFocus
                      aria-label={`Edit ${columns[c]!.name}`}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onBlur={() => {
                        if (!skipBlurCommit.current) commit();
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter" && e.shiftKey) {
                          // A line break can't be typed in a single-line field: continue in the multi-line editor.
                          e.preventDefault();
                          skipBlurCommit.current = true;
                          setEditing({ ...editing, dialog: true });
                          return;
                        }
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") {
                          skipBlurCommit.current = true;
                          setEditing(null);
                          scrollRef.current?.focus();
                        }
                      }}
                    />
                  );
                }
                const val = value(r, c);
                // Boolean cells show a checkbox while the grid is editable (DataGrip); Space toggles too.
                const lit =
                  editable && onEdit && bools[c] && state !== "deleted" ? booleanLiterals(props.driver) : null;
                return (
                  <div
                    key={c}
                    role="gridcell"
                    className={clsx(
                      styles.cell,
                      numeric[c] && styles.cellNumber,
                      props.isMatch?.(r, c) && styles.cellMatch,
                      currentMatch?.row === r && currentMatch.col === c && styles.cellMatchCurrent,
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
                    {lit ? (
                      <>
                        <span
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setSel({ r0: r, c0: c, r1: r, c1: c });
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            className={styles.cellCheckbox}
                            aria-label={tx`Toggle ${columns[c]!.name}`}
                            checked={val === lit.t}
                            indeterminate={val === null}
                            onChange={() => {
                              toggleBoolean(r, c, lit);
                              scrollRef.current?.focus();
                            }}
                          />
                        </span>
                        {val === null ? (
                          <span className={styles.null}>&lt;null&gt;</span>
                        ) : (
                          cellText(displayed(val, !!numeric[c]))
                        )}
                      </>
                    ) : val === null ? (
                      <span className={styles.null}>&lt;null&gt;</span>
                    ) : (
                      cellText(displayed(val, !!numeric[c]))
                    )}
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

function CellSelect({
  label,
  value,
  options,
  onChoose,
  onClose,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChoose(value: string): void;
  onClose(): void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor} role="gridcell" className={styles.cellEditor}>
      {options.find((o) => o.value === value)?.label}
      <Popup open anchor={anchor} onClose={onClose} matchWidth role="presentation">
        <SelectListbox
          value={value}
          options={options.map((o) => ({ ...o, verbatim: true }))}
          onChoose={onChoose}
          aria-label={label}
        />
      </Popup>
    </div>
  );
}
