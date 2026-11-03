/**
 * Dialogs of the Database tree's object actions, after IDEA's: Rename, Confirm
 * Drop, Truncate, Modify Table / New Table (with a Preview of the SQL they
 * run), Remove Data Source, Data Source from URL, and the Quick Documentation popup.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { call, commands, type DbColumnInfo, type DbDriver } from "@/platform/ipc";
import { highlightInto } from "@/editor/lsp/markdown";
import { Button, Checkbox, Dialog, IconButton, Input, Popup, Icon, T } from "@/ui";
import { parseSourceUrl, sourceLabel, splitTarget } from "./model";
import { nodeTarget, schemaObjectOf, tableOf, type DbNode } from "./nodes";
import {
  alterTableSql,
  canAlterColumn,
  createTableSql,
  draftOf,
  dropSql,
  ident,
  reference,
  renameSql,
  truncateSql,
  type ColumnDraft,
  type DbObjectRef,
} from "./objects";
import {
  closeDialog,
  detailsKey,
  connectedTargets,
  loadDetails,
  openSourceDialog,
  readableDdl,
  renameSource,
  runSql,
  sourceById,
  useDatabase,
  withConnection,
  type DialogState,
} from "./store";
import { openTableData } from "./treeActions";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

/** Read-only SQL with the editor's syntax colours (IDEA's dialog Preview pane). */
function SqlPreview({ sql, label = "Preview" }: { sql: string; label?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = sql;
    void highlightInto(el, sql, "SQL");
  }, [sql]);
  return (
    <div className={styles.previewBlock}>
      <div className={styles.previewTitle}>{label}</div>
      <pre ref={ref} className={styles.sqlPreview} aria-label={`${label} SQL`} />
    </div>
  );
}

const driverOf = (id: string): DbDriver => sourceById(id)?.driver ?? "sqlite";

const KIND_LABEL: Record<DbObjectRef["kind"], string> = {
  table: "table",
  view: "view",
  materializedView: "materialized view",
  column: "column",
  index: "index",
  schema: "schema",
  function: "function",
  procedure: "procedure",
  trigger: "trigger",
  sequence: "sequence",
};

function objectName(o: DbObjectRef): string {
  return o.kind === "column" ? (o.column ?? "") : o.name;
}

function useRunner() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const runAndClose = async (id: string, statements: string[]) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const ok = await runSql(id, statements);
    running.current = false;
    setBusy(false);
    if (ok) closeDialog();
  };
  return { busy, runAndClose };
}

// ---- Rename ------------------------------------------------------------------

function RenameDialog({ id, object }: { id: string; object: DbObjectRef | null }) {
  const source = sourceById(id);
  const initial = object ? objectName(object) : (source?.name ?? "");
  const [name, setName] = useState(initial);
  const { busy, runAndClose } = useRunner();
  const driver = driverOf(id);
  const changed = !!name.trim() && name.trim() !== initial;
  const sql = object && changed ? renameSql(driver, object, name.trim()) : "";
  const submit = () => {
    if (!changed) return closeDialog();
    if (!object) return void renameSource(id, name).then(closeDialog);
    void runAndClose(id, [sql]);
  };
  const what = object ? KIND_LABEL[object.kind] : "data source";
  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Rename"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Refactor", role: "default", disabled: busy || !name.trim(), onClick: submit },
      ]}
    >
      <div className={styles.dialogBody}>
        <label className={styles.formLabelLeft} htmlFor="db-rename">
          {tx`Rename ${what} '${initial}' to:`}
        </label>
        <Input
          id="db-rename"
          autoFocus
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
        {object && <SqlPreview sql={sql || `-- ${what} keeps its name`} />}
      </div>
    </Dialog>
  );
}

// ---- Drop / Truncate -----------------------------------------------------------

function DropDialog({ id, object }: { id: string; object: DbObjectRef }) {
  const driver = driverOf(id);
  const [ifExists, setIfExists] = useState(false);
  const [cascade, setCascade] = useState(false);
  const { busy, runAndClose } = useRunner();
  const sql = dropSql(driver, object, { ifExists, cascade });
  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Confirm Drop"
      width={520}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: busy, onClick: () => void runAndClose(id, [sql]) },
      ]}
    >
      <div className={styles.dialogBody}>
        <div className={styles.dialogLead}>
          {tx`Drop ${KIND_LABEL[object.kind]}`} <strong>{reference(driver, object)}</strong>
          {tx`? This cannot be undone.`}
        </div>
        <Checkbox
          checked={ifExists}
          onChange={setIfExists}
          label="Use IF EXISTS syntax"
          disabled={
            (object.kind === "column" && driver !== "postgres") || (object.kind === "index" && driver === "mysql")
          }
        />
        <Checkbox
          checked={cascade}
          onChange={setCascade}
          label="Use DROP CASCADE syntax"
          disabled={driver !== "postgres"}
        />
        <SqlPreview sql={sql} />
      </div>
    </Dialog>
  );
}

function TruncateDialog({ id, schema, table }: { id: string; schema: string; table: string }) {
  const driver = driverOf(id);
  const [restartIdentity, setRestart] = useState(false);
  const [cascade, setCascade] = useState(false);
  const { busy, runAndClose } = useRunner();
  const sql = truncateSql(driver, schema, table, { restartIdentity, cascade });
  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Truncate"
      width={520}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: busy, onClick: () => void runAndClose(id, [sql]) },
      ]}
    >
      <div className={styles.dialogBody}>
        <div className={styles.dialogLead}>
          <T>Delete all rows of</T> <strong>{table}</strong>?
        </div>
        {driver === "postgres" && (
          <>
            <Checkbox checked={restartIdentity} onChange={setRestart} label="Restart identity" />
            <Checkbox checked={cascade} onChange={setCascade} label="Cascade" />
          </>
        )}
        <SqlPreview sql={sql} />
      </div>
    </Dialog>
  );
}

// ---- Modify Table / New Table -----------------------------------------------

const TYPES: Record<DbDriver, string[]> = {
  sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB", "BOOLEAN", "DATE", "DATETIME"],
  postgres: [
    "integer",
    "bigint",
    "smallint",
    "serial",
    "bigserial",
    "numeric",
    "real",
    "double precision",
    "boolean",
    "text",
    "varchar(255)",
    "uuid",
    "date",
    "timestamp",
    "timestamptz",
    "jsonb",
    "bytea",
  ],
  mysql: [
    "int",
    "bigint",
    "smallint",
    "tinyint(1)",
    "decimal(10,2)",
    "double",
    "varchar(255)",
    "text",
    "date",
    "datetime",
    "timestamp",
    "json",
    "blob",
  ],
  sqlServer: [
    "int",
    "bigint",
    "smallint",
    "tinyint",
    "decimal(10,2)",
    "float",
    "real",
    "varchar(255)",
    "nvarchar(255)",
    "text",
    "ntext",
    "date",
    "datetime",
    "datetime2",
    "uniqueidentifier",
    "bit",
    "varbinary(max)",
  ],
};

interface ModifyProps {
  id: string;
  schema: string;
  table: string | null;
  focusColumn?: string;
  addColumn?: boolean;
}

let nextDraftKey = 1000;

function blankColumn(driver: DbDriver, n: number): ColumnDraft {
  return {
    key: nextDraftKey++,
    original: null,
    name: `column_${n}`,
    dataType: TYPES[driver][0]!,
    notNull: false,
    default: "",
    primaryKey: false,
    dropped: false,
  };
}

/** Loads the table's columns, then shows the Modify Table form. */
function ModifyTableDialog(props: ModifyProps) {
  const { id, schema, table } = props;
  const key = table ? detailsKey(id, schema, table) : null;
  const details = useDatabase((s) => (key ? s.details[key] : undefined));
  useEffect(() => {
    if (table && !details) void loadDetails(id, schema, table);
  }, [details, id, schema, table]);
  if (!table) return <ModifyTableForm {...props} initial={null} />;
  if (details?.status === "ok") return <ModifyTableForm {...props} initial={details.value.columns} />;
  return (
    <Dialog
      open
      onClose={closeDialog}
      title={tx`Modify Table ${table}`}
      width={440}
      buttons={[{ label: "Cancel", role: "cancel" }]}
    >
      <div className={styles.dialogText}>{details?.status === "error" ? details.message : tx("Loading…")}</div>
    </Dialog>
  );
}

function ModifyTableForm({
  id,
  schema,
  table,
  focusColumn,
  addColumn,
  initial,
}: ModifyProps & { initial: DbColumnInfo[] | null }) {
  const driver = driverOf(id);
  const [name, setName] = useState(table ?? "table_name");
  const [columns, setColumns] = useState<ColumnDraft[]>(() => {
    if (!initial) return [{ ...blankColumn(driver, 1), name: "id", primaryKey: true, notNull: true }];
    const drafts = initial.map(draftOf);
    if (addColumn) drafts.push(blankColumn(driver, drafts.length + 1));
    return drafts;
  });
  const [selected, setSelected] = useState<number | null>(() => {
    const focus = addColumn ? columns.length - 1 : columns.findIndex((c) => c.name === focusColumn);
    return columns[Math.max(0, focus)]?.key ?? null;
  });
  const { busy, runAndClose } = useRunner();

  const statements = useMemo(() => {
    if (!table) return [createTableSql(driver, schema, name.trim() || "table_name", columns)];
    return alterTableSql(driver, schema, table, name, columns);
  }, [columns, driver, schema, table, name]);

  const current = columns.find((c) => c.key === selected) ?? null;
  const patch = (p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c) => (c.key === selected ? { ...c, ...p } : c)));
  const add = () => {
    const c = blankColumn(driver, columns.length + 1);
    setColumns((cs) => [...cs, c]);
    setSelected(c.key);
  };
  const remove = () => {
    if (!current) return;
    if (current.original) patch({ dropped: !current.dropped });
    else {
      const rest = columns.filter((c) => c.key !== current.key);
      setColumns(rest);
      setSelected(rest.at(-1)?.key ?? null);
    }
  };
  const locked = !!current && !canAlterColumn(driver, current);
  const title = table ? `Modify Table ${table}` : "Create Table";
  const typeList = `db-types-${driver}`;

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={title}
      width={760}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "OK",
          role: "default",
          disabled: busy || !statements.length || !name.trim(),
          onClick: () => void runAndClose(id, statements),
        },
      ]}
    >
      <div className={styles.modifyBody}>
        <div className={styles.formRow}>
          <label className={styles.formLabel} htmlFor="db-table-name">
            <T>Table:</T>
          </label>
          <Input
            id="db-table-name"
            className={styles.fill}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!table}
          />
          <span className={styles.formHint}>{schema}</span>
        </div>
        <div className={styles.modifyMain}>
          <div className={styles.modifyColumns}>
            <div className={styles.modifyToolbar}>
              <IconButton icon="plus" title="Add Column" size="small" onClick={add} />
              <IconButton
                icon="minus"
                title={current?.dropped ? "Keep Column" : "Drop Column"}
                size="small"
                disabled={!current}
                onClick={remove}
              />
            </div>
            <div role="listbox" aria-label={tx("Columns")} className={styles.modifyList}>
              {columns.map((c) => (
                <div
                  key={c.key}
                  role="option"
                  aria-selected={c.key === selected}
                  tabIndex={-1}
                  className={styles.modifyItem}
                  data-dropped={c.dropped || undefined}
                  onMouseDown={() => setSelected(c.key)}
                >
                  <Icon name={c.primaryKey ? "db-column-key" : "db-column"} size={16} />
                  <span className={styles.nodeLabel}>{c.name || "<unnamed>"}</span>
                  <span className={styles.treeType}>{c.dataType}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.modifyProps}>
            {current ? (
              <>
                <label className={styles.formLabel} htmlFor="db-col-name">
                  <T>Name</T>
                </label>
                <Input
                  id="db-col-name"
                  value={current.name}
                  disabled={current.dropped}
                  onChange={(e) => patch({ name: e.target.value })}
                />
                <label className={styles.formLabel} htmlFor="db-col-type">
                  <T>Data type</T>
                </label>
                <Input
                  id="db-col-type"
                  mono
                  list={typeList}
                  value={current.dataType}
                  disabled={current.dropped || locked}
                  onChange={(e) => patch({ dataType: e.target.value })}
                />
                <span />
                <Checkbox
                  checked={current.notNull}
                  disabled={current.dropped || locked}
                  onChange={(notNull) => patch({ notNull })}
                  label="Not null"
                />
                {!table && (
                  <>
                    <span />
                    <Checkbox
                      checked={current.primaryKey}
                      onChange={(primaryKey) => patch({ primaryKey })}
                      label="Primary key"
                    />
                  </>
                )}
                <label className={styles.formLabel} htmlFor="db-col-default">
                  <T>Default</T>
                </label>
                <Input
                  id="db-col-default"
                  mono
                  placeholder="expression"
                  value={current.default}
                  disabled={current.dropped || locked}
                  onChange={(e) => patch({ default: e.target.value })}
                />
                {locked && (
                  <>
                    <span />
                    <span className={styles.formHint}>
                      <T>SQLite can rename or drop an existing column, not change its type, NOT NULL or default.</T>
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className={styles.formHint}>
                <T>Select a column</T>
              </span>
            )}
          </div>
        </div>
        <datalist id={typeList}>
          {TYPES[driver].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <SqlPreview sql={statements.join("\n") || "-- no changes"} />
      </div>
    </Dialog>
  );
}

// ---- Data sources -------------------------------------------------------------

function SourceUrlDialog() {
  const [url, setUrl] = useState("");
  const parsed = url.trim() ? parseSourceUrl(url) : null;
  const next = () => {
    if (!parsed) return;
    closeDialog();
    const s = parsed.source;
    const name = s.driver === "sqlite" ? s.name : `${s.database || s.user || "db"}@${s.host}`;
    openSourceDialog(null, { ...s, name }, parsed.password);
  };
  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Data Source from URL"
      width={560}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: !parsed, onClick: next },
      ]}
    >
      <div className={styles.dialogBody}>
        <label className={styles.formLabelLeft} htmlFor="db-url">
          <T>URL:</T>
        </label>
        <Input
          id="db-url"
          mono
          autoFocus
          invalid={!!url.trim() && !parsed}
          placeholder="postgresql://user@localhost:5432/db"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <span className={styles.formHint}>
          {url.trim() && !parsed
            ? tx("Not a URL of PostgreSQL, MySQL, SQLite or a compatible database")
            : "postgresql://, mysql://, mariadb://, redshift://, tidb://…, jdbc:…, sqlite:path"}
        </span>
      </div>
    </Dialog>
  );
}

// ---- Quick Documentation ------------------------------------------------------

function QuickDoc({ node, anchor }: { node: DbNode; anchor: { x: number; y: number } }) {
  const id = nodeTarget(node) ?? "";
  const source = sourceById(id);
  const t = tableOf(node);
  const [ddl, setDdl] = useState<string | null>(null);
  const object = schemaObjectOf(node);
  const showDdl = node.kind === "table" || !!object;
  useEffect(() => {
    if (!showDdl || (!t && !object)) return;
    let live = true;
    const read = object
      ? withConnection(object.id, () => call(commands.dbObjectDdl(object.id, object.schema, object.kind, object.name)))
      : withConnection(t!.id, () => call(commands.dbDdl(t!.id, t!.schema, t!.table))).then((d) =>
          readableDdl(d, driverOf(t!.id)),
        );
    read
      .then((d) => live && setDdl(d))
      .catch((e: unknown) => live && setDdl(`-- ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.key]);

  const rows: Array<[string, string]> = [];
  if (source) rows.push(["Data Source", source.name ?? ""]);
  const db = splitTarget(id).database;
  if (db) rows.push(["Database", db]);
  switch (node.kind) {
    case "source":
      rows.push(["Driver", sourceLabel(node.source).replace(/^.*\((.*)\)$/, "$1")]);
      if (node.source.comment?.trim()) rows.push(["Comment", node.source.comment.trim()]);
      rows.push(
        node.source.driver === "sqlite"
          ? ["File", node.source.file ?? ""]
          : [
              "Host",
              `${node.source.host ?? ""}${node.source.port ? `:${node.source.port}` : ""}${node.source.database ? `/${node.source.database}` : ""}`,
            ],
      );
      rows.push(["Status", connectedTargets(node.source.id ?? "").length ? "Connected" : "Not connected"]);
      break;
    case "database":
      rows.push(["Database", node.name]);
      break;
    case "schema":
    case "folder":
      rows.push(["Schema", node.schema]);
      break;
    case "routine":
      rows.push(
        ["Schema", node.schema],
        [node.routine.kind === "procedure" ? "Procedure" : "Function", node.routine.name],
      );
      if (node.routine.arguments) rows.push(["Arguments", node.routine.arguments]);
      if (node.routine.returns) rows.push(["Returns", node.routine.returns]);
      break;
    case "sequence":
      rows.push(["Schema", node.schema], ["Sequence", node.sequence.name], ["Type", node.sequence.dataType]);
      break;
    case "trigger":
      rows.push(
        ["Table", node.table],
        ["Trigger", node.trigger.name],
        ["Fires", `${node.trigger.timing} ${node.trigger.events}`],
      );
      break;
    default:
      if (t) rows.push(["Schema", t.schema], [t.view ? "View" : "Table", t.table]);
  }
  let definition: string | null = null;
  if (node.kind === "column") {
    const c = node.column;
    const d = driverOf(id);
    definition = `${ident(d, c.name)} ${c.dataType}${c.nullable ? "" : " not null"}${c.default ? ` default ${c.default}` : ""}${c.primaryKey ? " primary key" : ""}`;
  } else if (node.kind === "index") {
    definition = `${node.index.unique ? "unique " : ""}index ${node.index.name} (${node.index.columns.join(", ")})`;
  } else if (node.kind === "foreignKey") {
    definition = `foreign key (${node.fk.columns.join(", ")}) references ${node.fk.refTable} (${node.fk.refColumns.join(", ")})`;
  } else if (node.kind === "key") {
    definition = `primary key (${node.columns.join(", ")})`;
  }
  return (
    <Popup
      open
      onClose={closeDialog}
      anchor={anchor}
      placement="bottom-start"
      className={styles.quickDoc}
      role="dialog"
      aria-label="Quick Documentation"
    >
      <dl className={styles.quickDocRows}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}:</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {definition && <SqlPreview sql={definition} label="Definition" />}
      {showDdl && <SqlPreview sql={ddl ?? "-- loading…"} label="DDL" />}
      {t && (
        <div className={styles.quickDocLinks}>
          <Button
            variant="ghost"
            onClick={() => {
              closeDialog();
              openTableData(t.id, t.schema, t.table);
            }}
          >
            <T>Show table data</T>
          </Button>
        </div>
      )}
    </Popup>
  );
}

export function ObjectDialogs() {
  const dialog = useDatabase((s) => s.dialog) as DialogState | null;
  if (!dialog) return null;
  switch (dialog.kind) {
    case "rename":
      return <RenameDialog key={`${dialog.id}`} id={dialog.id} object={dialog.object} />;
    case "drop":
      return <DropDialog id={dialog.id} object={dialog.object} />;
    case "truncate":
      return <TruncateDialog id={dialog.id} schema={dialog.schema} table={dialog.table} />;
    case "modifyTable":
      return (
        <ModifyTableDialog
          id={dialog.id}
          schema={dialog.schema}
          table={dialog.table}
          focusColumn={dialog.focusColumn}
          addColumn={dialog.addColumn}
        />
      );
    case "sourceUrl":
      return <SourceUrlDialog />;
    case "quickDoc":
      return <QuickDoc key={dialog.node.key} node={dialog.node} anchor={dialog.anchor} />;
    default:
      return null;
  }
}
