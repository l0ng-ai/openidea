/**
 * SQL that the Database tree's object actions run or paste (IDEA: Rename,
 * Drop, Truncate, SQL Scripts › …, Modify Table, Copy Reference), per dialect.
 * Pure functions.
 */
import type { DbColumnInfo, DbDriver } from "@/platform/ipc";

export function quoteIdent(driver: DbDriver, name: string): string {
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (driver === "sqlServer") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes only when needed: lower-case (PostgreSQL) / plain words stay bare, like IDEA's generated SQL. */
export function ident(driver: DbDriver, name: string): string {
  const plain = driver === "postgres" ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  return plain.test(name) && !RESERVED.has(name.toUpperCase()) ? name : quoteIdent(driver, name);
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

export const canRename = (driver: DbDriver, o: DbObjectRef) =>
  o.kind === "table" ||
  o.kind === "column" ||
  (o.kind === "view" && driver !== "sqlite") ||
  (o.kind === "index" && driver === "postgres");

/** The statement renaming `o` to `to`. */
export function renameSql(driver: DbDriver, o: DbObjectRef, to: string): string {
  const q = qualifiedName(driver, o.schema, o.name);
  switch (o.kind) {
    case "column":
      return `alter table ${q} rename column ${ident(driver, o.column ?? "")} to ${ident(driver, to)};`;
    case "index":
      return `alter index ${q} rename to ${ident(driver, to)};`;
    case "view":
      if (driver === "postgres") return `alter view ${q} rename to ${ident(driver, to)};`;
      return `rename table ${q} to ${qualifiedName(driver, o.schema, to)};`;
    default:
      if (driver === "mysql") return `rename table ${q} to ${qualifiedName(driver, o.schema, to)};`;
      return `alter table ${q} rename to ${ident(driver, to)};`;
  }
}

export interface DropOptions {
  ifExists: boolean;
  /** PostgreSQL `CASCADE`. */
  cascade: boolean;
}

export const canDrop = (driver: DbDriver, o: DbObjectRef) => !(o.kind === "schema" && driver === "sqlite");

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
      return `drop index ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
    case "schema":
      return `drop ${driver === "mysql" ? "database" : "schema"} ${ifExists}${ident(driver, o.name)}${cascade};`;
    case "materializedView":
      return `drop materialized view ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
    case "function":
    case "procedure": {
      const args = driver === "postgres" ? `(${o.arguments ?? ""})` : "";
      return `drop ${o.kind} ${ifExists}${qualifiedName(driver, o.schema, o.name)}${args}${cascade};`;
    }
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
  if (driver === "mysql" || driver === "sqlServer") return `truncate table ${q};`;
  return `truncate table ${q}${opts.restartIdentity ? " restart identity" : ""}${opts.cascade ? " cascade" : ""};`;
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
      return `select *\nfrom ${q}\nlimit 10;\n`;
    case "insert":
      return `insert into ${q} (${names.join(", ")})\nvalues (${names.map(() => "?").join(", ")});\n`;
    case "update": {
      const set = columns.filter((c) => !c.primaryKey).map((c) => `${ident(driver, c.name)} = ?`);
      return `update ${q}\nset ${(set.length ? set : names.map((n) => `${n} = ?`)).join(",\n    ")}\nwhere ${where};\n`;
    }
    case "delete":
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
    dropped: false,
  };
}

function columnDefinition(driver: DbDriver, c: ColumnDraft): string {
  let s = `${ident(driver, c.name)} ${c.dataType.trim() || (driver === "sqlite" ? "TEXT" : "text")}`;
  if (c.default.trim()) s += ` default ${c.default.trim()}`;
  if (c.notNull) s += " not null";
  return s;
}

/** `create table` for New › Table. */
export function createTableSql(
  driver: DbDriver,
  schema: string,
  name: string,
  columns: readonly ColumnDraft[],
): string {
  const live = columns.filter((c) => !c.dropped && c.name.trim());
  const keys = live.filter((c) => c.primaryKey).map((c) => ident(driver, c.name));
  const items = live.map((c) => `    ${columnDefinition(driver, c)}`);
  if (keys.length) items.push(`    primary key (${keys.join(", ")})`);
  return `create table ${qualifiedName(driver, schema, name)}\n(\n${items.join(",\n")}\n);\n`;
}

/** Whether `alterTableSql` can express changing column `c` (SQLite only renames, adds and drops). */
export function canAlterColumn(driver: DbDriver, c: ColumnDraft): boolean {
  return driver !== "sqlite" || !c.original;
}

/**
 * The statements turning the table `table` into `name` with `columns`
 * (Modify Table): renames, added / dropped columns, and — PostgreSQL / MySQL —
 * type, nullability and default changes.
 */
export function alterTableSql(
  driver: DbDriver,
  schema: string,
  table: string,
  name: string,
  columns: readonly ColumnDraft[],
): string[] {
  const out: string[] = [];
  const q = () => qualifiedName(driver, schema, table);
  for (const c of columns) {
    const o = c.original;
    if (!o) {
      if (!c.dropped && c.name.trim()) out.push(`alter table ${q()} add column ${columnDefinition(driver, c)};`);
      continue;
    }
    if (c.dropped) {
      out.push(`alter table ${q()} drop column ${ident(driver, o.name)};`);
      continue;
    }
    const renamed = c.name.trim() && c.name !== o.name;
    const changed =
      c.dataType.trim() !== o.dataType || c.notNull !== !o.nullable || c.default.trim() !== (o.default ?? "").trim();
    if (driver === "mysql" && (renamed || changed)) {
      out.push(`alter table ${q()} change column ${ident(driver, o.name)} ${columnDefinition(driver, c)};`);
      continue;
    }
    if (renamed) out.push(`alter table ${q()} rename column ${ident(driver, o.name)} to ${ident(driver, c.name)};`);
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
  // Renamed last: the column statements above name the table as it was.
  if (name.trim() && name.trim() !== table)
    out.push(renameSql(driver, { kind: "table", schema, name: table }, name.trim()));
  return out;
}
