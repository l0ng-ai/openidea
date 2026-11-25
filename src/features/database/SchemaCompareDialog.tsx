/**
 * Compare Structure (DataGrip's schema comparison): pick a source and a target schema,
 * see their differences — tables, columns, indexes, foreign keys — choose the ones to
 * migrate and preview the SQL that makes the target match the source. Nothing runs: the
 * script is copied or opened in a query console of the target.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { tx, txPart } from "@/platform/i18n";
import { Button, Checkbox, Dialog, EmptyState, Icon, Select, Spinner, T, Tree, type SelectOption } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { CodePreview } from "./CodePreview";
import {
  diffSchemas,
  differenceKeys,
  migrationSql,
  type DiffState,
  type ItemDiff,
  type TableDiff,
} from "./schemaCompare";
import {
  closeDialog,
  loadSchemas,
  loadSources,
  openConsoleWith,
  schemaSnapshot,
  sourceById,
  targetLabel,
  useDatabase,
} from "./store";
import styles from "./SchemaCompare.module.css";

interface Side {
  id: string;
  schema: string;
}

/** A row of the differences tree: a table, a group of its items, or an item. */
type Row =
  | { kind: "table"; key: string; diff: TableDiff }
  | { kind: "group"; key: string; label: string; items: ItemDiff<unknown>[]; table: TableDiff }
  | { kind: "item"; key: string; diff: ItemDiff<unknown>; table: TableDiff; what: "column" | "index" | "foreignKey" };

const STATE_LABEL: Record<DiffState, string> = {
  added: "Only in source",
  removed: "Only in target",
  changed: "Different",
  same: "Identical",
};

function SidePicker({ label, side, onChange }: { label: string; side: Side; onChange: (side: Side) => void }) {
  const sources = useDatabase((s) => s.sources);
  const schemas = useDatabase((s) => (side.id ? s.schemas[side.id] : undefined));
  useEffect(() => {
    if (side.id && !useDatabase.getState().schemas[side.id]) void loadSchemas(side.id);
  }, [side.id]);
  const sourceOptions: SelectOption[] = sources
    .filter((s) => s.driver !== "jdbc")
    .map((s) => ({
      value: s.id ?? "",
      label: s.name ?? "",
      icon: "database",
    }));
  if (side.id && !sourceOptions.some((o) => o.value === side.id))
    sourceOptions.push({ value: side.id, label: targetLabel(side.id), icon: "database" });
  const names = schemas?.status === "ok" ? schemas.value : [];
  const schemaOptions: SelectOption[] = names.map((n) => ({ value: n, label: n, icon: "db-schema" }));
  if (side.schema && !names.includes(side.schema)) schemaOptions.unshift({ value: side.schema, label: side.schema });
  return (
    <div className={styles.side}>
      <span className={styles.sideLabel}>
        <T>{label}</T>
      </span>
      <Select
        aria-label={tx`${txPart(label)} data source`}
        value={side.id || null}
        placeholder="<data source>"
        options={sourceOptions}
        onChange={(id) => onChange({ id, schema: sourceById(id)?.driver === "sqlite" ? "main" : "" })}
      />
      <Select
        aria-label={tx`${txPart(label)} schema`}
        value={side.schema || null}
        placeholder="<schema>"
        options={schemaOptions}
        searchable={schemaOptions.length > 10}
        disabled={!side.id}
        onChange={(schema) => onChange({ ...side, schema })}
      />
    </div>
  );
}

function StateIcon({ state }: { state: DiffState }) {
  return (
    <span
      className={clsx(styles.state, styles[state])}
      title={tx(STATE_LABEL[state])}
      aria-label={tx(STATE_LABEL[state])}
    >
      {state === "added" ? "+" : state === "removed" ? "−" : state === "changed" ? "≠" : "="}
    </span>
  );
}

function itemDetail(row: Extract<Row, { kind: "item" }>): string {
  const d = row.diff;
  if (row.what === "column") {
    const c = (x: unknown) => x as { dataType: string; nullable: boolean; default: string | null } | undefined;
    const s = c(d.source);
    const t = c(d.target);
    const text = (x: ReturnType<typeof c>) =>
      x ? `${x.dataType}${x.nullable ? "" : " not null"}${x.default ? ` default ${x.default}` : ""}` : "";
    if (d.state === "changed") return `${text(t)} → ${text(s)}`;
    return text(s ?? t);
  }
  if (row.what === "index") {
    const i = (d.source ?? d.target) as { unique: boolean; columns: string[] };
    return `${i.unique ? "unique " : ""}(${i.columns.join(", ")})`;
  }
  return "";
}

/** The direction of the migration, said in the footer. */
function migrates(source: Side, target: Side): string {
  const from = `${targetLabel(source.id)}.${source.schema}`;
  const to = `${targetLabel(target.id)}.${target.schema}`;
  return tx`Migrates ${to} to match ${from}`;
}

function includeLabel(r: Row): string {
  const name = r.kind === "group" ? txPart(r.label) : r.diff.name;
  return tx`Include ${name}`;
}

export function SchemaCompareDialog({ initial }: { initial: Side | null }) {
  const [source, setSource] = useState<Side>(initial ?? { id: "", schema: "" });
  const [target, setTarget] = useState<Side>({ id: "", schema: "" });
  const [diffs, setDiffs] = useState<TableDiff[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!useDatabase.getState().loaded) void loadSources();
    return () => abort.current?.abort();
  }, []);

  const ready = !!(source.id && source.schema && target.id && target.schema);
  const same = source.id === target.id && source.schema === target.schema;
  const targetDriver = sourceById(target.id)?.driver ?? "sqlite";

  const compare = async () => {
    abort.current?.abort();
    const controller = (abort.current = new AbortController());
    setBusy(true);
    setError(null);
    try {
      const [s, t] = await Promise.all([
        schemaSnapshot(source.id, source.schema, controller.signal),
        schemaSnapshot(target.id, target.schema, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const result = diffSchemas(s, t);
      setDiffs(result);
      setPicked(differenceKeys(result));
      // Changed tables open down to their differing items.
      const open = result.filter((d) => d.state === "changed");
      setExpanded(
        new Set(open.flatMap((d) => [d.key, ...["Columns", "Indexes", "Foreign Keys"].map((g) => `${d.key}/${g}`)])),
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const shown = useMemo(
    () => (diffs ?? []).filter((d) => !onlyDifferences || d.state !== "same"),
    [diffs, onlyDifferences],
  );
  const sql = useMemo(
    () => (diffs ? migrationSql(targetDriver, target.schema, diffs, picked) : ""),
    [diffs, picked, targetDriver, target.schema],
  );
  const differences = (diffs ?? []).filter((d) => d.state !== "same").length;

  const children = (row: Row): Row[] | undefined => {
    if (row.kind === "table") {
      const d = row.diff;
      const groups: Row[] = [];
      const add = (label: string, items: ItemDiff<unknown>[]) => {
        const visible = items.filter((i) => !onlyDifferences || i.state !== "same");
        if (visible.length) groups.push({ kind: "group", key: `${d.key}/${label}`, label, items: visible, table: d });
      };
      add("Columns", d.columns);
      add("Indexes", d.indexes);
      add("Foreign Keys", d.foreignKeys);
      return groups;
    }
    if (row.kind === "group") {
      const what = row.label === "Columns" ? "column" : row.label === "Indexes" ? "index" : "foreignKey";
      return row.items.map((diff) => ({ kind: "item", key: diff.key, diff, table: row.table, what }));
    }
    return undefined;
  };

  /** The keys a row's checkbox covers: a table covers its items too. */
  const keysOf = (row: Row): string[] => {
    if (row.kind === "item") return row.diff.state === "same" ? [] : [row.diff.key];
    const d = row.kind === "table" ? row.diff : row.table;
    const items = row.kind === "group" ? row.items : [...d.columns, ...d.indexes, ...d.foreignKeys];
    const own = row.kind === "table" && d.state !== "same" ? [d.key] : [];
    return [...own, ...items.filter((i) => i.state !== "same").map((i) => i.key)];
  };
  const toggle = (row: Row, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const k of keysOf(row)) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const roots: Row[] = shown.map((diff) => ({ kind: "table", key: diff.key, diff }));

  const copy = async () => {
    await navigator.clipboard.writeText(sql);
    notifications().notify({ level: "info", title: "Migration script copied", key: "db-compare" });
  };

  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Compare Structure"
      width={1040}
      footerStart={<span className={styles.direction}>{ready && migrates(source, target)}</span>}
      buttons={[
        { label: "Close", role: "cancel" },
        { label: "Copy", disabled: !sql, onClick: () => void copy() },
        {
          label: "Open in Console",
          role: "default",
          disabled: !sql,
          onClick: () => {
            closeDialog();
            void openConsoleWith(target.id, sql);
          },
        },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.pickers}>
          <SidePicker label="Source" side={source} onChange={setSource} />
          <Icon name="arrow-right" size={14} className={styles.arrow} />
          <SidePicker label="Target" side={target} onChange={setTarget} />
          <Button size="small" variant="primary" disabled={!ready || same || busy} onClick={() => void compare()}>
            <T>Compare</T>
          </Button>
          {busy && <Spinner size={14} />}
        </div>
        <div className={styles.toolbar}>
          <Checkbox checked={onlyDifferences} onChange={setOnlyDifferences} label="Show only differences" />
          <span className={styles.spacer} />
          {diffs && <span className={styles.count}>{tx`${differences} of ${diffs.length} tables differ`}</span>}
        </div>
        <div className={styles.panes}>
          <div className={styles.tree}>
            {error ? (
              <EmptyState title="Cannot compare">{error}</EmptyState>
            ) : !diffs ? (
              <EmptyState
                title={busy ? "Reading the schemas…" : "Pick a source and a target schema, then Compare"}
                icon="diff-side-by-side"
              />
            ) : (
              <Tree<Row>
                roots={roots}
                getKey={(r) => r.key}
                getLabel={(r) => (r.kind === "table" ? r.diff.name : r.kind === "group" ? r.label : r.diff.name)}
                getChildren={children}
                isExpandable={(r) => r.kind !== "item"}
                expanded={expanded}
                onExpandedChange={(next) => setExpanded(next)}
                aria-label={tx("Differences")}
                empty={<EmptyState title="The schemas have the same structure" />}
                renderNode={(r) => {
                  const keys = keysOf(r);
                  const on = keys.filter((k) => picked.has(k)).length;
                  const state = r.kind === "group" ? null : r.diff.state;
                  return (
                    <span className={styles.row}>
                      {keys.length > 0 && (
                        <Checkbox
                          checked={on === keys.length}
                          indeterminate={on > 0 && on < keys.length}
                          onChange={(v) => toggle(r, v)}
                          aria-label={includeLabel(r)}
                        />
                      )}
                      {state && <StateIcon state={state} />}
                      <Icon
                        name={
                          r.kind === "table"
                            ? "db-table"
                            : r.kind === "group"
                              ? "db-folder"
                              : r.what === "column"
                                ? "db-column"
                                : r.what === "index"
                                  ? "db-index"
                                  : "db-foreign-key"
                        }
                        size={14}
                      />
                      <span className={styles.name}>
                        {r.kind === "table" ? r.diff.name : r.kind === "group" ? tx(r.label) : r.diff.name}
                      </span>
                      {r.kind === "item" && <span className={styles.detail}>{itemDetail(r)}</span>}
                    </span>
                  );
                }}
              />
            )}
          </div>
          <div className={styles.preview}>
            <span className={styles.previewLabel}>
              <T>Migration script</T>
            </span>
            <CodePreview sql aria-label="Migration script" text={sql} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
