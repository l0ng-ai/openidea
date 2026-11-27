/**
 * SQL that the Database tree's object actions run or paste (IDEA: Rename,
 * Drop, Truncate, SQL Scripts › …, Modify Table, Copy Reference), per dialect.
 * Pure functions.
 */
import type { DbColumnInfo, DbDriver, DbIndexInfo, DbTableGrant } from "@/platform/ipc";
import { isReserved } from "./sql/dialect";

export function quoteIdent(driver: DbDriver, name: string): string {
  if (driver === "clickhouse") return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (driver === "sqlServer") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes only when needed: lower-case (PostgreSQL) / UPPER-case (Oracle, Snowflake) / plain words stay bare, like IDEA's SQL. */
export function ident(driver: DbDriver, name: string): string {
  const plain =
    driver === "postgres"
      ? /^[a-z_][a-z0-9_$]*$/
      : // Oracle and Snowflake fold unquoted names to upper case.
        driver === "oracle" || driver === "snowflake"
        ? /^[A-Z_][A-Z0-9_$]*$/
        : driver === "clickhouse"
          ? /^[A-Za-z_][A-Za-z0-9_]*$/
          : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  const reserved = RESERVED.has(name.toUpperCase()) || (driver === "snowflake" && isReserved(name, driver));
  return plain.test(name) && !reserved ? name : quoteIdent(driver, name);
}

const RESERVED = new Set(
  (
    "ALL AND AS ASC BETWEEN BY CASE CHECK COLUMN CONSTRAINT CREATE CROSS DEFAULT DELETE DESC DISTINCT DROP " +
    "ELSE END EXISTS FOREIGN FROM FULL GROUP HAVING IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT " +
    "NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE THEN TO UNION UNIQUE UPDATE USER " +
    "USING VALUES VIEW WHEN WHERE WITH"
  ).split(" "),
);

/** `schema.name`; SQLite's `main` and an empty schema are left out. */
export function qualifiedName(driver: DbDriver, schema: string, name: string): string {
  if (!schema || (driver === "sqlite" && schema === "main")) return ident(driver, name);
  return `${ident(driver, schema)}.${ident(driver, name)}`;
}

export type DbObjectKind =
  | "table"
  | "view"
  | "materializedView"
  | "column"
  | "index"
  | "schema"
  | "function"
  | "procedure"
  | "package"
  | "trigger"
  | "sequence";

/** A schema object of a data source, as the tree actions see it. */
export interface DbObjectRef {
  kind: DbObjectKind;
  schema: string;
  /** Table / view / index / schema / routine / trigger / sequence name; the column's table for a column. */
  name: string;
  /** Column name (kind `column`). */
  column?: string;
  /** Table of an index or trigger (MySQL drops an index `ON` its table, PostgreSQL a trigger). */
  table?: string;
  /** Argument types of a PostgreSQL routine (tells overloads apart). */
  arguments?: string;
}

/** IDEA's Copy Reference: the object's qualified name. */
export function reference(driver: DbDriver, o: DbObjectRef): string {
  if (o.kind === "schema") return ident(driver, o.name);
  const q = qualifiedName(driver, o.schema, o.name);
  return o.kind === "column" && o.column ? `${q}.${ident(driver, o.column)}` : q;
}

/** Snowflake has no indexes or triggers. */
const exists = (driver: DbDriver, o: DbObjectRef) =>
  driver !== "snowflake" || (o.kind !== "index" && o.kind !== "trigger");

export const canRename = (driver: DbDriver, o: DbObjectRef) =>
  driver !== "jdbc" &&
  (o.kind === "table" ||
    o.kind === "column" ||
    (o.kind === "view" && driver !== "sqlite") ||
    (o.kind === "index" && driver === "postgres") ||
    (o.kind === "schema" && (driver === "postgres" || driver === "snowflake")));

/** The statement renaming `o` to `to`. */
export function renameSql(driver: DbDriver, o: DbObjectRef, to: string): string {
  const q = qualifiedName(driver, o.schema, o.name);
  switch (o.kind) {
    case "schema":
      return `alter schema ${ident(driver, o.name)} rename to ${ident(driver, to)};`;
    case "column":
      return `alter table ${q} rename column ${ident(driver, o.column ?? "")} to ${ident(driver, to)};`;
    case "index":
      return `alter index ${q} rename to ${ident(driver, to)};`;
    case "view":
      // Snowflake resolves an unqualified new name in the session's schema: a rename could move the object.
      if (driver === "snowflake") return `alter view ${q} rename to ${qualifiedName(driver, o.schema, to)};`;
      if (driver === "postgres") return `alter view ${q} rename to ${ident(driver, to)};`;
      if (driver === "oracle") return `rename ${q} to ${ident(driver, to)};`;
      return `rename table ${q} to ${qualifiedName(driver, o.schema, to)};`;
    default:
      if (driver === "mysql" || driver === "clickhouse")
        return `rename table ${q} to ${qualifiedName(driver, o.schema, to)};`;
      if (driver === "snowflake") return `alter table ${q} rename to ${qualifiedName(driver, o.schema, to)};`;
      return `alter table ${q} rename to ${ident(driver, to)};`;
  }
}

export interface DropOptions {
  ifExists: boolean;
  /** PostgreSQL `CASCADE`. */
  cascade: boolean;
}

export const canDrop = (driver: DbDriver, o: DbObjectRef) =>
  driver !== "jdbc" &&
  (driver === "clickhouse"
    ? ["table", "view", "materializedView", "column", "schema"].includes(o.kind)
    : !(o.kind === "schema" && driver === "sqlite") && exists(driver, o));

export const canModifyTable = (driver: DbDriver) => driver !== "clickhouse" && driver !== "jdbc";

/** IDEA's Confirm Drop preview. */
export function dropSql(driver: DbDriver, o: DbObjectRef, opts: DropOptions): string {
  const ifExists = opts.ifExists ? "if exists " : "";
  const cascade = opts.cascade && driver === "postgres" ? " cascade" : "";
  switch (o.kind) {
    case "column":
      return `alter table ${qualifiedName(driver, o.schema, o.name)} drop column ${ifExists && driver === "postgres" ? ifExists : ""}${ident(driver, o.column ?? "")}${cascade};`;
    case "index":
      if (driver === "mysql")
        return `drop index ${ident(driver, o.name)} on ${qualifiedName(driver, o.schema, o.table ?? "")};`;
      // SQL Server names an index within its table.
      if (driver === "sqlServer")
        return `drop index ${ifExists}${ident(driver, o.name)} on ${qualifiedName(driver, o.schema, o.table ?? "")};`;
      // Oracle's DROP INDEX takes no IF EXISTS.
      if (driver === "oracle") return `drop index ${qualifiedName(driver, o.schema, o.name)};`;
      return `drop index ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
    case "schema":
      if (driver === "oracle") return `drop user ${ident(driver, o.name)} cascade;`;
      return `drop ${driver === "mysql" || driver === "clickhouse" ? "database" : "schema"} ${ifExists}${ident(driver, o.name)}${cascade};`;
    case "materializedView":
      if (driver === "clickhouse") return `drop table ${ifExists}${qualifiedName(driver, o.schema, o.name)};`;
      return `drop materialized view ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
    case "function":
    case "procedure": {
      // Snowflake, like PostgreSQL, identifies a routine by its argument types.
      const args = driver === "postgres" || driver === "snowflake" ? `(${o.arguments ?? ""})` : "";
      return `drop ${o.kind} ${ifExists}${qualifiedName(driver, o.schema, o.name)}${args}${cascade};`;
    }
    // Oracle has no DROP PACKAGE IF EXISTS before 23ai, and dropping the
    // specification drops the body with it.
    case "package":
      return `drop package ${qualifiedName(driver, o.schema, o.name)};`;
    case "trigger":
      if (driver === "postgres")
        return `drop trigger ${ifExists}${ident(driver, o.name)} on ${qualifiedName(driver, o.schema, o.table ?? "")}${cascade};`;
      return `drop trigger ${ifExists}${qualifiedName(driver, o.schema, o.name)};`;
    default:
      return `drop ${o.kind} ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
  }
}

/** Object Actions › Truncate (SQLite has no TRUNCATE: `delete from`). */
export function truncateSql(
  driver: DbDriver,
  schema: string,
  table: string,
  opts: { restartIdentity: boolean; cascade: boolean },
): string {
  const q = qualifiedName(driver, schema, table);
  if (driver === "sqlite") return `delete from ${q};`;
  if (
    driver === "mysql" ||
    driver === "sqlServer" ||
    driver === "clickhouse" ||
    driver === "oracle" ||
    driver === "snowflake"
  )
    return `truncate table ${q};`;
  return `truncate table ${q}${opts.restartIdentity ? " restart identity" : ""}${opts.cascade ? " cascade" : ""};`;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Options of New › Database / New › Schema; an empty or absent one is left to the server. */
export interface CreateOptions {
  owner?: string;
  template?: string;
  encoding?: string;
  tablespace?: string;
  charset?: string;
  collation?: string;
}

/** New › Database (PostgreSQL, SQL Server). */
export function createDatabaseSql(driver: DbDriver, name: string, opts: CreateOptions): string {
  const clauses: string[] = [];
  const add = (keyword: string, value: string | undefined, quote = (v: string) => ident(driver, v)) => {
    if (value?.trim()) clauses.push(`${keyword} ${quote(value.trim())}`);
  };
  if (driver === "postgres") {
    add("owner", opts.owner);
    add("template", opts.template);
    add("encoding", opts.encoding, literal);
    add("tablespace", opts.tablespace);
  } else if (driver === "sqlServer") {
    add("collate", opts.collation, (v) => v);
  }
  return `create database ${ident(driver, name)}${clauses.map((c) => ` ${c}`).join("")};`;
}

/** The database the server copies for New › Database: the chosen template on PostgreSQL, `model` on SQL Server. */
export function templateOf(driver: DbDriver, opts: CreateOptions): string {
  return driver === "sqlServer" ? "model" : opts.template?.trim() || "template1";
}

/** New › Schema; on MySQL a schema is a database, with a character set and collation instead of an owner. */
export function createSchemaSql(driver: DbDriver, name: string, opts: CreateOptions): string {
  if (driver === "mysql") {
    const charset = opts.charset?.trim() ? ` character set ${opts.charset.trim()}` : "";
    const collation = opts.collation?.trim() ? ` collate ${opts.collation.trim()}` : "";
    return `create database ${ident(driver, name)}${charset}${collation};`;
  }
  const owner = opts.owner?.trim() ? ` authorization ${ident(driver, opts.owner.trim())}` : "";
  return `create schema ${ident(driver, name)}${owner};`;
}

/**
 * Drop on a database node. `force` ends the sessions of other clients first:
 * `with (force)` on PostgreSQL 13+, single-user mode on SQL Server.
 */
export function dropDatabaseSql(driver: DbDriver, name: string, force: boolean): string {
  const db = ident(driver, name);
  // One batch: the session that sets single-user mode is the single user, so it must drop too.
  if (driver === "sqlServer" && force)
    return `alter database ${db} set single_user with rollback immediate;\ndrop database ${db};`;
  return `drop database ${db}${force && driver === "postgres" ? " with (force)" : ""};`;
}

/** The statement renaming database `name` of a server to `to` (PostgreSQL, SQL Server). */
export function renameDatabaseSql(driver: DbDriver, name: string, to: string): string {
  if (driver === "sqlServer") return `alter database ${ident(driver, name)} modify name = ${ident(driver, to)};`;
  return `alter database ${ident(driver, name)} rename to ${ident(driver, to)};`;
}

export type ScriptKind = "selectAll" | "selectFirst" | "insert" | "update" | "delete";

export const SCRIPT_LABELS: Record<ScriptKind, string> = {
  selectAll: "Select all rows from a table",
  selectFirst: "Select first N rows from a table",
  insert: "Insert rows into a table",
  update: "Update values in a table",
  delete: "Delete rows from a table",
};

/** SQL Scripts › … templates (IDEA's live templates `sel`, `selc`, `ins`, `upd`, `del`). */
export function scriptSql(
  driver: DbDriver,
  kind: ScriptKind,
  schema: string,
  table: string,
  columns: readonly DbColumnInfo[],
): string {
  const q = qualifiedName(driver, schema, table);
  const names = columns.map((c) => ident(driver, c.name));
  const keys = columns.filter((c) => c.primaryKey).map((c) => ident(driver, c.name));
  const where = (keys.length ? keys : names.slice(0, 1)).map((k) => `${k} = ?`).join(" and ") || "1 = 0";
  switch (kind) {
    case "selectAll":
      return `select *\nfrom ${q};\n`;
    case "selectFirst":
      return driver === "oracle"
        ? `select *\nfrom ${q}\nfetch first 10 rows only;\n`
        : `select *\nfrom ${q}\nlimit 10;\n`;
    case "insert":
      return `insert into ${q} (${names.join(", ")})\nvalues (${names.map(() => "?").join(", ")});\n`;
    case "update": {
      const set = columns.filter((c) => !c.primaryKey).map((c) => `${ident(driver, c.name)} = ?`);
      if (driver === "clickhouse") {
        if (!set.length) throw new Error("ClickHouse sorting key columns cannot be updated.");
        return `alter table ${q}\nupdate ${set.join(",\n       ")}\nwhere 1 = 0;\n`;
      }
      return `update ${q}\nset ${(set.length ? set : names.map((n) => `${n} = ?`)).join(",\n    ")}\nwhere ${where};\n`;
    }
    case "delete":
      if (driver === "clickhouse") return `alter table ${q}\ndelete\nwhere 1 = 0;\n`;
      return `delete\nfrom ${q}\nwhere ${where};\n`;
  }
}

// ---- Modify Table ------------------------------------------------------------

/** A column row of the Modify Table dialog; `original` is the column it started as (absent: new). */
export interface ColumnDraft {
  key: number;
  original: DbColumnInfo | null;
  name: string;
  dataType: string;
  notNull: boolean;
  /** SQL expression; empty for none. */
  default: string;
  primaryKey: boolean;
  /** Empty for none. */
  comment: string;
  dropped: boolean;
}

export function draftOf(c: DbColumnInfo, key: number): ColumnDraft {
  return {
    key,
    original: c,
    name: c.name,
    dataType: c.dataType,
    notNull: !c.nullable,
    default: c.default ?? "",
    primaryKey: c.primaryKey,
    comment: c.comment ?? "",
    dropped: false,
  };
}

function columnDefinition(driver: DbDriver, c: ColumnDraft): string {
  const fallback =
    driver === "clickhouse"
      ? "String"
      : driver === "sqlite"
        ? "TEXT"
        : driver === "oracle"
          ? "VARCHAR2(255)"
          : driver === "snowflake"
            ? "VARCHAR"
            : "text";
  let s = `${ident(driver, c.name)} ${c.dataType.trim() || fallback}`;
  if (c.default.trim()) s += ` default ${c.default.trim()}`;
  if (c.notNull && driver !== "clickhouse") s += " not null";
  // MySQL keeps a column's comment in its definition: `change column` without it drops the comment.
  if (driver === "mysql" && c.comment) s += ` comment ${commentLiteral(driver, c.comment)}`;
  return s;
}

/** Engines whose table and column comments the Modify Table dialog reads and edits. */
export function commentsSupported(driver: DbDriver): boolean {
  return driver === "postgres" || driver === "mysql" || driver === "oracle" || driver === "snowflake";
}

/** A comment as a string literal (MySQL and Snowflake read backslash escapes). */
function commentLiteral(driver: DbDriver, text: string): string {
  const escaped = driver === "mysql" || driver === "snowflake" ? text.replace(/\\/g, "\\\\") : text;
  return `'${escaped.replace(/'/g, "''")}'`;
}

/** A table comment as the dialog started (`original`) and as edited. */
export interface CommentEdit {
  original: string;
  value: string;
}

/**
 * The statements setting the table's comment and its columns' (`comment on …` where the
 * engine has it; MySQL's column comments are part of the definition, see `columnDefinition`).
 * Columns are named as they end up; the table as it is (a rename comes after).
 */
function commentSql(
  driver: DbDriver,
  schema: string,
  table: string,
  columns: readonly ColumnDraft[],
  comment: CommentEdit | undefined,
): string[] {
  if (!commentsSupported(driver)) return [];
  const q = qualifiedName(driver, schema, table);
  const out: string[] = [];
  if (comment && comment.value !== comment.original) {
    const v = comment.value;
    if (driver === "mysql") out.push(`alter table ${q} comment = ${commentLiteral(driver, v)};`);
    else if (!v && driver === "snowflake") out.push(`alter table ${q} unset comment;`);
    else out.push(`comment on table ${q} is ${v || driver !== "postgres" ? commentLiteral(driver, v) : "null"};`);
  }
  if (driver === "mysql") return out;
  for (const c of columns) {
    const name = c.name.trim() || c.original?.name;
    if (c.dropped || !name || c.comment === (c.original?.comment ?? "")) continue;
    const col = ident(driver, name);
    if (!c.comment && driver === "snowflake") out.push(`alter table ${q} alter column ${col} unset comment;`);
    else
      out.push(
        `comment on column ${q}.${col} is ${c.comment || driver !== "postgres" ? commentLiteral(driver, c.comment) : "null"};`,
      );
  }
  return out;
}

/** `create table` for New › Table. */
export function createTableSql(
  driver: DbDriver,
  schema: string,
  name: string,
  columns: readonly ColumnDraft[],
  comment = "",
): string {
  const live = columns.filter((c) => !c.dropped && c.name.trim());
  const keys = live.filter((c) => c.primaryKey).map((c) => ident(driver, c.name));
  const items = live.map((c) => `    ${columnDefinition(driver, c)}`);
  if (keys.length && driver !== "clickhouse") items.push(`    primary key (${keys.join(", ")})`);
  const options =
    driver === "clickhouse"
      ? "\nengine = MergeTree\norder by tuple()"
      : driver === "mysql" && comment
        ? `\ncomment = ${commentLiteral(driver, comment)}`
        : "";
  return `create table ${qualifiedName(driver, schema, name)}\n(\n${items.join(",\n")}\n)${options};\n`;
}

/** The `comment on` statements following New › Table's `create table` (MySQL takes them inline). */
export function createTableCommentSql(
  driver: DbDriver,
  schema: string,
  name: string,
  columns: readonly ColumnDraft[],
  comment: string,
): string[] {
  if (driver === "mysql") return [];
  const live = columns.filter((c) => !c.dropped && c.name.trim());
  return commentSql(driver, schema, name, live, { original: "", value: comment });
}

/** Whether `alterTableSql` can express changing column `c` (SQLite only renames, adds and drops). */
export function canAlterColumn(driver: DbDriver, c: ColumnDraft): boolean {
  return driver !== "sqlite" || !c.original;
}

// ---- Keys and indexes ----------------------------------------------------------

/** What Modify Table adds, changes and drops besides columns, per engine. */
export interface KeySupport {
  /** The primary key of an existing table (a new table's is part of `create table`). */
  primaryKey: boolean;
  /** Unique constraints (the Keys group). */
  uniqueKey: boolean;
  /** Indexes, unique or not. */
  index: boolean;
}

export function keySupport(driver: DbDriver): KeySupport {
  switch (driver) {
    case "postgres":
    case "mysql":
    case "sqlServer":
    case "oracle":
      return { primaryKey: true, uniqueKey: true, index: true };
    // SQLite's ALTER TABLE adds and drops no constraint (that takes rebuilding the table); a unique index does a unique key's work.
    case "sqlite":
      return { primaryKey: false, uniqueKey: false, index: true };
    // Snowflake has no indexes, and its unique keys (not enforced) are not read back.
    case "snowflake":
      return { primaryKey: true, uniqueKey: false, index: false };
    default:
      return { primaryKey: false, uniqueKey: false, index: false };
  }
}

/** Engines that drop a primary key by its constraint name rather than with `drop primary key`. */
const dropsKeyByName = (driver: DbDriver) => driver === "postgres" || driver === "sqlServer";

/**
 * Whether Modify Table can change the primary key of a table whose primary-key index is
 * `pkIndex`: PostgreSQL and SQL Server drop the key by its name, which the index carries.
 */
export function canChangePrimaryKey(driver: DbDriver, columns: readonly ColumnDraft[], pkIndex?: string): boolean {
  if (!keySupport(driver).primaryKey) return false;
  return !dropsKeyByName(driver) || !!pkIndex || !columns.some((c) => c.original?.primaryKey);
}

/**
 * A unique key or an index of the Modify Table dialog; `original` is the one it started as
 * (absent: new). An existing one is kept or dropped, not edited: the catalog doesn't read
 * everything that defines it (predicates, expressions, included columns), so it can't be rebuilt.
 */
export interface IndexDraft {
  key: number;
  /** `unique`: a unique constraint (Keys); `index`: an index (Indexes). */
  kind: "unique" | "index";
  original: DbIndexInfo | null;
  name: string;
  columns: string[];
  /** A unique index (kind `index`; a unique key always is). */
  unique: boolean;
  dropped: boolean;
}

/** The draft of an existing index; `null` for the primary key's, which follows the columns' Primary key flags. */
export function indexDraftOf(i: DbIndexInfo, key: number): IndexDraft | null {
  if (i.key === "primary") return null;
  const kind = i.key === "unique" ? "unique" : "index";
  return { key, kind, original: i, name: i.name, columns: [...i.columns], unique: i.unique, dropped: false };
}

/** Whether Modify Table can drop the existing key or index `d` (SQLite's constraint indexes stay). */
export function canAlterIndex(driver: DbDriver, d: IndexDraft): boolean {
  const s = keySupport(driver);
  return d.kind === "unique" ? s.uniqueKey : s.index;
}

/** A name for a new key or index of `table`, as DataGrip names them (`orders_pk`, `orders_name_uindex`). */
export function keyName(driver: DbDriver, table: string, suffix: string): string {
  const n = `${table}_${suffix}`;
  // Oracle and Snowflake fold unquoted names to upper case.
  return driver === "oracle" || driver === "snowflake" ? n.toUpperCase() : n;
}

const columnList = (driver: DbDriver, names: readonly string[]) => names.map((c) => ident(driver, c)).join(", ");

/** `create [unique] index` on `table` (Modify Table, Compare Structure's migration). */
export function createIndexSql(
  driver: DbDriver,
  schema: string,
  table: string,
  i: Pick<DbIndexInfo, "name" | "unique" | "columns">,
): string {
  const unique = i.unique ? "unique " : "";
  const cols = columnList(driver, i.columns);
  // SQLite and Oracle put the index in a schema by its name (SQLite's table is then unqualified);
  // PostgreSQL, MySQL and SQL Server create it in the table's.
  if (driver === "sqlite")
    return `create ${unique}index ${qualifiedName(driver, schema, i.name)} on ${ident(driver, table)} (${cols});`;
  const name = driver === "oracle" ? qualifiedName(driver, schema, i.name) : ident(driver, i.name);
  return `create ${unique}index ${name} on ${qualifiedName(driver, schema, table)} (${cols});`;
}

/** `drop index` of `table`'s index `name`. */
export function dropIndexSql(driver: DbDriver, schema: string, table: string, name: string): string {
  return dropSql(driver, { kind: "index", schema, name, table }, { ifExists: false, cascade: false });
}

function primaryKeyChanged(columns: readonly ColumnDraft[]): boolean {
  const before = columns.filter((c) => c.original?.primaryKey).map((c) => c.key);
  const after = columns.filter((c) => c.primaryKey && !c.dropped && c.name.trim()).map((c) => c.key);
  return before.length !== after.length || before.some((k) => !after.includes(k));
}

/** The keys and indexes Modify Table edits: the primary key's constraint name, and the unique keys and indexes. */
export interface KeyEdits {
  /** The primary key's index, named as its constraint (PostgreSQL, SQL Server drop it by that name). */
  primaryKeyName?: string;
  indexes: readonly IndexDraft[];
}

/**
 * The statements dropping (`drops`, run before the column changes) and adding (`adds`, run
 * after them, with the columns' new names) the primary key, unique keys and indexes of `table`.
 * A changed primary key is dropped and added again.
 */
function keySql(
  driver: DbDriver,
  schema: string,
  table: string,
  columns: readonly ColumnDraft[],
  keys: KeyEdits,
): { drops: string[]; adds: string[] } {
  const support = keySupport(driver);
  const q = qualifiedName(driver, schema, table);
  const drops: string[] = [];
  const adds: string[] = [];
  const pk = columns.filter((c) => c.primaryKey && !c.dropped && c.name.trim()).map((c) => c.name.trim());
  if (canChangePrimaryKey(driver, columns, keys.primaryKeyName) && primaryKeyChanged(columns)) {
    if (columns.some((c) => c.original?.primaryKey))
      drops.push(
        dropsKeyByName(driver)
          ? `alter table ${q} drop constraint ${ident(driver, keys.primaryKeyName ?? "")};`
          : `alter table ${q} drop primary key;`,
      );
    // MySQL names every primary key PRIMARY.
    if (pk.length)
      adds.push(
        driver === "mysql"
          ? `alter table ${q} add primary key (${columnList(driver, pk)});`
          : `alter table ${q} add constraint ${ident(driver, keyName(driver, table, "pk"))} primary key (${columnList(driver, pk)});`,
      );
  }
  for (const d of keys.indexes) {
    if (d.kind === "unique" ? !support.uniqueKey : !support.index) continue;
    const o = d.original;
    if (o) {
      if (d.dropped)
        drops.push(
          d.kind === "index"
            ? dropIndexSql(driver, schema, table, o.name)
            : // MySQL's unique key is its unique index.
              driver === "mysql"
              ? `alter table ${q} drop index ${ident(driver, o.name)};`
              : `alter table ${q} drop constraint ${ident(driver, o.name)};`,
        );
      continue;
    }
    if (d.dropped || !d.name.trim() || !d.columns.length) continue;
    adds.push(
      d.kind === "index"
        ? createIndexSql(driver, schema, table, { name: d.name.trim(), unique: d.unique, columns: d.columns })
        : `alter table ${q} add constraint ${ident(driver, d.name.trim())} unique (${columnList(driver, d.columns)});`,
    );
  }
  return { drops, adds };
}

/** The unique keys and indexes added with New › Table, after its `create table`. */
export function createTableKeySql(
  driver: DbDriver,
  schema: string,
  name: string,
  indexes: readonly IndexDraft[],
): string[] {
  return keySql(driver, schema, name, [], { indexes: indexes.filter((d) => !d.original) }).adds;
}

/**
 * The statements turning the table `table` into `name` with `columns`
 * (Modify Table): renames, added / dropped columns, and — PostgreSQL / MySQL /
 * Oracle / Snowflake — type, nullability, default and comment changes, and the table's comment;
 * with `keys`, the primary key, unique keys and indexes (see `keySupport`).
 */
export function alterTableSql(
  driver: DbDriver,
  schema: string,
  table: string,
  name: string,
  columns: readonly ColumnDraft[],
  comment?: CommentEdit,
  keys?: KeyEdits,
): string[] {
  if (!canModifyTable(driver)) return [];
  const { drops, adds } = keys ? keySql(driver, schema, table, columns, keys) : { drops: [], adds: [] };
  // Keys and indexes go first: a dropped column may be part of one.
  const out: string[] = [...drops];
  const q = () => qualifiedName(driver, schema, table);
  for (const c of columns) {
    const o = c.original;
    if (!o) {
      if (!c.dropped && c.name.trim()) {
        // Oracle takes the added column's definition in parentheses.
        out.push(
          driver === "oracle"
            ? `alter table ${q()} add (${columnDefinition(driver, c)});`
            : `alter table ${q()} add column ${columnDefinition(driver, c)};`,
        );
      }
      continue;
    }
    if (c.dropped) {
      out.push(`alter table ${q()} drop column ${ident(driver, o.name)};`);
      continue;
    }
    const renamed = c.name.trim() && c.name !== o.name;
    const changed =
      c.dataType.trim() !== o.dataType ||
      c.notNull !== !o.nullable ||
      c.default.trim() !== (o.default ?? "").trim() ||
      (driver === "mysql" && c.comment !== (o.comment ?? ""));
    if (driver === "mysql" && (renamed || changed)) {
      out.push(`alter table ${q()} change column ${ident(driver, o.name)} ${columnDefinition(driver, c)};`);
      continue;
    }
    if (driver === "oracle") {
      const col = ident(driver, o.name);
      if (c.dataType.trim() && c.dataType.trim() !== o.dataType) {
        out.push(`alter table ${q()} modify (${col} ${c.dataType.trim()}${c.notNull ? " not null" : ""});`);
      }
      if (c.notNull !== !o.nullable) {
        out.push(
          c.notNull ? `alter table ${q()} modify (${col} not null);` : `alter table ${q()} modify (${col} null);`,
        );
      }
      if (c.default.trim() !== (o.default ?? "").trim()) {
        out.push(
          c.default.trim()
            ? `alter table ${q()} modify (${col} default ${c.default.trim()});`
            : `alter table ${q()} modify (${col} default null);`,
        );
      }
      if (renamed) out.push(`alter table ${q()} rename column ${col} to ${ident(driver, c.name)};`);
      continue;
    }
    if (renamed) out.push(`alter table ${q()} rename column ${ident(driver, o.name)} to ${ident(driver, c.name)};`);
    if (driver === "snowflake") {
      const col = ident(driver, c.name.trim() || o.name);
      if (c.dataType.trim() && c.dataType.trim() !== o.dataType)
        out.push(`alter table ${q()} alter column ${col} set data type ${c.dataType.trim()};`);
      if (c.notNull !== !o.nullable)
        out.push(`alter table ${q()} alter column ${col} ${c.notNull ? "set" : "drop"} not null;`);
      // An existing column's default can only be dropped.
      if (!c.default.trim() && (o.default ?? "").trim())
        out.push(`alter table ${q()} alter column ${col} drop default;`);
      continue;
    }
    if (driver !== "postgres") continue;
    const col = ident(driver, renamed ? c.name : o.name);
    if (c.dataType.trim() && c.dataType.trim() !== o.dataType)
      out.push(`alter table ${q()} alter column ${col} type ${c.dataType.trim()};`);
    if (c.notNull !== !o.nullable)
      out.push(`alter table ${q()} alter column ${col} ${c.notNull ? "set" : "drop"} not null;`);
    if (c.default.trim() !== (o.default ?? "").trim())
      out.push(
        `alter table ${q()} alter column ${col} ${c.default.trim() ? `set default ${c.default.trim()}` : "drop default"};`,
      );
  }
  out.push(...adds);
  out.push(...commentSql(driver, schema, table, columns, comment));
  // Renamed last: the column statements above name the table as it was.
  if (name.trim() && name.trim() !== table)
    out.push(renameSql(driver, { kind: "table", schema, name: table }, name.trim()));
  return out;
}

// ---- Grants -------------------------------------------------------------------

/** Engines whose table privileges the Modify Table dialog shows (others run no query). */
export function grantsSupported(driver: DbDriver): boolean {
  return driver === "postgres" || driver === "mysql";
}

/** Column order of the Grants table: the SQL standard's table privileges, then the engine's own. */
const PRIVILEGE_ORDER = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
  "INDEX",
  "ALTER",
  "CREATE",
  "DROP",
  "CREATE VIEW",
  "SHOW VIEW",
  "DELETE HISTORY",
];

export interface GrantRow {
  grantee: string;
  grantor: string | null;
  /** Privilege → granted with GRANT OPTION. */
  privileges: Map<string, boolean>;
}

/** One row per grantee and grantor, with the privileges they hold as columns. */
export function grantMatrix(grants: DbTableGrant[]): { privileges: string[]; rows: GrantRow[] } {
  const rows = new Map<string, GrantRow>();
  const seen = new Set<string>();
  for (const g of grants) {
    const key = JSON.stringify([g.grantee, g.grantor]);
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { grantee: g.grantee, grantor: g.grantor, privileges: new Map() }));
    row.privileges.set(g.privilege, (row.privileges.get(g.privilege) ?? false) || g.grantable);
    seen.add(g.privilege);
  }
  const rank = (p: string) => {
    const i = PRIVILEGE_ORDER.indexOf(p);
    return i < 0 ? PRIVILEGE_ORDER.length : i;
  };
  const privileges = [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { privileges, rows: [...rows.values()] };
}
