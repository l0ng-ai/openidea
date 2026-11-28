/**
 * Dialogs of the Database tree's object actions, after IDEA's: Rename, Confirm
 * Drop, Truncate, Modify Table / New Table, New Database / New Schema (with a
 * Preview of the SQL they run), Remove Data Source, Data Source from URL, and the Quick Documentation popup.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  call,
  commands,
  type DbColumnInfo,
  type DbDriver,
  type DbPersistence,
  type DbSourceFolder,
  type DbTableDetails,
  type DbTableGrant,
} from "@/platform/ipc";
import { highlightInto } from "@/editor/lsp/markdown";
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Input,
  Popup,
  Icon,
  SearchField,
  Select,
  T,
  Tabs,
  tooltipAttrs,
  type SelectOption,
} from "@/ui";
import { parseSourceUrl, sourceLabel, splitTarget } from "./model";
import { nodeTarget, schemaObjectOf, tableOf, type DbNode } from "./nodes";
import {
  alterTableSql,
  canAlterColumn,
  canAlterIndex,
  canChangePrimaryKey,
  createDatabaseSql,
  createSchemaSql,
  commentsSupported,
  createTableCommentSql,
  createTableKeySql,
  createTableSql,
  draftOf,
  dropDatabaseSql,
  grantMatrix,
  grantsSupported,
  hasTableProperties,
  indexDraftOf,
  keyName,
  keySupport,
  propertySupport,
  renameDatabaseSql,
  dropSql,
  ident,
  reference,
  renameSql,
  tablePropertiesOf,
  truncateSql,
  type ColumnDraft,
  type IndexDraft,
  type TableProperties,
  templateOf,
  type CreateOptions,
  type DbObjectRef,
} from "./objects";
import {
  closeDialog,
  createSourceFolder,
  detailsKey,
  connectedTargets,
  createDatabase,
  dropDatabase,
  renameDatabase,
  loadDetails,
  loadGrants,
  loadTables,
  openSourceDialog,
  readableDdl,
  refresh,
  renameSourceFolder,
  renameSource,
  runSql,
  sourceById,
  useDatabase,
  withConnection,
  type DialogState,
} from "./store";
import { openTableData } from "./treeActions";
import styles from "./Database.module.css";
import { tx, txPart } from "@/platform/i18n";

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
  package: "package",
  trigger: "trigger",
  sequence: "sequence",
};

function objectName(o: DbObjectRef): string {
  return o.kind === "column" ? (o.column ?? "") : o.name;
}

function useRunner() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const runAndClose = async (id: string, statements: string[]): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    const ok = await runSql(id, statements);
    running.current = false;
    setBusy(false);
    if (ok) closeDialog();
    return ok;
  };
  return { busy, runAndClose };
}

// ---- Rename ------------------------------------------------------------------

/** Renames a data source, a schema object, or (with `database`) a database of the server. */
function RenameDialog({ id, object, database }: { id: string; object: DbObjectRef | null; database?: string }) {
  const source = sourceById(id);
  const initial = database ?? (object ? objectName(object) : (source?.name ?? ""));
  const [name, setName] = useState(initial);
  const { busy, runAndClose } = useRunner();
  const [renaming, setRenaming] = useState(false);
  const driver = driverOf(id);
  const changed = !!name.trim() && name.trim() !== initial;
  const sql = !changed
    ? ""
    : database !== undefined
      ? renameDatabaseSql(driver, database, name.trim())
      : object
        ? renameSql(driver, object, name.trim())
        : "";
  const submit = async () => {
    if (!changed) return closeDialog();
    if (database !== undefined) {
      setRenaming(true);
      if (await renameDatabase(id, database, sql)) closeDialog();
      else setRenaming(false);
      return;
    }
    if (!object) return void renameSource(id, name).then(closeDialog);
    void runAndClose(id, [sql]);
  };
  const what = database !== undefined ? "database" : object ? KIND_LABEL[object.kind] : "data source";
  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Rename"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "Refactor",
          role: "default",
          disabled: busy || renaming || !name.trim(),
          onClick: () => void submit(),
        },
      ]}
    >
      <div className={styles.dialogBody}>
        <label className={styles.formLabelLeft} htmlFor="db-rename">
          {tx`Rename ${txPart(what)} '${initial}' to:`}
        </label>
        <Input
          id="db-rename"
          autoFocus
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
        {(object || database !== undefined) && <SqlPreview sql={sql || `-- ${what} keeps its name`} />}
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
          {tx`Drop ${txPart(KIND_LABEL[object.kind])}`} <strong>{reference(driver, object)}</strong>
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

// ---- New Database / New Schema / Drop database ---------------------------------

const TEMPLATES: SelectOption[] = [
  { value: "", label: "Server default" },
  ...["template0", "template1"].map((name) => ({ value: name, label: name, verbatim: true })),
];

/** An optional text field of the create dialogs: empty leaves it to the server. */
function OptionField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label className={styles.formLabel} htmlFor={id}>
        {tx(label)}
      </label>
      <Input id={id} placeholder="Server default" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

/** New › Database (`database`) or New › Schema (`schema`) in target `id`. */
function CreateDialog({ id, what }: { id: string; what: "database" | "schema" }) {
  const driver = driverOf(id);
  const [name, setName] = useState("");
  const [opts, setOpts] = useState<CreateOptions>({});
  const { busy: running, runAndClose } = useRunner();
  const [creating, setCreating] = useState(false);
  const busy = running || creating;
  const sql = (what === "database" ? createDatabaseSql : createSchemaSql)(driver, name.trim() || "<name>", opts);
  const submit = async () => {
    if (what === "schema") {
      if (await runAndClose(id, [sql])) void refresh(id);
      return;
    }
    setCreating(true);
    if (await createDatabase(id, templateOf(driver, opts), sql)) closeDialog();
    else setCreating(false);
  };
  const field = (key: keyof CreateOptions, label: string) => (
    <OptionField
      id={`db-new-${key}`}
      label={label}
      value={opts[key] ?? ""}
      onChange={(value) => setOpts((o) => ({ ...o, [key]: value }))}
    />
  );
  return (
    <Dialog
      open
      onClose={closeDialog}
      title={what === "database" ? "New Database" : "New Schema"}
      width={560}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: busy || !name.trim(), onClick: submit },
      ]}
    >
      <div className={styles.form}>
        <label className={styles.formLabel} htmlFor="db-new-name">
          <T>Name:</T>
        </label>
        <Input id="db-new-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        {what === "database" && driver === "postgres" && (
          <>
            {field("owner", "Owner:")}
            <label className={styles.formLabel} htmlFor="db-new-template">
              <T>Template:</T>
            </label>
            <Select
              id="db-new-template"
              value={opts.template ?? ""}
              options={TEMPLATES}
              onChange={(template) => setOpts((o) => ({ ...o, template }))}
            />
            <span />
            <span className={styles.formHint}>
              <T>Restoring a dump needs template0: template1 can already hold extensions and schemas.</T>
            </span>
            {field("encoding", "Encoding:")}
            {field("tablespace", "Tablespace:")}
          </>
        )}
        {what === "database" && driver === "sqlServer" && field("collation", "Collation:")}
        {what === "schema" && driver === "mysql" && (
          <>
            {field("charset", "Character set:")}
            {field("collation", "Collation:")}
          </>
        )}
        {what === "schema" && driver !== "mysql" && field("owner", "Owner:")}
        <div className={styles.formFull}>
          <SqlPreview sql={sql} />
        </div>
      </div>
    </Dialog>
  );
}

/** PostgreSQL 13 added `drop database … with (force)`. */
const PG_FORCE_DROP = 130000;

function DropDatabaseDialog({ id, database }: { id: string; database: string }) {
  const driver = driverOf(id);
  const [force, setForce] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (driver !== "postgres") return;
    let live = true;
    void withConnection(id, () => call(commands.dbServerVersion(id)))
      .then((v) => live && setVersion(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, driver]);
  const canForce = driver === "sqlServer" || (version ?? 0) >= PG_FORCE_DROP;
  const sql = dropDatabaseSql(driver, database, force && canForce);
  const submit = async () => {
    setBusy(true);
    if (await dropDatabase(id, database, sql)) closeDialog();
    else setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Confirm Drop"
      width={520}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: busy, onClick: () => void submit() },
      ]}
    >
      <div className={styles.dialogBody}>
        <div className={styles.dialogLead}>
          {tx`Drop database`} <strong>{database}</strong>
          {tx`? This cannot be undone.`}
        </div>
        <span className={styles.formHint}>
          <T>The IDE closes its own connections to the database first.</T>
        </span>
        <Checkbox
          checked={force && canForce}
          onChange={setForce}
          disabled={!canForce}
          label="Close the sessions of other clients"
        />
        <SqlPreview sql={sql} />
      </div>
    </Dialog>
  );
}

// ---- Modify Table / New Table -----------------------------------------------

const TYPES: Record<DbDriver, string[]> = {
  jdbc: [],
  snowflake: [
    "NUMBER(38,0)",
    "NUMBER(10,2)",
    "FLOAT",
    "VARCHAR",
    "BOOLEAN",
    "DATE",
    "TIME",
    "TIMESTAMP_NTZ",
    "TIMESTAMP_LTZ",
    "TIMESTAMP_TZ",
    "VARIANT",
    "OBJECT",
    "ARRAY",
    "BINARY",
  ],
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
  clickhouse: ["UInt64", "Int64", "Float64", "String", "Bool", "Date", "DateTime", "UUID", "Nullable(String)"],
  oracle: [
    "NUMBER",
    "NUMBER(10)",
    "NUMBER(19, 4)",
    "INTEGER",
    "BINARY_FLOAT",
    "BINARY_DOUBLE",
    "VARCHAR2(255)",
    "VARCHAR2(4000)",
    "NVARCHAR2(255)",
    "CHAR(1)",
    "CLOB",
    "BLOB",
    "RAW(16)",
    "DATE",
    "TIMESTAMP",
    "TIMESTAMP WITH TIME ZONE",
    "INTERVAL DAY TO SECOND",
    "XMLTYPE",
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
    comment: "",
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
  if (details?.status === "ok")
    return <ModifyTableForm {...props} initial={details.value.columns} details={details.value} />;
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

/** A row of the Modify Table list after Columns: a key, foreign key, index or trigger. */
interface ObjectRow {
  key: string;
  name: string;
  detail: string;
  /** The unique key or index draft it shows (selectable); absent: read-only. */
  draft?: IndexDraft;
}

/** A key / index draft of the dialog; a new one names its columns by their drafts' keys, so a rename carries over. */
type KeyDraft = IndexDraft & { columnKeys: number[] };

/** What the Modify Table list has selected: a column or a key / index draft, by its draft key. */
interface Selection {
  group: "column" | "index";
  key: number;
}

/**
 * The groups after Columns, as DataGrip lists them: the primary key of the columns as edited and
 * the unique keys, then the foreign keys and triggers the table has (shown, not edited here), and the indexes.
 */
function objectGroups(
  columns: readonly ColumnDraft[],
  indexes: readonly IndexDraft[],
  details: DbTableDetails | null | undefined,
): Array<{ id: string; label: string; icon: string; rows: ObjectRow[] }> {
  const pk = columns.filter((c) => c.primaryKey && !c.dropped).map((c) => c.name);
  const list = (names: readonly string[]) => `(${names.join(", ")})`;
  const draftRow = (d: IndexDraft): ObjectRow => ({
    key: `d-${d.key}`,
    name: d.name,
    // `UNIQUE` is SQL, not UI text.
    detail: d.unique ? ["UNIQUE", list(d.columns)].join(" ") : list(d.columns),
    draft: d,
  });
  return [
    {
      id: "keys",
      label: "Keys",
      icon: "db-key",
      rows: [
        ...(pk.length ? [{ key: "primary", name: "PRIMARY KEY", detail: list(pk) }] : []),
        ...indexes.filter((d) => d.kind === "unique").map(draftRow),
      ],
    },
    {
      id: "foreignKeys",
      label: "Foreign Keys",
      icon: "db-foreign-key",
      rows: (details?.foreignKeys ?? []).map((fk, i) => ({
        key: `fk-${i}`,
        name: list(fk.columns),
        detail: `→ ${fk.refTable} ${list(fk.refColumns)}`,
      })),
    },
    {
      id: "indexes",
      label: "Indexes",
      icon: "db-index",
      rows: indexes.filter((d) => d.kind === "index").map(draftRow),
    },
    {
      id: "triggers",
      label: "Triggers",
      icon: "db-trigger",
      rows: (details?.triggers ?? []).map((t) => ({
        key: `tr-${t.name}`,
        name: t.name,
        detail: `${t.timing} ${t.events}`.toUpperCase(),
      })),
    },
  ];
}

function ModifyTableForm({
  id,
  schema,
  table,
  focusColumn,
  addColumn,
  initial,
  details,
}: ModifyProps & { initial: DbColumnInfo[] | null; details?: DbTableDetails }) {
  const driver = driverOf(id);
  const [name, setName] = useState(table ?? "table_name");
  const [columns, setColumns] = useState<ColumnDraft[]>(() => {
    if (!initial)
      return [{ ...blankColumn(driver, 1), name: "id", primaryKey: driver !== "clickhouse", notNull: true }];
    const drafts = initial.map(draftOf);
    if (addColumn) drafts.push(blankColumn(driver, drafts.length + 1));
    return drafts;
  });
  const [drafts, setDrafts] = useState<KeyDraft[]>(() =>
    (details?.indexes ?? []).flatMap((i) => {
      const d = indexDraftOf(i, nextDraftKey++);
      return d ? [{ ...d, columnKeys: [] }] : [];
    }),
  );
  // New keys and indexes list their columns as named now; existing ones as the catalog has them.
  const indexes = useMemo(
    () =>
      drafts.map((d): KeyDraft => {
        if (d.original) return d;
        const named = d.columnKeys.flatMap((k) => {
          const c = columns.find((c) => c.key === k);
          return c && !c.dropped && c.name.trim() ? [c.name.trim()] : [];
        });
        return { ...d, columns: named };
      }),
    [drafts, columns],
  );
  const [selected, setSelected] = useState<Selection | null>(() => {
    const focus = addColumn ? columns.length - 1 : columns.findIndex((c) => c.name === focusColumn);
    const key = columns[Math.max(0, focus)]?.key;
    return key === undefined ? null : { group: "column", key };
  });
  const { busy, runAndClose } = useRunner();
  const comments = commentsSupported(driver);
  const [comment, setComment] = useState(details?.comment ?? "");
  const support = keySupport(driver);
  const pkIndex = details?.indexes.find((i) => i.key === "primary")?.name;
  const [properties, setProperties] = useState<TableProperties>(() => tablePropertiesOf(details));

  const statements = useMemo(() => {
    if (!table) {
      const created = name.trim() || "table_name";
      return [
        createTableSql(driver, schema, created, columns, comment),
        ...createTableCommentSql(driver, schema, created, columns, comment),
        ...createTableKeySql(driver, schema, created, indexes),
      ];
    }
    return alterTableSql(
      driver,
      schema,
      table,
      name,
      columns,
      { original: details?.comment ?? "", value: comment },
      { primaryKeyName: pkIndex, indexes },
      { original: tablePropertiesOf(details), value: properties },
    );
  }, [columns, indexes, driver, schema, table, name, comment, details, pkIndex, properties]);

  const current = (selected?.group === "column" && columns.find((c) => c.key === selected.key)) || null;
  const currentIndex = (selected?.group === "index" && indexes.find((d) => d.key === selected.key)) || null;
  const patch = (p: Partial<ColumnDraft>) => {
    if (!current) return;
    setColumns((cs) => cs.map((c) => (c.key === current.key ? { ...c, ...p } : c)));
  };
  const patchIndex = (p: Partial<KeyDraft>) =>
    setDrafts((ds) => ds.map((d) => (d.key === currentIndex?.key ? { ...d, ...p } : d)));
  const add = () => {
    const c = blankColumn(driver, columns.length + 1);
    setColumns((cs) => [...cs, c]);
    setSelected({ group: "column", key: c.key });
  };
  /** Adds a unique key or an index on the selected column, named as DataGrip names them. */
  const addIndex = (kind: IndexDraft["kind"]) => {
    const base = name.trim() || table || "table_name";
    const taken = new Set(indexes.map((d) => d.name));
    const suffix = kind === "unique" ? "uk" : "index";
    let indexName = keyName(driver, base, suffix);
    for (let n = 2; taken.has(indexName); n++) indexName = keyName(driver, base, `${suffix}_${n}`);
    const d: KeyDraft = {
      key: nextDraftKey++,
      kind,
      original: null,
      name: indexName,
      columns: [],
      columnKeys: current && !current.dropped ? [current.key] : [],
      unique: kind === "unique",
      dropped: false,
    };
    setDrafts((ds) => [...ds, d]);
    setSelected({ group: "index", key: d.key });
  };
  const remove = () => {
    if (currentIndex) {
      if (currentIndex.original) patchIndex({ dropped: !currentIndex.dropped });
      else {
        setDrafts((ds) => ds.filter((d) => d.key !== currentIndex.key));
        setSelected(null);
      }
      return;
    }
    if (!current) return;
    if (current.original) patch({ dropped: !current.dropped });
    else {
      const rest = columns.filter((c) => c.key !== current.key);
      setColumns(rest);
      const last = rest.at(-1);
      setSelected(last ? { group: "column", key: last.key } : null);
    }
  };
  const locked = !!current && !canAlterColumn(driver, current);
  // An existing table's primary key changes where the engine can drop and add it.
  const primaryKeyEditable = !table || canChangePrimaryKey(driver, columns, pkIndex);
  const indexLocked = !!currentIndex?.original && !canAlterIndex(driver, currentIndex);
  // An existing key or index is kept or dropped, not edited (see `IndexDraft`).
  const indexFixed = !!currentIndex && (!!currentIndex.original || currentIndex.dropped);
  const liveColumns = columns.filter((c) => !c.dropped && c.name.trim());
  // The list's filter (names and types) and its collapsed groups.
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const query = filter.trim().toLowerCase();
  const matches = (...texts: string[]) => !query || texts.some((t) => t.toLowerCase().includes(query));
  const shownColumns = columns.filter((c) => matches(c.name, c.dataType));
  const groups = objectGroups(columns, indexes, details)
    .map((g) => ({ ...g, rows: g.rows.filter((r) => matches(r.name, r.detail)) }))
    .filter((g) => g.rows.length);
  const toggleGroup = (group: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(group)) next.add(group);
      return next;
    });
  const groupHeader = (group: string, label: string, count: number) => (
    <div className={styles.modifyGroup} onMouseDown={() => toggleGroup(group)}>
      <Icon name={collapsed.has(group) ? "chevron-right" : "chevron-down"} size={12} />
      <span>{tx(label)}</span>
      <span className={styles.treeType}>{count}</span>
    </div>
  );
  const showGrants = !!table && grantsSupported(driver);
  const showProperties = !!table && hasTableProperties(details);
  const [tab, setTab] = useState<"columns" | "properties" | "grants">("columns");
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
          onClick: () =>
            void runAndClose(id, statements).then((ok) => {
              if (!ok) return;
              // The tree and the next Modify Table show the table as it now is.
              const final = name.trim();
              void loadDetails(id, schema, final);
              if (final !== table) void loadTables(id, schema);
            }),
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
        {comments && (
          <div className={styles.formRow}>
            <label className={styles.formLabel} htmlFor="db-table-comment">
              <T>Comment:</T>
            </label>
            <Input
              id="db-table-comment"
              className={styles.fill}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        )}
        {(showGrants || showProperties) && (
          <Tabs
            variant="compact"
            aria-label={tx("Table properties")}
            activeId={tab}
            onSelect={(t) => setTab(t as typeof tab)}
            items={[
              { id: "columns", label: tx("Columns") },
              ...(showProperties ? [{ id: "properties", label: tx("Properties") }] : []),
              ...(showGrants ? [{ id: "grants", label: tx("Grants") }] : []),
            ]}
          />
        )}
        {showGrants && tab === "grants" ? (
          <GrantsPanel id={id} schema={schema} table={table} />
        ) : showProperties && tab === "properties" ? (
          <PropertiesPanel
            driver={driver}
            details={details}
            value={properties}
            onChange={(p) => setProperties((v) => ({ ...v, ...p }))}
          />
        ) : (
          <div className={styles.modifyMain}>
            <div className={styles.modifyColumns}>
              <div className={styles.modifyToolbar}>
                <IconButton icon="plus" title="Add Column" size="small" onClick={add} />
                {support.uniqueKey && (
                  <IconButton icon="db-key" title="Add Unique Key" size="small" onClick={() => addIndex("unique")} />
                )}
                {support.index && (
                  <IconButton icon="db-index" title="Add Index" size="small" onClick={() => addIndex("index")} />
                )}
                <IconButton
                  icon="minus"
                  title={
                    currentIndex
                      ? currentIndex.dropped
                        ? currentIndex.kind === "unique"
                          ? "Keep Key"
                          : "Keep Index"
                        : currentIndex.kind === "unique"
                          ? "Drop Key"
                          : "Drop Index"
                      : current?.dropped
                        ? "Keep Column"
                        : "Drop Column"
                  }
                  size="small"
                  disabled={!(current || (currentIndex && !indexLocked))}
                  onClick={remove}
                />
                <SearchField
                  variant="bare"
                  className={styles.modifyFilter}
                  value={filter}
                  onChange={setFilter}
                  placeholder="Filter by name or type"
                  aria-label="Filter columns"
                />
              </div>
              <div role="listbox" aria-label={tx("Columns")} className={styles.modifyList}>
                <div role="group" aria-label={tx("Columns")}>
                  {groupHeader("columns", "Columns", shownColumns.length)}
                  {!collapsed.has("columns") &&
                    shownColumns.map((c) => (
                      <div
                        key={c.key}
                        role="option"
                        aria-selected={selected?.group === "column" && c.key === selected.key}
                        tabIndex={-1}
                        className={styles.modifyItem}
                        data-dropped={c.dropped || undefined}
                        onMouseDown={() => setSelected({ group: "column", key: c.key })}
                      >
                        <Icon name={c.primaryKey ? "db-column-key" : "db-column"} size={16} />
                        <span className={styles.nodeLabel}>{c.name || "<unnamed>"}</span>
                        <span className={styles.treeType}>{c.dataType}</span>
                      </div>
                    ))}
                </div>
                {groups.map((g) => (
                  <div key={g.id} role="group" aria-label={tx(g.label)}>
                    {groupHeader(g.id, g.label, g.rows.length)}
                    {!collapsed.has(g.id) &&
                      g.rows.map((r) => (
                        <div
                          key={r.key}
                          role="option"
                          aria-selected={!!r.draft && selected?.group === "index" && r.draft.key === selected.key}
                          aria-disabled={!r.draft || undefined}
                          tabIndex={r.draft ? -1 : undefined}
                          className={styles.modifyItem}
                          data-dropped={r.draft?.dropped || undefined}
                          onMouseDown={() => {
                            const d = r.draft;
                            if (d) setSelected({ group: "index", key: d.key });
                          }}
                        >
                          <Icon name={g.icon} size={16} />
                          <span className={styles.nodeLabel}>{r.name}</span>
                          <span className={styles.treeType}>{r.detail}</span>
                        </div>
                      ))}
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
                  {driver !== "clickhouse" && (
                    <>
                      <span />
                      <Checkbox
                        checked={current.notNull}
                        disabled={current.dropped || locked}
                        onChange={(notNull) => patch({ notNull })}
                        label="Not null"
                      />
                    </>
                  )}
                  {(table ? support.primaryKey : driver !== "clickhouse") && (
                    <>
                      <span />
                      <Checkbox
                        checked={current.primaryKey}
                        disabled={current.dropped || !primaryKeyEditable}
                        // A primary key column is NOT NULL.
                        onChange={(primaryKey) => patch(primaryKey ? { primaryKey, notNull: true } : { primaryKey })}
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
                  {comments && (
                    <>
                      <label className={styles.formLabel} htmlFor="db-col-comment">
                        <T>Column comment</T>
                      </label>
                      <Input
                        id="db-col-comment"
                        value={current.comment}
                        disabled={current.dropped || locked}
                        onChange={(e) => patch({ comment: e.target.value })}
                      />
                    </>
                  )}
                  {locked && (
                    <>
                      <span />
                      <span className={styles.formHint}>
                        <T>SQLite can rename or drop an existing column, not change its type, NOT NULL or default.</T>
                      </span>
                    </>
                  )}
                </>
              ) : currentIndex ? (
                <>
                  <label className={styles.formLabel} htmlFor="db-key-name">
                    <T>Name</T>
                  </label>
                  <Input
                    id="db-key-name"
                    value={currentIndex.name}
                    disabled={indexFixed}
                    onChange={(e) => patchIndex({ name: e.target.value })}
                  />
                  <span className={styles.formLabel}>
                    <T>Columns</T>
                  </span>
                  <div role="group" aria-label={tx("Key columns")} className={styles.modifyKeyColumns}>
                    {currentIndex.original
                      ? currentIndex.original.columns.map((n) => (
                          <Checkbox key={n} checked disabled onChange={() => {}} label={<span>{n}</span>} />
                        ))
                      : liveColumns.map((c) => (
                          <Checkbox
                            key={c.key}
                            checked={currentIndex.columnKeys.includes(c.key)}
                            disabled={indexFixed}
                            // Checked in the order the key lists them.
                            onChange={(on) =>
                              patchIndex({
                                columnKeys: on
                                  ? [...currentIndex.columnKeys, c.key]
                                  : currentIndex.columnKeys.filter((k) => k !== c.key),
                              })
                            }
                            label={<span>{c.name}</span>}
                          />
                        ))}
                  </div>
                  {currentIndex.kind === "index" && (
                    <>
                      <span />
                      <Checkbox
                        checked={currentIndex.unique}
                        disabled={indexFixed}
                        onChange={(unique) => patchIndex({ unique })}
                        label="Unique"
                      />
                    </>
                  )}
                  {indexLocked && (
                    <>
                      <span />
                      <span className={styles.formHint}>
                        <T>SQLite cannot drop the index of a primary key or unique constraint.</T>
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
        )}
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

const PERSISTENCE: Record<DbPersistence, string> = {
  permanent: "Logged",
  unlogged: "Unlogged",
  temporary: "Temporary",
};

/**
 * The Modify Table dialog's Properties tab: the owner, tablespace, storage options and
 * persistence the engine reports (editable per `propertySupport`), its access method and partition key read-only.
 */
function PropertiesPanel({
  driver,
  details,
  value,
  onChange,
}: {
  driver: DbDriver;
  details: DbTableDetails | undefined;
  value: TableProperties;
  onChange: (p: Partial<TableProperties>) => void;
}) {
  const support = propertySupport(driver);
  const reported = (v: unknown) => v !== undefined && v !== null;
  const original = details?.persistence;
  // A temporary table can't be made permanent, nor a permanent one temporary.
  const persistence: DbPersistence[] = original === "temporary" ? ["temporary"] : ["permanent", "unlogged"];
  return (
    <div className={styles.propertiesPanel}>
      {reported(details?.owner) && (
        <>
          <label className={styles.formLabel} htmlFor="db-table-owner">
            <T>Owner</T>
          </label>
          <Input
            id="db-table-owner"
            value={value.owner}
            disabled={!support.owner}
            onChange={(e) => onChange({ owner: e.target.value })}
          />
        </>
      )}
      {reported(details?.tablespace) && (
        <>
          <label className={styles.formLabel} htmlFor="db-table-tablespace">
            <T>Tablespace</T>
          </label>
          <Input
            id="db-table-tablespace"
            value={value.tablespace}
            disabled={!support.tablespace}
            onChange={(e) => onChange({ tablespace: e.target.value })}
          />
        </>
      )}
      {reported(details?.persistence) && (
        <>
          <label className={styles.formLabel} htmlFor="db-table-persistence">
            <T>Persistence</T>
          </label>
          <Select
            id="db-table-persistence"
            value={value.persistence}
            options={persistence.map((p) => ({ value: p, label: PERSISTENCE[p] }))}
            disabled={!support.persistence || original === "temporary"}
            onChange={(p) => onChange({ persistence: p })}
          />
        </>
      )}
      {reported(details?.storageOptions) && (
        <>
          <label className={styles.formLabel} htmlFor="db-table-options">
            <T>Storage options</T>
          </label>
          <Input
            id="db-table-options"
            mono
            placeholder="fillfactor=70, autovacuum_enabled=false"
            value={value.storageOptions}
            disabled={!support.storageOptions}
            onChange={(e) => onChange({ storageOptions: e.target.value })}
          />
        </>
      )}
      {reported(details?.accessMethod) && (
        <>
          <label className={styles.formLabel} htmlFor="db-table-access-method">
            <T>Access method</T>
          </label>
          <Input id="db-table-access-method" mono value={details?.accessMethod ?? ""} readOnly disabled />
        </>
      )}
      {reported(details?.partitioning) && (
        <>
          <label className={styles.formLabel} htmlFor="db-table-partitioning">
            <T>Partitioning</T>
          </label>
          <Input id="db-table-partitioning" mono value={details?.partitioning ?? ""} readOnly disabled />
        </>
      )}
    </div>
  );
}

type GrantsState =
  | { status: "loading" }
  | { status: "ok"; grants: DbTableGrant[] }
  | { status: "error"; message: string };

/** The Modify Table dialog's Grants tab: who holds which privilege on `table`, read-only. */
function GrantsPanel({ id, schema, table }: { id: string; schema: string; table: string }) {
  const [state, setState] = useState<GrantsState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    loadGrants(id, schema, table).then(
      (grants) => live && setState({ status: "ok", grants }),
      (e: unknown) => live && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [id, schema, table]);
  if (state.status !== "ok")
    return (
      <div className={styles.grantsPanel}>
        <span className={styles.formHint}>{state.status === "error" ? state.message : tx("Loading…")}</span>
      </div>
    );
  const { privileges, rows } = grantMatrix(state.grants);
  if (!rows.length)
    return (
      <div className={styles.grantsPanel}>
        <span className={styles.formHint}>
          <T>No privileges are granted on this table.</T>
        </span>
      </div>
    );
  return (
    <div className={styles.grantsPanel}>
      <div className={styles.grantsScroll}>
        <table className={styles.grantsTable} aria-label={tx("Grants")}>
          <thead>
            <tr>
              <th>
                <T>Grantee</T>
              </th>
              <th>
                <T>Grantor</T>
              </th>
              {privileges.map((p) => (
                <th key={p} className={styles.grantsFlag}>
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.grantee}\u0000${r.grantor ?? ""}`}>
                <td>{r.grantee}</td>
                <td className={r.grantor ? undefined : styles.grantsNone}>{r.grantor ?? "—"}</td>
                {privileges.map((p) => {
                  const grantable = r.privileges.get(p);
                  return (
                    <td key={p} className={styles.grantsFlag}>
                      {grantable !== undefined && (
                        <span
                          className={styles.grantsMark}
                          aria-label={grantable ? tx("Granted with grant option") : tx("Granted")}
                          {...tooltipAttrs(grantable ? tx("Granted with grant option") : undefined)}
                        >
                          <Icon name="check" size={16} />
                          {grantable && <span className={styles.grantsOption}>*</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className={styles.formHint}>
        <T>* With grant option: the grantee may grant the privilege to others.</T>
      </span>
    </div>
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
    const name = s.name ?? (s.driver === "jdbc" ? undefined : `${s.database || s.user || "db"}@${s.host}`);
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
            : "postgresql://, mysql://, mariadb://, redshift://, tidb://…, jdbc:…, sqlite:path, jdbc:duckdb:path"}
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
    case "package":
      rows.push(["Schema", node.schema], ["Package", node.package.name]);
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

function SourceFolderDialog({ folder, sources = [] }: { folder: DbSourceFolder | null; sources?: string[] }) {
  const [name, setName] = useState(folder?.name ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const saved = folder ? await renameSourceFolder(folder.id, name) : await createSourceFolder(name, sources);
    if (saved) closeDialog();
    else setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={closeDialog}
      title={folder ? tx("Rename Data Source Folder") : tx("New Data Source Folder")}
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: folder ? "Rename" : "Create",
          role: "default",
          disabled: busy || !name.trim(),
          onClick: () => void submit(),
        },
      ]}
    >
      <div className={styles.dialogBody}>
        <label className={styles.formLabelLeft} htmlFor="db-source-folder-name">
          <T>Folder name:</T>
        </label>
        <Input
          id="db-source-folder-name"
          autoFocus
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
        {!folder && sources.length > 0 && (
          <span
            className={styles.formHint}
          >{tx`The ${sources.length} selected data sources will be moved into this folder.`}</span>
        )}
      </div>
    </Dialog>
  );
}

export function ObjectDialogs() {
  const dialog = useDatabase((s) => s.dialog) as DialogState | null;
  if (!dialog) return null;
  switch (dialog.kind) {
    case "rename":
      return <RenameDialog key={`${dialog.id}`} id={dialog.id} object={dialog.object} />;
    case "renameDatabase":
      return (
        <RenameDialog key={`${dialog.id}:${dialog.database}`} id={dialog.id} object={null} database={dialog.database} />
      );
    case "sourceFolder":
      return <SourceFolderDialog key={dialog.folder?.id ?? "new"} folder={dialog.folder} sources={dialog.sources} />;
    case "drop":
      return <DropDialog id={dialog.id} object={dialog.object} />;
    case "truncate":
      return <TruncateDialog id={dialog.id} schema={dialog.schema} table={dialog.table} />;
    case "createDatabase":
      return <CreateDialog id={dialog.id} what="database" />;
    case "createSchema":
      return <CreateDialog id={dialog.id} what="schema" />;
    case "dropDatabase":
      return <DropDatabaseDialog id={dialog.id} database={dialog.database} />;
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
