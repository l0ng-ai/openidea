/**
 * Table data editor (editor tab): pages of rows with sorting (header click),
 * a WHERE filter, and pending cell edits / added / deleted rows submitted
 * together in one transaction. Tables without a primary key are read-only.
 */
import { canModifyTable } from "./objects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DbSortKey,
  type DbTablePage,
  type RequestId,
} from "@/platform/ipc";
import { EmptyState, Icon, IconButton, Select, Spinner, Toolbar, showContextMenu } from "@/ui";
import { notifications, type EditorInput } from "@/workbench/contributions";
import { SqlFilterInput } from "./SqlFilterInput";
import { ColumnsPopup } from "./ColumnsPopup";
import { DataView, ExtractorSelect, PanelToggle, copyFormatOf, exportMenu, type DataPanel } from "./DataView";
import type { ExportFormat } from "./export";
import {
  buildRowEdits,
  emptyEdits,
  formatOrderBy,
  hasEdits,
  parseOrderBy,
  type Cell,
  type PendingEdits,
} from "./model";
import { openDialog, sourceById, withConnection } from "./store";
import type { TableRef } from "./tableInput";
import styles from "./Database.module.css";
import { registerTableEditor, tableEditorChanged, type TableEditorHandle } from "./tableEditorFocus";
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { pageWindow } from "./resultView";

const PAGE_SIZES = ["100", "500", "1000", "5000"];

export { tableTitle } from "./tableInput";

/** WHERE, ORDER BY and page of a table tab, kept when a tab that is no longer kept alive mounts again. */
interface TableViewState {
  offset: number;
  limit: number;
  sort: DbSortKey[];
  filterText: string;
  filter: string;
  horizontalScrollLeft: number;
}

const MAX_VIEW_STATES = 100;
const viewStates = new Map<string, TableViewState>();

function rememberViewState(key: string, state: TableViewState) {
  viewStates.delete(key);
  viewStates.set(key, state);
  if (viewStates.size > MAX_VIEW_STATES) viewStates.delete(viewStates.keys().next().value!);
}

/** Test hook: forget the remembered table view states. */
export function _resetTableViewStates() {
  viewStates.clear();
}

export function TableEditor({ input }: { input: EditorInput }) {
  const ref = input.data as TableRef;
  const [initial] = useState(() => viewStates.get(input.key));
  const [offset, setOffset] = useState(initial?.offset ?? 0);
  const [limit, setLimit] = useState(initial?.limit ?? 500);
  const [sort, setSort] = useState<DbSortKey[]>(initial?.sort ?? []);
  const [filterText, setFilterText] = useState(initial?.filterText ?? "");
  const [filter, setFilter] = useState(initial?.filter ?? "");
  // A ref, not state: scrolling must not re-render the editor.
  const scrollLeft = useRef(initial?.horizontalScrollLeft ?? 0);
  useEffect(
    () =>
      rememberViewState(input.key, {
        offset,
        limit,
        sort,
        filterText,
        filter,
        horizontalScrollLeft: scrollLeft.current,
      }),
    [input.key, offset, limit, sort, filterText, filter],
  );
  const onHorizontalScroll = useCallback(
    (left: number) => {
      scrollLeft.current = left;
      const state = viewStates.get(input.key);
      if (state) state.horizontalScrollLeft = left;
    },
    [input.key],
  );
  const [nonce, setNonce] = useState(0);
  const [edits, setEdits] = useState<PendingEdits>(emptyEdits);
  const [panel, setPanel] = useState<DataPanel | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [extractor, setExtractor] = useState<ExportFormat>("csv");
  // The ORDER BY field while it's being edited; it shows the sort otherwise.
  const [orderDraft, setOrderDraft] = useState<string | null>(null);
  // The page for the current parameters (`key`); stale while loading.
  const [loadedPage, setLoadedPage] = useState<{ key: string; page: DbTablePage | null; error: string | null } | null>(
    null,
  );
  const key = JSON.stringify([ref.id, ref.schema, ref.table, filter, sort, offset, limit, nonce]);
  const loading = loadedPage?.key !== key;
  const page = loadedPage?.page ?? null;
  const error = loadedPage?.error ?? null;
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    const id: RequestId = nextRequestId();
    let done = false;
    void (async () => {
      try {
        const p = await withConnection(ref.id, () =>
          call(commands.dbTablePage(id, ref.id, ref.schema, ref.table, filter || null, sort, offset, limit)),
        );
        setLoadedPage({ key, page: p, error: null });
        setEdits(emptyEdits());
      } catch (e) {
        if (!isCancelled(e))
          setLoadedPage((prev) => ({
            key,
            page: prev?.page ?? null,
            error: e instanceof Error ? e.message : String(e),
          }));
      } finally {
        done = true;
      }
    })();
    return () => {
      if (!done) void commands.cancelRequest(id);
    };
  }, [key, ref.id, ref.schema, ref.table, filter, sort, offset, limit]);

  const columns = page?.result.columns ?? [];
  const names = columns.map((c) => c.name);
  const pk = page?.details.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
  const fkColumns = new Set(page?.details.foreignKeys.flatMap((k) => k.columns) ?? []);
  const source = sourceById(ref.id);
  const editable = pk.length > 0 && !source?.readOnly && canModifyTable(source?.driver ?? "sqlite");
  const loaded = page?.result.rows.length ?? 0;
  const rowCount = loaded + edits.inserts.length;
  const gridColumns = useMemo(
    () =>
      columns.map((c) => {
        const d = page?.details.columns.find((x) => x.name === c.name);
        return {
          name: c.name,
          type: d?.dataType ?? c.typeName,
          primaryKey: pk.includes(c.name),
          foreignKey: fkColumns.has(c.name),
          nullable: d?.nullable,
          default: d?.default ?? null,
        };
      }),
    // `pk` / `fkColumns` derive from `page`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page],
  );

  const value = useCallback(
    (row: number, col: number): Cell => {
      const name = names[col]!;
      if (row >= loaded) {
        const ins = edits.inserts[row - loaded];
        return ins?.has(name) ? ins.get(name)! : null;
      }
      const upd = edits.updates.get(row);
      if (upd?.has(name)) return upd.get(name)!;
      return page?.result.rows[row]?.[col] ?? null;
    },
    // `names` / `loaded` derive from `page`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, edits],
  );

  const onEdit = (row: number, col: number, v: Cell) => {
    const name = names[col]!;
    setEdits((e) => {
      const next: PendingEdits = { updates: new Map(e.updates), deletes: new Set(e.deletes), inserts: [...e.inserts] };
      if (row >= loaded) {
        const ins = new Map(next.inserts[row - loaded]);
        ins.set(name, v);
        next.inserts[row - loaded] = ins;
      } else {
        const upd = new Map(next.updates.get(row));
        if ((page?.result.rows[row]?.[col] ?? null) === v) upd.delete(name);
        else upd.set(name, v);
        if (upd.size) next.updates.set(row, upd);
        else next.updates.delete(row);
      }
      return next;
    });
  };

  const onResetCell = (row: number, col: number) => {
    setEdits((e) => {
      const inserts = [...e.inserts];
      const ins = new Map(inserts[row - loaded]);
      ins.delete(names[col]!);
      inserts[row - loaded] = ins;
      return { ...e, inserts };
    });
  };

  const deleteRows = (rows: number[]) =>
    setEdits((e) => {
      const deletes = new Set(e.deletes);
      const insertsGone = new Set(rows.filter((r) => r >= loaded).map((r) => r - loaded));
      for (const r of rows) if (r < loaded) deletes.add(r);
      return { ...e, deletes, inserts: e.inserts.filter((_, i) => !insertsGone.has(i)) };
    });

  const submit = async () => {
    if (!page || !editable) return;
    try {
      const n = await call(
        commands.dbApplyEdits(ref.id, ref.schema, ref.table, buildRowEdits(names, page.result.rows, pk, edits)),
      );
      notifications().notify({ level: "info", title: `${ref.table}: ${n} row(s) changed`, key: "db-submit" });
      reload();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Changes were not submitted",
        body: e instanceof Error ? e.message : String(e),
        key: "db-submit",
      });
    }
  };

  const onSort = (column: string, add: boolean) =>
    setSort((s) => {
      const cur = s.find((k) => k.column === column);
      // asc → desc → none.
      const next = !cur ? { column, descending: false } : !cur.descending ? { column, descending: true } : null;
      const rest = add ? s.filter((k) => k.column !== column) : [];
      return next ? [...rest, next] : rest;
    });

  const dirty = hasEdits(edits);
  // Submit / Revert actions (⌘↩ / ⌥⌘Z) reach the latest state through the handle.
  const viewRef = useRef<HTMLDivElement>(null);
  const handle = useRef<TableEditorHandle>({
    dirty: false,
    submit: () => {},
    revert: () => {},
    showColumns: () => {},
  }).current;
  handle.dirty = editable && dirty;
  handle.submit = () => {
    if (editable && dirty) void submit();
  };
  handle.revert = () => setEdits(emptyEdits());
  const [columnsAt, setColumnsAt] = useState<{ x: number; y: number } | null>(null);
  const [revealColumn, setRevealColumn] = useState<{ col: number } | null>(null);
  handle.showColumns = () => {
    const r = viewRef.current?.getBoundingClientRect();
    if (page && r) setColumnsAt({ x: r.left + r.width / 2, y: r.top + 48 });
  };
  const addRow = () => setEdits((e) => ({ ...e, inserts: [...e.inserts, new Map()] }));
  const restoreRows = (rows: number[]) =>
    setEdits((e) => ({ ...e, deletes: new Set([...e.deletes].filter((d) => !rows.includes(d))) }));
  const showExport = (at: { x: number; y: number }) =>
    page &&
    showContextMenu(
      at,
      exportMenu(
        {
          columns: gridColumns,
          rows: page.result.rows,
          table: ref.table,
          driver: sourceById(ref.id)?.driver ?? "sqlite",
        },
        `${ref.schema}.${ref.table}`,
        extractor,
      ),
    );
  const canPrevious = offset > 0 && !loading;
  const canNext = !!page?.result.hasMore && !loading;
  handle.commands = {
    reload: { enabled: () => !loading, run: reload },
    firstPage: { enabled: () => canPrevious, run: () => setOffset(0) },
    previousPage: { enabled: () => canPrevious, run: () => setOffset(Math.max(0, offset - limit)) },
    nextPage: { enabled: () => canNext, run: () => setOffset(offset + limit) },
    addRow: { enabled: () => editable, run: addRow },
    exportData: {
      enabled: () => !!page,
      run: () => {
        const r = viewRef.current?.querySelector("[data-db-export]")?.getBoundingClientRect();
        if (r) showExport({ x: r.left, y: r.bottom });
      },
    },
    deleteRows: { enabled: (rows) => editable && rows.length > 0, run: deleteRows },
    restoreRows: { enabled: (rows) => editable && rows.some((r) => edits.deletes.has(r)), run: restoreRows },
  };
  useEffect(() => registerTableEditor(viewRef.current!, handle), [handle]);
  useEffect(() => tableEditorChanged(handle), [handle, dirty, editable]);
  const orderInvalid = orderDraft !== null && !parseOrderBy(orderDraft, names);
  const hasMore = page?.result.hasMore ?? false;
  const { first, last, total } = pageWindow({
    page: offset / limit,
    pageSize: limit,
    rows: loaded,
    hasMore,
    total: null,
  });
  const singlePage = offset === 0 && !hasMore;
  return (
    <div className={styles.view} ref={viewRef} data-db-table-editor="">
      <Toolbar className={styles.toolbar} aria-label="Table actions">
        <IconButton
          icon="refresh"
          title="Reload Page"
          shortcut={shortcutLabel("db.reloadPage")}
          onClick={reload}
          disabled={loading}
        />
        <IconButton
          icon="search"
          title="Search"
          shortcut={shortcutLabel("find.inFile")}
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        />
        {editable && (
          <>
            <span className={styles.toolbarSeparator} />
            <IconButton icon="plus" title="Add Row" shortcut={shortcutLabel("db.addRow")} onClick={addRow} />
            <IconButton
              icon="revert"
              title="Revert"
              shortcut={shortcutLabel("db.revertChanges")}
              disabled={!dirty}
              onClick={() => setEdits(emptyEdits())}
            />
            <IconButton
              icon="arrow-up"
              title="Submit"
              shortcut={shortcutLabel("db.submitChanges")}
              disabled={!dirty}
              onClick={() => void submit()}
            />
          </>
        )}
        {loading && <Spinner size={12} />}
        <span className={styles.spacer} />
        <ExtractorSelect value={extractor} onChange={setExtractor} />
        <IconButton
          icon="export"
          title="Export Data"
          shortcut={shortcutLabel("db.exportData")}
          data-db-export=""
          disabled={!page}
          onClick={(e) => showExport({ x: e.clientX, y: e.clientY })}
        />
        <IconButton
          icon="import"
          title="Import Data from File…"
          disabled={!editable}
          onClick={() => openDialog({ kind: "import", id: ref.id, schema: ref.schema, table: ref.table })}
        />
        <PanelToggle panel={panel} onChange={setPanel} />
      </Toolbar>
      <div className={styles.filterBar}>
        <label className={styles.filterField}>
          <Icon name="filter" size={14} />
          <span aria-hidden="true">WHERE</span>
          <SqlFilterInput
            kind="where"
            schema={ref.schema}
            table={ref.table}
            columns={gridColumns}
            driver={sourceById(ref.id)?.driver ?? "sqlite"}
            value={filterText}
            onChange={setFilterText}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setOffset(0);
                setFilter(filterText.trim());
              }
            }}
          />
        </label>
        <label className={styles.filterField}>
          <Icon name="db-sort" size={14} />
          <span aria-hidden="true">ORDER BY</span>
          <SqlFilterInput
            kind="order"
            schema={ref.schema}
            table={ref.table}
            columns={gridColumns}
            driver={sourceById(ref.id)?.driver ?? "sqlite"}
            invalid={orderInvalid}
            value={orderDraft ?? formatOrderBy(sort)}
            onChange={setOrderDraft}
            onBlur={() => !orderInvalid && setOrderDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOrderDraft(null);
              if (e.key !== "Enter" || orderDraft === null) return;
              const next = parseOrderBy(orderDraft, names);
              if (!next) return;
              setOffset(0);
              setSort(next);
              setOrderDraft(null);
            }}
          />
        </label>
      </div>
      {page && !editable && (
        <div className={styles.notice}>
          {source?.driver === "jdbc"
            ? tx("Use the query console to change JDBC data.")
            : source?.driver === "clickhouse"
              ? tx("Use the query console to change ClickHouse data.")
              : pk.length
                ? tx("Read-only data source.")
                : tx("Read-only: the table has no primary key to identify rows.")}
        </div>
      )}
      {error ? (
        <pre className={styles.error}>{error}</pre>
      ) : !page ? (
        <EmptyState title="Loading…" />
      ) : (
        <div className={styles.fill}>
          <DataView
            aria-label={tx`${ref.table} data`}
            columns={gridColumns}
            rowCount={rowCount}
            fixedRows={loaded}
            revealColumn={revealColumn}
            value={value}
            panel={panel}
            onPanelChange={setPanel}
            copyFormat={copyFormatOf(extractor)}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
            firstRowNumber={offset + 1}
            rowState={(r) => (r >= loaded ? "inserted" : edits.deletes.has(r) ? "deleted" : null)}
            isModified={(r, c) => !!edits.updates.get(r)?.has(names[c]!)}
            editable={editable}
            onEdit={onEdit}
            onResetCell={onResetCell}
            driver={source?.driver}
            sort={sort}
            onSort={onSort}
            initialScrollLeft={scrollLeft.current}
            onHorizontalScroll={onHorizontalScroll}
            pager={
              <Toolbar className={styles.resultPager} aria-label="Table pages">
                {!singlePage && (
                  <>
                    <IconButton
                      size="small"
                      icon="chevron-left"
                      title="Previous Page"
                      shortcut={shortcutLabel("db.previousPage")}
                      disabled={!canPrevious}
                      onClick={() => setOffset(Math.max(0, offset - limit))}
                    />
                    <span className={styles.resultPagerRange}>
                      {loaded ? tx`${first}-${last} of ${total ?? `${last + 1}+`}` : tx`${loaded} rows`}
                    </span>
                    <IconButton
                      size="small"
                      icon="chevron-right"
                      title="Next Page"
                      shortcut={shortcutLabel("db.nextPage")}
                      disabled={!canNext}
                      onClick={() => setOffset(offset + limit)}
                    />
                  </>
                )}
                <Select
                  variant="ghost"
                  aria-label="Page size"
                  value={String(limit)}
                  options={PAGE_SIZES.map((v) => ({ value: v, label: v }))}
                  renderValue={singlePage ? () => tx`${loaded} rows` : undefined}
                  onChange={(v) => {
                    setOffset(0);
                    setLimit(Number(v));
                  }}
                />
              </Toolbar>
            }
            rowMenu={(rows) =>
              editable
                ? [
                    { kind: "action", action: "db.deleteRows", icon: "trash", arg: { rows, editor: handle } },
                    { kind: "action", action: "db.restoreRows", arg: { rows, editor: handle } },
                  ]
                : []
            }
          />
        </div>
      )}
      {columnsAt && (
        <ColumnsPopup
          anchor={columnsAt}
          table={ref.table}
          columns={gridColumns}
          onPick={(col) => {
            setColumnsAt(null);
            setRevealColumn({ col });
          }}
          onClose={() => setColumnsAt(null)}
        />
      )}
    </div>
  );
}
