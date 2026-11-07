/**
 * Database Console service view (IDEA's): an Output tab logging every
 * executed statement with its outcome, and a `Result N` tab per result set —
 * a toolbar (re-run, export / copy as CSV, JSON, SQL…), the grid and a floating row count.
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { call, commands, type DbPlanNode, type DbQueryResult } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { Button, EmptyState, Icon, IconButton, Select, Spinner, Tabs, Tree, showContextMenu, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { ChartView } from "./ChartView";
import { DataView, ExtractorSelect, PanelToggle, copyFormatOf, exportMenu, type DataPanel } from "./DataView";
import type { ExportData, ExportFormat } from "./export";
import { buildRowEdits, emptyEdits, hasEdits, splitTarget, type Cell, type PendingEdits } from "./model";
import {
  editStatements,
  pkResultColumns,
  resultColumnSources,
  resultEditability,
  resolveTarget,
  type EditBlockReason,
} from "./resultEditing";
import { pageWindow } from "./resultView";
import { analyze } from "./sql/analyze";
import { nameMatcher } from "./sql/dialect";
import {
  OUTPUT_TAB,
  clearOutput,
  closeResult,
  countResult,
  countable,
  detailsKey,
  loadDetails,
  loadResultPage,
  log,
  outcomeSummary,
  pageable,
  rerunResult,
  targetLabel,
  useDatabase,
  withConnection,
  type OutputLine,
  type ResultTab,
} from "./store";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

function time(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Output() {
  const lines = useDatabase((s) => s.output);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.spacer} />
        <IconButton icon="trash" title="Clear All" disabled={!lines.length} onClick={clearOutput} />
      </div>
      <div
        ref={ref}
        className={styles.output}
        tabIndex={0}
        onKeyDown={copySelectionOnKeyDown}
        role="log"
        aria-label={tx("Database output")}
      >
        {lines.map((l: OutputLine) => (
          <div key={l.id} className={clsx(styles.outputLine, l.kind === "error" && styles.outputError)}>
            <span className={styles.outputTime}>[{time(l.time)}]</span>{" "}
            {l.prompt && <span className={styles.outputPrompt}>{l.prompt} </span>}
            <span className={l.kind === "statement" ? styles.outputStatement : undefined}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The table a query reads (target of exported SQL inserts), else IDEA's placeholder. */
function queryTable(text: string, data: Pick<ExportData, "driver">): string {
  const a = analyze(text, text.length, data.driver);
  return a.refs.find((r) => r.depth === 0 && r.kind === "table")?.name ?? "MY_TABLE";
}

const PAGE_SIZES = [10, 100, 500, 1000];

/** Why a result's grid is read-only, as the issue's examples put it. */
function readonlyNotice(reason: EditBlockReason): string {
  switch (reason) {
    case "joined":
      return tx("Read-only: the query joins several tables.");
    case "aggregated":
      return tx("Read-only: the result is aggregated (DISTINCT, GROUP BY or an aggregate function).");
    case "setOp":
      return tx("Read-only: the result combines several queries (UNION / INTERSECT / EXCEPT).");
    case "plain":
      return tx("Read-only: the result is not a plain select from a single table.");
  }
}

/** IDEA's pager at the bottom of a result: |< < 1-500 of 501+ > >| and the page size; paging runs the query again. */
function Pager({ tab }: { tab: ResultTab }) {
  const r = tab.outcome.result!;
  const page = tab.page ?? 0;
  const pageSize = tab.pageSize ?? Math.max(r.rows.length, 1);
  const state = { page, pageSize, rows: r.rows.length, hasMore: r.hasMore, total: tab.total ?? null };
  const w = pageWindow(state);
  const canPage = pageable(tab) && !tab.busy;
  const go = (p: number, size = pageSize) => void loadResultPage(tab.id, p, size);
  const goLast = async () => {
    let lastPage = w.lastPage;
    if (lastPage === null) {
      const total = await countResult(tab.id);
      if (total === null) return;
      lastPage = pageWindow({ ...state, total }).lastPage;
    }
    if (lastPage !== null && lastPage !== page) go(lastPage);
  };
  const { first, last } = w;
  const total = w.total === null ? `${w.last + 1}+` : String(w.total);
  const sizes = PAGE_SIZES.includes(pageSize) ? PAGE_SIZES : [...PAGE_SIZES, pageSize].sort((a, b) => a - b);
  return (
    <div
      className={styles.resultPager}
      role="toolbar"
      aria-label={tx("Result pages")}
      title={outcomeSummary(tab.outcome)}
    >
      <IconButton
        icon="page-first"
        title="First Page"
        size="small"
        disabled={!canPage || page === 0}
        onClick={() => go(0)}
      />
      <IconButton
        icon="chevron-left"
        title="Previous Page"
        size="small"
        disabled={!canPage || page === 0}
        onClick={() => go(page - 1)}
      />
      <button
        type="button"
        className={clsx(styles.resultPagerRange, styles.resultPagerCount)}
        disabled={w.total !== null || !canPage || !countable(tab)}
        title={w.total === null ? tx("Count rows") : undefined}
        onClick={() => void countResult(tab.id)}
      >
        {tx`${first}-${last} of ${total}`}
      </button>
      <IconButton
        icon="chevron-right"
        title="Next Page"
        size="small"
        disabled={!canPage || !r.hasMore}
        onClick={() => go(page + 1)}
      />
      <IconButton
        icon="page-last"
        title="Last Page"
        size="small"
        disabled={!canPage || (!r.hasMore && w.total !== null) || (w.total === null && !countable(tab))}
        onClick={() => void goLast()}
      />
      <Select
        aria-label="Page size"
        value={String(pageSize)}
        options={sizes.map((v) => ({ value: String(v), label: String(v) }))}
        onChange={(v) => go(0, Number(v))}
        disabled={!canPage}
      />
    </div>
  );
}

function Result({ tab }: { tab: ResultTab }) {
  const [view, setView] = useState<"table" | "chart">("table");
  const [panel, setPanel] = useState<DataPanel | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [extractor, setExtractor] = useState<ExportFormat>("csv");
  const r = tab.outcome.result;
  const columns = useMemo(() => (r ? r.columns.map((c) => ({ name: c.name, type: c.typeName })) : []), [r]);
  const source = useDatabase((s) => s.sources.find((source) => source.id === splitTarget(tab.sourceId).id));
  const driver = source?.driver ?? "sqlite";

  // Editing a result in place (like DataGrip): only a plain select of one base
  // table, carrying the table's primary key, on a writable data source.
  const text = tab.outcome.statement.text;
  const editability = useMemo(() => resultEditability(text, driver), [text, driver]);
  const model = useDatabase((s) => s.completion[tab.sourceId]) ?? null;
  const target = useMemo(
    () => (editability.kind === "editable" ? resolveTarget(editability, model, tab.schema, driver) : null),
    [editability, model, tab.schema, driver],
  );
  const detailsId = target ? detailsKey(tab.sourceId, target.schema ?? "", target.table) : null;
  const details = useDatabase((s) => (detailsId ? s.details[detailsId] : undefined));
  const detailsValue = details?.status === "ok" ? details.value : null;
  useEffect(() => {
    // Only when never loaded: a failed fetch must not retry on every state change.
    if (target && !details) void loadDetails(tab.sourceId, target.schema ?? "", target.table);
  }, [target, details, tab.sourceId]);
  const resultNames = useMemo(() => r?.columns.map((c) => c.name) ?? [], [r]);
  const eq = useMemo(
    () =>
      driver === "postgres" || driver === "oracle" || driver === "sqlServer"
        ? (a: string | null | undefined, b: string | null | undefined) => !!a && a === b
        : nameMatcher(driver),
    [driver],
  );
  const sources = useMemo(
    () =>
      editability.kind === "editable"
        ? resultColumnSources(editability.items, resultNames, detailsValue?.columns.map((c) => c.name) ?? null, eq)
        : [],
    [editability, resultNames, detailsValue, eq],
  );
  const pk = useMemo(() => {
    if (!detailsValue) return null;
    return pkResultColumns(
      detailsValue.columns.filter((c) => c.primaryKey).map((c) => c.name),
      sources,
      resultNames,
      eq,
    );
  }, [detailsValue, sources, resultNames, eq]);
  const readOnlySource = source?.readOnly ?? false;
  const editable =
    editability.kind === "editable" &&
    !!target &&
    !!pk &&
    !readOnlySource &&
    driver !== "clickhouse" &&
    sources.some((s) => s !== null);

  // The pending edits belong to the result they were made on: fresh rows (a
  // re-run, another page) start over, without an effect.
  const [pending, setPending] = useState<{ outcome: DbQueryResult | null; edits: PendingEdits }>({
    outcome: null,
    edits: emptyEdits(),
  });
  const edits = pending.outcome === r ? pending.edits : emptyEdits();
  const setEdits = (f: (e: PendingEdits) => PendingEdits) => setPending({ outcome: r, edits: f(edits) });
  const loaded = r?.rows.length ?? 0;
  const rowCount = loaded + edits.inserts.length;
  const value = useCallback(
    (row: number, col: number): Cell => {
      const name = resultNames[col]!;
      if (row >= loaded) return edits.inserts[row - loaded]?.get(name) ?? null;
      const upd = edits.updates.get(row);
      if (upd?.has(name)) return upd.get(name)!;
      return r?.rows[row]?.[col] ?? null;
    },
    [r, resultNames, loaded, edits],
  );

  const onEdit = (row: number, col: number, v: Cell) => {
    if (!editable || busy || !sources[col]) return; // an aliased or computed column
    const name = resultNames[col]!;
    setEdits((e) => {
      const next: PendingEdits = { updates: new Map(e.updates), deletes: new Set(e.deletes), inserts: [...e.inserts] };
      if (row >= loaded) {
        const ins = new Map(next.inserts[row - loaded]);
        ins.set(name, v);
        next.inserts[row - loaded] = ins;
      } else {
        const upd = new Map(next.updates.get(row));
        if ((r?.rows[row]?.[col] ?? null) === v) upd.delete(name);
        else upd.set(name, v);
        if (upd.size) next.updates.set(row, upd);
        else next.updates.delete(row);
      }
      return next;
    });
  };

  const deleteRows = (rows: number[]) =>
    setEdits((e) => {
      const deletes = new Set(e.deletes);
      const insertsGone = new Set(rows.filter((row) => row >= loaded).map((row) => row - loaded));
      for (const row of rows) if (row < loaded) deletes.add(row);
      return { ...e, deletes, inserts: e.inserts.filter((_, i) => !insertsGone.has(i)) };
    });

  const dirty = hasEdits(edits);
  const [submitting, setSubmitting] = useState(false);
  const submitGuard = useRef(false);
  const busy = submitting || !!tab.busy;

  const submit = async () => {
    if (!r || !target || !pk || !editable || busy || submitGuard.current) return;
    submitGuard.current = true;
    setSubmitting(true);
    const list = buildRowEdits(resultNames, r.rows, pk, edits);
    try {
      // The Output log shows what the submit is about to change.
      for (const s of editStatements(driver, target.schema ?? "", target.table, list)) log("statement", s);
      const n = await withConnection(tab.sourceId, () =>
        call(commands.dbApplyEdits(tab.sourceId, target.schema ?? "", target.table, list)),
      );
      log("result", `${target.table}: ${n} row(s) changed`);
      notifications().notify({ level: "info", title: `${target.table}: ${n} row(s) changed`, key: "db-submit" });
      setEdits(() => emptyEdits());
      await rerunResult(tab.id);
    } catch (e) {
      log("error", e instanceof Error ? e.message : String(e));
      notifications().notify({
        level: "error",
        title: "Changes were not submitted",
        body: e instanceof Error ? e.message : String(e),
        key: "db-submit",
      });
    } finally {
      submitGuard.current = false;
      setSubmitting(false);
    }
  };

  if (!r) return null;
  const data = (): ExportData => ({
    columns,
    rows: r.rows,
    driver,
    table: queryTable(text, { driver }),
  });
  const tableLabel = target ? `${target.schema ? `${target.schema}.` : ""}${target.table}` : "";
  const tablePkCount = detailsValue?.columns.filter((c) => c.primaryKey).length ?? 0;
  let notice: string | null = null;
  if (!editable) {
    if (driver === "clickhouse") notice = tx("Use the query console to change ClickHouse data.");
    else if (readOnlySource) notice = tx("Read-only data source.");
    else if (editability.kind === "readonly") notice = readonlyNotice(editability.reason);
    else if (!target) notice = tx("Read-only: the table schema could not be identified in the result database.");
    else if (details?.status === "error" || (detailsValue && tablePkCount > 0))
      // The result exists but doesn't carry every key column (or the keys are unknown).
      notice = tx`Read-only: the result has no primary key of ${tableLabel}.`;
    else if (detailsValue) notice = tx("Read-only: the table has no primary key to identify rows.");
    // else: the table's details are still loading.
  }
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="db-table" title="Table" aria-pressed={view === "table"} onClick={() => setView("table")} />
        <IconButton icon="db-chart" title="Chart" aria-pressed={view === "chart"} onClick={() => setView("chart")} />
        <span className={styles.toolbarSeparator} />
        <IconButton icon="refresh" title="Rerun Query" disabled={busy} onClick={() => void rerunResult(tab.id)} />
        {view === "table" && (
          <IconButton
            icon="search"
            title="Search"
            shortcut={shortcutLabel("find.inFile")}
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen(!searchOpen)}
          />
        )}
        {editable && (
          <>
            <IconButton
              icon="plus"
              title="Add Row"
              disabled={busy}
              onClick={() => setEdits((e) => ({ ...e, inserts: [...e.inserts, new Map()] }))}
            />
            <Button size="small" variant="primary" disabled={!dirty || busy} onClick={() => void submit()}>
              <T>Submit</T>
            </Button>
            <Button size="small" disabled={!dirty || busy} onClick={() => setEdits(() => emptyEdits())}>
              <T>Revert</T>
            </Button>
          </>
        )}
        {tab.busy && <Spinner size={12} />}
        <span className={styles.spacer} />
        <span className={styles.resultSource} title={tab.outcome.statement.text}>
          {targetLabel(tab.sourceId)}
        </span>
        <ExtractorSelect value={extractor} onChange={setExtractor} />
        <IconButton
          icon="export"
          title="Export Data"
          onClick={(e) => showContextMenu(e, exportMenu(data(), queryTable(text, { driver }), extractor))}
        />
        {view === "table" && <PanelToggle panel={panel} onChange={setPanel} />}
      </div>
      {view === "chart" ? (
        <div className={styles.fill}>
          <ChartView columns={columns} rows={r.rows} />
        </div>
      ) : (
        <>
          {notice && (
            <div className={styles.notice} role="note">
              {notice}
            </div>
          )}
          <div className={clsx(styles.fill, styles.gridHost)}>
            <DataView
              columns={columns.map((c) => ({ ...c, primaryKey: !!pk?.includes(c.name) }))}
              rowCount={rowCount}
              fixedRows={loaded}
              value={value}
              panel={panel}
              onPanelChange={setPanel}
              copyFormat={copyFormatOf(extractor)}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              firstRowNumber={(tab.page ?? 0) * (tab.pageSize ?? 0) + 1}
              aria-label={tab.title}
              rowState={(row) => (row >= loaded ? "inserted" : edits.deletes.has(row) ? "deleted" : null)}
              isModified={(row, col) => !!edits.updates.get(row)?.has(resultNames[col]!)}
              editable={editable && !busy}
              onEdit={onEdit}
              rowMenu={(rows) =>
                editable && !busy
                  ? [
                      { label: "Delete Rows", icon: "trash", run: () => deleteRows(rows) },
                      {
                        label: "Restore Rows",
                        run: () =>
                          setEdits((e) => ({
                            ...e,
                            deletes: new Set([...e.deletes].filter((d) => !rows.includes(d))),
                          })),
                      },
                    ]
                  : []
              }
            />
            <Pager tab={busy ? { ...tab, busy: true } : tab} />
          </div>
        </>
      )}
    </div>
  );
}

interface PlanRow {
  node: DbPlanNode;
  index: number;
  key: string;
}

/** IDEA's operation icons: a table for scans of one, a key for index lookups, an arrow for the statement. */
function planIcon(r: PlanRow): string | null {
  if (r.index < 0) return "arrow-left";
  if (/index/i.test(r.node.operation)) return "db-key";
  if (/scan/i.test(r.node.operation)) return "db-table";
  return null;
}

/** IDEA's Query Plan tab: the operation tree with its parameters, the selected operation's properties beside it. */
function PlanResult({ tab }: { tab: ResultTab }) {
  const plan = useMemo(() => tab.plan ?? [], [tab.plan]);
  const rows = useMemo(() => plan.map((node, index): PlanRow => ({ node, index, key: String(index) })), [plan]);
  // IDEA roots the operations in the statement itself ("Select").
  const statement = useMemo((): PlanRow => {
    const kind = /^\s*(\w+)/.exec(tab.outcome.statement.text)?.[1]?.toLowerCase() ?? "statement";
    const operation = kind[0]!.toUpperCase() + kind.slice(1);
    return {
      node: { parent: null, operation, params: "", properties: [{ name: "Operation", value: kind }] },
      index: -1,
      key: "statement",
    };
  }, [tab.outcome.statement.text]);
  const [selected, setSelected] = useState(-1);
  // Everything starts expanded, a re-explained plan too.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const keys = useMemo(() => [statement.key, ...rows.map((r) => r.key)], [statement, rows]);
  const expanded = useMemo(() => new Set(keys.filter((k) => !collapsed.has(k))), [keys, collapsed]);
  const setExpanded = (next: ReadonlySet<string>) => setCollapsed(new Set(keys.filter((k) => !next.has(k))));
  const children = (r: PlanRow) =>
    r === statement ? rows.filter((c) => c.node.parent === null) : rows.filter((c) => c.node.parent === r.index);
  const props = (selected < 0 ? statement : rows[selected])?.node.properties ?? [];
  const selectedKey = selected < 0 ? statement.key : String(selected);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="refresh" title="Explain Again" disabled={tab.busy} onClick={() => void rerunResult(tab.id)} />
        {tab.busy && <Spinner size={12} />}
        <span className={styles.spacer} />
        <span className={styles.resultSource} title={tab.outcome.statement.text}>
          {targetLabel(tab.sourceId)}
        </span>
      </div>
      <div className={clsx(styles.fill, styles.planView)}>
        <div className={styles.planTree}>
          <div className={styles.planHeader}>
            <span>
              <T>Operation</T>
            </span>
            <span>
              <T>Params</T>
            </span>
          </div>
          {plan.length ? (
            <Tree<PlanRow>
              aria-label="Query plan"
              roots={[statement]}
              selected={new Set([selectedKey])}
              expanded={expanded}
              onExpandedChange={setExpanded}
              getKey={(r) => r.key}
              getLabel={(r) => r.node.operation}
              getChildren={(r) => children(r)}
              isExpandable={(r) => children(r).length > 0}
              onSelectionChange={(_, lead) => lead && setSelected(lead.index)}
              renderNode={(r) => (
                <span className={styles.planRow}>
                  <span className={styles.planOperation}>
                    {planIcon(r) && <Icon name={planIcon(r)!} size={16} />}
                    {r.node.operation}
                  </span>
                  <span className={styles.planParams}>{r.node.params}</span>
                </span>
              )}
            />
          ) : (
            <EmptyState title="Empty plan" />
          )}
        </div>
        <table className={styles.planProperties} aria-label={tx("Plan node properties")}>
          <thead>
            <tr>
              <th>
                <T>Property</T>
              </th>
              <th>
                <T>Value</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ResultsView() {
  const results = useDatabase((s) => s.results);
  const active = useDatabase((s) => s.activeResult);
  const hasOutput = useDatabase((s) => s.output.length > 0);
  if (!results.length && !hasOutput)
    return (
      <EmptyState title="No results">
        <T>Execute a statement in a query console with ⌘↩.</T>
      </EmptyState>
    );
  const tab = results.find((r) => r.id === active);
  return (
    <div className={styles.view}>
      <Tabs
        variant="compact"
        aria-label="Results"
        activeId={tab ? String(tab.id) : String(OUTPUT_TAB)}
        onSelect={(id) => useDatabase.setState({ activeResult: Number(id) })}
        onClose={(id) => closeResult(Number(id))}
        items={[
          { id: String(OUTPUT_TAB), label: "Output", icon: "db-console", closable: false },
          ...results.map((r) => ({
            id: String(r.id),
            label: r.title,
            icon: r.plan ? "db-plan" : "db-table",
            closable: true,
            tooltip: r.outcome.statement.text,
          })),
        ]}
      />
      <div className={styles.fill}>
        {!tab ? <Output /> : tab.plan ? <PlanResult key={tab.id} tab={tab} /> : <Result key={tab.id} tab={tab} />}
      </div>
    </div>
  );
}
