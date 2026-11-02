/**
 * Database Console service view (IDEA's): an Output tab logging every
 * executed statement with its outcome, and a `Result N` tab per result set —
 * a toolbar (re-run, export / copy as CSV, JSON, SQL…), the grid and a floating row count.
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { DbPlanNode } from "@/platform/ipc";
import { EmptyState, Icon, IconButton, Spinner, Tabs, Tree, showContextMenu, T } from "@/ui";
import { ChartView } from "./ChartView";
import { DataView, ExtractorSelect, PanelToggle, exportMenu, type DataPanel } from "./DataView";
import type { ExportData, ExportFormat } from "./export";
import { analyze } from "./sql/analyze";
import {
  OUTPUT_TAB,
  clearOutput,
  closeResult,
  outcomeSummary,
  rerunResult,
  sourceById,
  targetLabel,
  useDatabase,
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

function Result({ tab }: { tab: ResultTab }) {
  const [view, setView] = useState<"table" | "chart">("table");
  const [panel, setPanel] = useState<DataPanel | null>(null);
  const [extractor, setExtractor] = useState<ExportFormat>("csv");
  const r = tab.outcome.result;
  const columns = useMemo(() => (r ? r.columns.map((c) => ({ name: c.name, type: c.typeName })) : []), [r]);
  const value = useCallback((row: number, col: number) => r?.rows[row]?.[col] ?? null, [r]);
  if (!r) return null;
  const driver = sourceById(tab.sourceId)?.driver ?? "sqlite";
  const data = (): ExportData => ({
    columns,
    rows: r.rows,
    driver,
    table: queryTable(tab.outcome.statement.text, { driver }),
  });
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="db-table" title="Table" aria-pressed={view === "table"} onClick={() => setView("table")} />
        <IconButton icon="db-chart" title="Chart" aria-pressed={view === "chart"} onClick={() => setView("chart")} />
        <span className={styles.toolbarSeparator} />
        <IconButton icon="refresh" title="Rerun Query" disabled={tab.busy} onClick={() => void rerunResult(tab.id)} />
        {tab.busy && <Spinner size={12} />}
        <span className={styles.spacer} />
        <span className={styles.resultSource} title={tab.outcome.statement.text}>
          {targetLabel(tab.sourceId)}
        </span>
        <ExtractorSelect value={extractor} onChange={setExtractor} />
        <IconButton
          icon="export"
          title="Export Data"
          onClick={(e) =>
            showContextMenu(e, exportMenu(data(), queryTable(tab.outcome.statement.text, { driver }), extractor))
          }
        />
        {view === "table" && <PanelToggle panel={panel} onChange={setPanel} />}
      </div>
      {view === "chart" ? (
        <div className={styles.fill}>
          <ChartView columns={columns} rows={r.rows} />
        </div>
      ) : (
        <div className={clsx(styles.fill, styles.gridHost)}>
          <DataView
            columns={columns}
            rowCount={r.rows.length}
            value={value}
            panel={panel}
            onPanelChange={setPanel}
            aria-label={tab.title}
          />
          <div className={styles.rowPill} role="status" title={outcomeSummary(tab.outcome)}>
            {r.rows.length === 1 ? tx`${r.rows.length} row` : tx`${r.rows.length} rows`}
            {r.hasMore ? ` ${tx("(limit reached)")}` : ""}
          </div>
        </div>
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
