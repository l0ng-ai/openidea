/**
 * A data grid with IDEA's result-view extras, shared by console results and
 * the table editor: the header's local filter (values of the loaded rows),
 * client-side sorting when the caller does not sort on the server, and the
 * Record / Value / Aggregates side panel following the selection.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Button, Checkbox, Icon, IconButton, Input, Popup, Select, Tabs, T, type MenuItem } from "@/ui";
import { EXPORT_FORMATS, exportData, type ExportData, type ExportFormat } from "./export";
import { Grid, type GridColumn, type GridProps, type GridRange } from "./Grid";
import type { Cell } from "./model";
import {
  aggregates,
  distinctValues,
  formatNumber,
  toggleFilterValue,
  visibleRows,
  type LocalFilter,
  type LocalSort,
} from "./resultView";
import { openDialog } from "./store";
import styles from "./Database.module.css";

export type DataPanel = "record" | "value" | "aggregates";

/** The Export button's menu: the Export Data dialog (with the toolbar's extractor), then IDEA's quick Copy as… extractors. */
export function exportMenu(data: ExportData, source: string, format?: ExportFormat): MenuItem[] {
  return [
    { label: "Export Data…", icon: "export", run: () => openDialog({ kind: "export", data, source, format }) },
    { kind: "separator" },
    ...EXPORT_FORMATS.map((f): MenuItem => ({
      label: `Copy as ${f.label}`,
      icon: "copy",
      run: () => void navigator.clipboard?.writeText(exportData(f.id, data)),
    })),
  ];
}

/** IDEA's extractor drop-down at the right of a data toolbar ("CSV ▾"). */
export function ExtractorSelect({ value, onChange }: { value: ExportFormat; onChange: (f: ExportFormat) => void }) {
  return (
    <Select
      aria-label="Data extractor"
      value={value}
      options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
      onChange={(v) => onChange(v as ExportFormat)}
    />
  );
}

/** The Record / Value / Aggregates panel's toggle (IDEA's "Show Value Editor"). */
export function PanelToggle({ panel, onChange }: { panel: DataPanel | null; onChange: (p: DataPanel | null) => void }) {
  return (
    <IconButton
      icon="split"
      title={panel ? "Hide Record / Value / Aggregates" : "Show Record / Value / Aggregates"}
      aria-pressed={!!panel}
      onClick={() => onChange(panel ? null : "record")}
    />
  );
}

/** Local filter and sort of the column set `key`. */
interface Shaping {
  key: string;
  filter: LocalFilter;
  sort: LocalSort | null;
}

export interface DataViewProps extends Pick<
  GridProps,
  "rowState" | "isModified" | "editable" | "onEdit" | "sort" | "onSort" | "rowMenu"
> {
  columns: readonly GridColumn[];
  rowCount: number;
  value: (row: number, col: number) => Cell;
  /** Rows from here on (the table editor's added rows) are never filtered or sorted. */
  fixedRows?: number;
  firstRowNumber?: number;
  /** The side panel shown (`null`: hidden). */
  panel: DataPanel | null;
  onPanelChange: (panel: DataPanel | null) => void;
  "aria-label"?: string;
}

export function DataView(props: DataViewProps) {
  const { columns, rowCount, value, fixedRows = rowCount, panel, onPanelChange } = props;
  const columnKey = columns.map((c) => c.name).join("\u0000");
  // Filter and sort belong to a column set: another one (a re-run query) starts without them.
  const [shaping, setShaping] = useState<Shaping>({ key: columnKey, filter: new Map(), sort: null });
  const current: Shaping = shaping.key === columnKey ? shaping : { key: columnKey, filter: new Map(), sort: null };
  const { filter, sort: localSort } = current;
  const setFilter = (f: LocalFilter | ((prev: LocalFilter) => LocalFilter)) =>
    setShaping({ ...current, filter: typeof f === "function" ? f(current.filter) : f });
  const setLocalSort = (s: (prev: LocalSort | null) => LocalSort | null) =>
    setShaping({ ...current, sort: s(current.sort) });
  const [range, setRange] = useState<GridRange | null>(null);
  const [filterAt, setFilterAt] = useState<{ col: number; anchor: HTMLElement } | null>(null);

  const local = !props.onSort;
  // Display row → loaded row; `null` keeps the identity (no filter, no local sort).
  const order = useMemo(
    () =>
      filter.size || (local && localSort)
        ? visibleRows(rowCount, value, filter, local ? localSort : null, fixedRows)
        : null,
    [rowCount, value, filter, local, localSort, fixedRows],
  );
  const at = (r: number) => (order ? order[r]! : r);
  const shown = order ? order.length : rowCount;

  const onSort = local
    ? (column: string) => {
        const col = columns.findIndex((c) => c.name === column);
        // asc → desc → none, like the table editor's.
        setLocalSort((s) =>
          s?.column !== col ? { column: col, descending: false } : !s.descending ? { ...s, descending: true } : null,
        );
      }
    : props.onSort;
  const sort = local
    ? localSort
      ? [{ column: columns[localSort.column]?.name ?? "", descending: localSort.descending }]
      : []
    : props.sort;

  return (
    <div className={styles.dataView}>
      <div className={clsx(styles.fill, styles.gridHost)}>
        <Grid
          aria-label={props["aria-label"]}
          columns={columns}
          rowCount={shown}
          value={(r, c) => value(at(r), c)}
          rowState={props.rowState && ((r) => props.rowState!(at(r)))}
          isModified={props.isModified && ((r, c) => props.isModified!(at(r), c))}
          editable={props.editable}
          onEdit={props.onEdit && ((r, c, v) => props.onEdit!(at(r), c, v))}
          sort={sort}
          onSort={onSort}
          rowMenu={props.rowMenu && ((rows) => props.rowMenu!(rows.map(at)))}
          rowNumber={(r) => (props.firstRowNumber ?? 1) + at(r)}
          onSelectionChange={setRange}
          onFilter={(col, anchor) => setFilterAt({ col, anchor })}
          filtered={(col) => filter.has(col)}
        />
        {filter.size > 0 && (
          <div className={styles.filterPill} role="status">
            {shown} of {rowCount} rows
            <button type="button" className={styles.filterPillClear} onClick={() => setFilter(new Map())}>
              <T>Clear local filter</T>
            </button>
          </div>
        )}
      </div>
      {filterAt && (
        <FilterPopup
          anchor={filterAt.anchor}
          column={columns[filterAt.col]?.name ?? ""}
          values={distinctValues(Math.min(rowCount, fixedRows), value, filterAt.col)}
          checked={filter.get(filterAt.col) ?? null}
          onToggle={(all, v, on) => setFilter((f) => toggleFilterValue(f, filterAt.col, all, v, on))}
          onClear={() =>
            setFilter((f) => {
              const next = new Map(f);
              next.delete(filterAt.col);
              return next;
            })
          }
          onClearAll={() => setFilter(new Map())}
          onClose={() => setFilterAt(null)}
        />
      )}
      {panel && (
        <SidePanel
          panel={panel}
          onPanelChange={onPanelChange}
          columns={columns}
          range={range}
          value={(r, c) => value(at(r), c)}
          editable={!!props.editable && !!props.onEdit && !!range && props.rowState?.(at(range.lead.row)) !== "deleted"}
          onEdit={(r, c, v) => props.onEdit?.(at(r), c, v)}
        />
      )}
    </div>
  );
}

function FilterPopup(props: {
  anchor: HTMLElement;
  column: string;
  values: Array<{ value: Cell; count: number }>;
  checked: ReadonlySet<Cell> | null;
  onToggle: (all: Cell[], v: Cell, on: boolean) => void;
  onClear: () => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const all = props.values.map((v) => v.value);
  const q = query.trim().toLowerCase();
  const list = q ? props.values.filter((v) => (v.value ?? "<null>").toLowerCase().includes(q)) : props.values;
  return (
    <Popup
      open
      anchor={props.anchor}
      placement="bottom-start"
      onClose={props.onClose}
      aria-label={`Local filter of ${props.column}`}
      className={styles.filterPopup}
      trapFocus
    >
      <Input
        autoFocus
        aria-label="Search values"
        placeholder={`Values of ${props.column}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={styles.filterValues} role="group" aria-label="Values">
        {list.map(({ value: v, count }) => (
          <div key={v ?? "\u0000null"} className={styles.filterValue}>
            <Checkbox
              checked={props.checked ? props.checked.has(v) : true}
              onChange={(on) => props.onToggle(all, v, on)}
              label={v === null ? <span className={styles.null}>&lt;null&gt;</span> : v}
            />
            <span className={styles.filterCount}>{count}</span>
          </div>
        ))}
        {!list.length && (
          <div className={styles.filterEmpty}>
            <T>No matching values</T>
          </div>
        )}
      </div>
      <div className={styles.filterButtons}>
        <Button size="small" disabled={!props.checked} onClick={props.onClear}>
          <T>Clear Filter</T>
        </Button>
        <Button size="small" onClick={props.onClearAll}>
          <T>Clear Local Filter For All Columns</T>
        </Button>
      </div>
    </Popup>
  );
}

const AGGREGATE_ROWS: ReadonlyArray<[label: string, key: keyof ReturnType<typeof aggregates>]> = [
  ["Count", "count"],
  ["Distinct", "distinct"],
  ["Nulls", "nulls"],
  ["Sum", "sum"],
  ["Avg", "avg"],
  ["Median", "median"],
  ["Min", "min"],
  ["Max", "max"],
];

function SidePanel(props: {
  panel: DataPanel;
  onPanelChange: (p: DataPanel | null) => void;
  columns: readonly GridColumn[];
  range: GridRange | null;
  value: (row: number, col: number) => Cell;
  editable: boolean;
  onEdit: (row: number, col: number, v: Cell) => void;
}) {
  const { range, value, columns } = props;
  return (
    <aside className={styles.sidePanel} aria-label="Value panel">
      <div className={styles.sidePanelHead}>
        <Tabs
          variant="compact"
          aria-label="Value panel"
          activeId={props.panel}
          onSelect={(id) => props.onPanelChange(id as DataPanel)}
          items={[
            { id: "record", label: "Record" },
            { id: "value", label: "Value" },
            { id: "aggregates", label: "Aggregates" },
          ]}
        />
        <span className={styles.spacer} />
        <IconButton icon="close" title="Hide" size="small" onClick={() => props.onPanelChange(null)} />
      </div>
      <div className={styles.sidePanelBody}>
        {!range ? (
          <div className={styles.filterEmpty}>
            <T>Select a cell</T>
          </div>
        ) : props.panel === "record" ? (
          <RecordView key={range.lead.row} {...props} row={range.lead.row} />
        ) : props.panel === "value" ? (
          <ValueView
            key={`${range.lead.row}:${range.lead.col}`}
            column={columns[range.lead.col]?.name ?? ""}
            cell={value(range.lead.row, range.lead.col)}
            editable={props.editable}
            onCommit={(v) => props.onEdit(range.lead.row, range.lead.col, v)}
          />
        ) : (
          <AggregatesView range={range} value={value} />
        )}
      </div>
    </aside>
  );
}

/** One field per column of the lead row; edits apply on Enter / leaving the field. */
function RecordView(props: {
  columns: readonly GridColumn[];
  row: number;
  value: (row: number, col: number) => Cell;
  editable: boolean;
  onEdit: (row: number, col: number, v: Cell) => void;
}) {
  return (
    <div className={styles.recordFields}>
      {props.columns.map((c, i) => (
        <RecordField
          // A new value (another row, an edit elsewhere) starts the field over.
          key={`${c.name}\u0000${props.value(props.row, i) ?? "\u0001"}`}
          column={c}
          cell={props.value(props.row, i)}
          editable={props.editable}
          onCommit={(v) => props.onEdit(props.row, i, v)}
        />
      ))}
    </div>
  );
}

function RecordField(props: { column: GridColumn; cell: Cell; editable: boolean; onCommit: (v: Cell) => void }) {
  const [text, setText] = useState(props.cell ?? "");
  const commit = () => {
    if (text !== (props.cell ?? "") || (props.cell === null && text !== "")) props.onCommit(text);
  };
  const c = props.column;
  return (
    <label className={styles.recordField}>
      <span className={styles.recordLabel}>
        <Icon name={c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column"} size={16} />
        {c.name}
        {c.type && c.type !== "NULL" && <span className={styles.treeType}>{c.type}</span>}
      </span>
      <Input
        mono
        value={text}
        readOnly={!props.editable}
        placeholder={props.cell === null ? "<null>" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}

function ValueView(props: { column: string; cell: Cell; editable: boolean; onCommit: (v: Cell) => void }) {
  const [text, setText] = useState(props.cell ?? "");
  const dirty = text !== (props.cell ?? "") || (props.cell === null && text !== "");
  return (
    <div className={styles.valueView}>
      <textarea
        className={styles.valueText}
        aria-label={`Value of ${props.column}`}
        value={text}
        readOnly={!props.editable}
        placeholder={props.cell === null ? "<null>" : undefined}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) props.onCommit(text);
        }}
      />
      {props.editable && (
        <div className={styles.filterButtons}>
          <Button size="small" disabled={!dirty} onClick={() => props.onCommit(text)}>
            <T>Apply</T>
          </Button>
          <Button size="small" onClick={() => props.onCommit(null)}>
            <T>Set NULL</T>
          </Button>
        </div>
      )}
    </div>
  );
}

function AggregatesView({ range, value }: { range: GridRange; value: (row: number, col: number) => Cell }) {
  const cells: Cell[] = [];
  for (let r = range.top; r <= range.bottom; r++)
    for (let c = range.left; c <= range.right; c++) cells.push(value(r, c));
  const a = aggregates(cells);
  const show = (v: number | string | null) => (v === null ? "—" : typeof v === "number" ? formatNumber(v) : v);
  return (
    <table className={styles.aggregates}>
      <tbody>
        {AGGREGATE_ROWS.map(([label, key]) => (
          <tr key={key}>
            <th scope="row">{label}</th>
            <td>{show(a[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
