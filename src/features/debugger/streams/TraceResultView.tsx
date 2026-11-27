/** A ready trace: every step side by side (Flat), or two adjacent steps at a time (Split). */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import type { DebugSessionId, JvmValue, StreamTraceResult } from "@/platform/ipc";
import { Tabs } from "@/ui";
import { formatCount } from "../memory/rows";
import { formatJvmValue } from "../memory/values";
import { buildColumns, buildEdges, relatedTo, type Edge } from "./layout";
import { CELL_LIMIT, ColumnHead, TraceColumns, type TraceSelection } from "./TraceColumns";
import { TraceValuePane, useTraceFields } from "./TraceValuePane";
import styles from "./StreamTraceEditor.module.css";

type Ready = Extract<StreamTraceResult, { status: "ready" }>;
type View = "flat" | "split";

/** Selection of the Result cell; records are selected by their index. */
const RESULT = -1;
const NONE: ReadonlySet<number> = new Set();

const opens = (v: JvmValue | null): v is JvmValue =>
  v?.kind === "object" || v?.kind === "array" || v?.kind === "string";

function terminalValue(result: Ready): JvmValue | null {
  const t = result.terminal;
  return t.kind === "value" ? t.value : t.kind === "threw" ? t.exception : null;
}

export function TraceResultView({
  session,
  result,
  outdated,
}: {
  session: DebugSessionId;
  result: Ready;
  outdated: boolean;
}) {
  const tx = useTx();
  const [view, setView] = useState<View>("flat");
  const [pair, setPair] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const fields = useTraceFields(session);

  const columns = useMemo(() => buildColumns(result.steps, result.records, tx), [result, tx]);
  const edges = useMemo(() => buildEdges(result.links), [result]);
  const slots = useMemo(() => {
    const out = new Int32Array(result.records.length);
    for (const c of columns) c.items.forEach((it, row) => (out[it.index] = row));
    return out;
  }, [columns, result]);
  const edgesInto = useMemo(() => {
    const out = new Map<number, Edge[]>();
    for (const e of edges) {
      const step = result.records[e.to]!.step;
      (out.get(step) ?? out.set(step, []).get(step)!).push(e);
    }
    return out;
  }, [edges, result]);
  const related = useMemo(
    () => (selected == null || selected === RESULT ? NONE : relatedTo(selected, edges)),
    [selected, edges],
  );

  const selection: TraceSelection = {
    selected,
    related,
    onSelect: (i) => setSelected((cur) => (cur === i ? null : i)),
  };
  const value = selected === RESULT ? terminalValue(result) : selected != null ? result.records[selected]!.value : null;
  const shownPair = Math.min(pair, Math.max(0, columns.length - 2));
  const capped = columns.some((c) => c.items.length > CELL_LIMIT);
  const limit = formatCount(CELL_LIMIT);

  return (
    <div className={styles.result}>
      <Tabs
        variant="compact"
        items={[
          { id: "flat", label: "Flat" },
          { id: "split", label: "Split" },
        ]}
        activeId={view}
        onSelect={(v) => setView(v as View)}
        aria-label={tx("Stream trace view")}
      />
      {outdated && (
        <div className={styles.note} role="status">
          {tx("Values can no longer be expanded after the program resumed")}
        </div>
      )}
      {capped && <div className={styles.note}>{tx`Each step shows its first ${limit} values`}</div>}
      {view === "split" && columns.length > 1 && (
        <Tabs
          variant="compact"
          items={columns.slice(0, -1).map((c, i) => {
            const text = `${c.title} → ${columns[i + 1]!.title}`;
            return { id: String(i), label: <span>{text}</span>, text };
          })}
          activeId={String(shownPair)}
          onSelect={(id) => setPair(Number(id))}
          aria-label={tx("Steps")}
        />
      )}
      <div className={styles.body}>
        <TraceColumns
          columns={view === "flat" ? columns : columns.slice(shownPair, shownPair + 2)}
          slots={slots}
          edgesInto={edgesInto}
          selection={selection}
          trailing={
            view === "flat" && (
              <ResultColumn
                value={terminalValue(result)}
                selected={selected === RESULT}
                onSelect={() => setSelected((cur) => (cur === RESULT ? null : RESULT))}
              />
            )
          }
        />
        {opens(value) && (
          <TraceValuePane
            key={selected}
            value={value}
            generation={result.generation}
            outdated={outdated}
            fields={fields}
          />
        )}
      </div>
    </div>
  );
}

function ResultColumn({
  value,
  selected,
  onSelect,
}: {
  value: JvmValue | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const tx = useTx();
  const title = tx("Result");
  return (
    <section className={clsx(styles.column, styles.resultColumn)} data-testid="stream-trace-result">
      <ColumnHead title={title} />
      <ul className={styles.cells} aria-label={title}>
        <li className={styles.cellRow}>
          {value ? (
            <button type="button" className={styles.cell} aria-pressed={selected} onClick={onSelect}>
              {formatJvmValue(value)}
            </button>
          ) : (
            <span className={styles.cellText}>{tx("No result")}</span>
          )}
        </li>
      </ul>
    </section>
  );
}
