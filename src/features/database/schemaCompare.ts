/**
 * Compare Structure (DataGrip's schema comparison): the differences between a source and a
 * target schema — tables, columns, indexes and foreign keys — and the migration SQL that
 * makes the chosen parts of the target match the source. Pure functions; nothing is run.
 */
import type { DbColumnInfo, DbDriver, DbForeignKey, DbIndexInfo, DbTableKind } from "@/platform/ipc";
import { alterTableSql, createTableSql, draftOf, ident, qualifiedName, type ColumnDraft } from "./objects";

export interface TableSnapshot {
  name: string;
  kind: DbTableKind;
  columns: DbColumnInfo[];
  indexes: DbIndexInfo[];
  foreignKeys: DbForeignKey[];
}

/** `added`: only in the source (the migration creates it); `removed`: only in the target (it drops it). */
export type DiffState = "added" | "removed" | "changed" | "same";

export interface ItemDiff<T> {
  /** Selection key, unique in the comparison. */
  key: string;
  name: string;
  state: DiffState;
  source?: T;
  target?: T;
  /** What differs, for a changed item: `type`, `nullable`, `default`, `primary key`, `unique`, `columns`, `references`. */
  changes: string[];
}

export interface TableDiff extends ItemDiff<TableSnapshot> {
  columns: ItemDiff<DbColumnInfo>[];
  indexes: ItemDiff<DbIndexInfo>[];
  foreignKeys: ItemDiff<DbForeignKey>[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** Pairs items by name: exact first, then ignoring case. */
function pair<T>(
  source: readonly T[],
  target: readonly T[],
  name: (t: T) => string,
): Array<[T | undefined, T | undefined]> {
  const left = new Set(target);
  const out: Array<[T | undefined, T | undefined]> = [];
  for (const s of source) {
    const n = name(s);
    let t = [...left].find((x) => name(x) === n);
    t ??= [...left].find((x) => name(x).toLowerCase() === n.toLowerCase());
    if (t) left.delete(t);
    out.push([s, t]);
  }
  for (const t of target) if (left.has(t)) out.push([undefined, t]);
  return out;
}

function stateOf(source: unknown, target: unknown, changes: string[]): DiffState {
  if (!target) return "added";
  if (!source) return "removed";
  return changes.length ? "changed" : "same";
}

function columnChanges(s: DbColumnInfo, t: DbColumnInfo): string[] {
  const out: string[] = [];
  if (norm(s.dataType) !== norm(t.dataType)) out.push("type");
  if (s.nullable !== t.nullable) out.push("nullable");
  if (norm(s.default) !== norm(t.default)) out.push("default");
  if (s.primaryKey !== t.primaryKey) out.push("primary key");
  return out;
}

const fkName = (k: DbForeignKey) => `(${k.columns.join(", ")}) → ${k.refTable}(${k.refColumns.join(", ")})`;

export function diffSchemas(source: readonly TableSnapshot[], target: readonly TableSnapshot[]): TableDiff[] {
  return pair(source, target, (t) => t.name)
    .map(([s, t]): TableDiff => {
      const name = (s ?? t)!.name;
      const columns = pair(s?.columns ?? [], t?.columns ?? [], (c) => c.name).map(([a, b]) => {
        const changes = a && b ? columnChanges(a, b) : [];
        return {
          key: `c:${name}.${(a ?? b)!.name}`,
          name: (a ?? b)!.name,
          state: stateOf(a, b, changes),
          source: a,
          target: b,
          changes,
        };
      });
      const indexes = pair(s?.indexes ?? [], t?.indexes ?? [], (i) => i.name).map(([a, b]) => {
        const changes: string[] = [];
        if (a && b) {
          if (a.unique !== b.unique) changes.push("unique");
          if (norm(a.columns.join(",")) !== norm(b.columns.join(","))) changes.push("columns");
        }
        return {
          key: `i:${name}.${(a ?? b)!.name}`,
          name: (a ?? b)!.name,
          state: stateOf(a, b, changes),
          source: a,
          target: b,
          changes,
        };
      });
      // Foreign keys have no comparable name across databases: they pair by what they link.
      const foreignKeys = pair(s?.foreignKeys ?? [], t?.foreignKeys ?? [], (k) => norm(fkName(k))).map(([a, b]) => ({
        key: `f:${name}.${fkName((a ?? b)!)}`,
        name: fkName((a ?? b)!),
        state: stateOf(a, b, []),
        source: a,
        target: b,
        changes: [],
      }));
      const changes: string[] = [];
      if (s && t && [...columns, ...indexes, ...foreignKeys].some((d) => d.state !== "same")) changes.push("content");
      return {
        key: `t:${name}`,
        name,
        state: stateOf(s, t, changes),
        source: s,
        target: t,
        changes,
        columns,
        indexes,
        foreignKeys,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every key of a difference (not of identical items): the default selection. */
export function differenceKeys(diffs: readonly TableDiff[]): Set<string> {
  const keys = new Set<string>();
  for (const t of diffs) {
    if (t.state === "same") continue;
    keys.add(t.key);
    for (const d of [...t.columns, ...t.indexes, ...t.foreignKeys]) if (d.state !== "same") keys.add(d.key);
  }
  return keys;
}

function createIndexSql(driver: DbDriver, schema: string, table: string, i: DbIndexInfo): string {
  const cols = i.columns.map((c) => ident(driver, c)).join(", ");
  return `create ${i.unique ? "unique " : ""}index ${ident(driver, i.name)} on ${qualifiedName(driver, schema, table)} (${cols});`;
}

function dropIndexSql(driver: DbDriver, schema: string, table: string, i: DbIndexInfo): string {
  if (driver === "mysql" || driver === "sqlServer")
    return `drop index ${ident(driver, i.name)} on ${qualifiedName(driver, schema, table)};`;
  return `drop index ${qualifiedName(driver, schema, i.name)};`;
}

function addForeignKeySql(driver: DbDriver, schema: string, table: string, k: DbForeignKey): string {
  const cols = (names: string[]) => names.map((c) => ident(driver, c)).join(", ");
  return `alter table ${qualifiedName(driver, schema, table)} add foreign key (${cols(k.columns)}) references ${qualifiedName(driver, schema, k.refTable)} (${cols(k.refColumns)});`;
}

/**
 * The statements making the selected differences of the target (`schema` on `driver`)
 * match the source: drops of foreign keys and indexes first, then tables and columns,
 * then new indexes and foreign keys. A dropped foreign key has no portable name: it is
 * left as a comment to write by hand.
 */
export function migrationSql(
  driver: DbDriver,
  schema: string,
  diffs: readonly TableDiff[],
  selected: ReadonlySet<string>,
): string {
  const first: string[] = [];
  const tables: string[] = [];
  const last: string[] = [];
  for (const t of diffs) {
    const pick = (d: ItemDiff<unknown>) => selected.has(d.key) && d.state !== "same";
    if (t.state === "added") {
      if (!selected.has(t.key) || !t.source) continue;
      tables.push(
        createTableSql(
          driver,
          schema,
          t.name,
          t.source.columns.map((c, i) => ({ ...draftOf(c, i), original: null })),
        ).trimEnd(),
      );
      // The primary key's own index comes with the table.
      const key = t.source.columns.filter((c) => c.primaryKey).map((c) => norm(c.name));
      const isKey = (i: DbIndexInfo) =>
        i.unique && i.columns.length === key.length && i.columns.every((c) => key.includes(norm(c)));
      for (const i of t.source.indexes) if (!isKey(i)) last.push(createIndexSql(driver, schema, t.name, i));
      for (const k of t.source.foreignKeys) last.push(addForeignKeySql(driver, schema, t.name, k));
      continue;
    }
    if (t.state === "removed") {
      if (selected.has(t.key)) tables.push(`drop table ${qualifiedName(driver, schema, t.name)};`);
      continue;
    }
    for (const k of t.foreignKeys)
      if (pick(k) && k.state === "removed")
        first.push(
          `-- drop the foreign key ${k.name} of ${qualifiedName(driver, schema, t.name)} (constraint name differs per database)`,
        );
    for (const i of t.indexes)
      if (pick(i) && (i.state === "removed" || i.state === "changed"))
        first.push(dropIndexSql(driver, schema, t.name, i.target!));
    const drafts: ColumnDraft[] = [];
    t.columns.forEach((c, n) => {
      if (!pick(c)) return;
      if (c.state === "added") drafts.push({ ...draftOf(c.source!, n), original: null });
      else if (c.state === "removed") drafts.push({ ...draftOf(c.target!, n), dropped: true });
      else {
        const s = c.source!;
        drafts.push({ ...draftOf(c.target!, n), dataType: s.dataType, notNull: !s.nullable, default: s.default ?? "" });
      }
    });
    if (drafts.length) tables.push(...alterTableSql(driver, schema, t.name, t.name, drafts));
    // SQLite only adds and drops columns: a changed one is rebuilt by hand.
    if (driver === "sqlite")
      for (const c of t.columns)
        if (pick(c) && c.state === "changed")
          tables.push(
            `-- SQLite cannot alter ${qualifiedName(driver, schema, t.name)}.${ident(driver, c.name)} (${c.changes.join(", ")}): rebuild the table`,
          );
    for (const c of t.columns)
      if (pick(c) && c.changes.includes("primary key"))
        last.push(`-- the primary key of ${qualifiedName(driver, schema, t.name)} changes at ${ident(driver, c.name)}`);
    for (const i of t.indexes)
      if (pick(i) && (i.state === "added" || i.state === "changed"))
        last.push(createIndexSql(driver, schema, t.name, i.source!));
    for (const k of t.foreignKeys)
      if (pick(k) && k.state === "added") last.push(addForeignKeySql(driver, schema, t.name, k.source!));
  }
  const all = [...first, ...tables, ...last];
  return all.length ? `${all.join("\n")}\n` : "";
}
