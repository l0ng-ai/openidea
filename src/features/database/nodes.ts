/** Nodes of the Database tool window tree and the objects they stand for. */
import type {
  DataSource,
  DbColumnInfo,
  DbForeignKey,
  DbIndexInfo,
  DbObjectKind as DbSchemaObjectKind,
  DbPackageInfo,
  DbRoutineInfo,
  DbSequenceInfo,
  DbTableInfo,
  DbTableKind,
  DbTriggerInfo,
} from "@/platform/ipc";
import type { DbObjectRef } from "./objects";

export type Group = "columns" | "keys" | "foreignKeys" | "indexes" | "triggers";

/** Schema folders; routines can optionally be separated into procedures and functions. */
export type Folder =
  | "tables"
  | "views"
  | "materializedViews"
  | "routines"
  | "procedures"
  | "functions"
  | "packages"
  | "sequences";

/** The folder a table, view or materialized view is listed in. */
export function tableFolder(kind: DbTableKind): Folder {
  return kind === "view" ? "views" : kind === "materializedView" ? "materializedViews" : "tables";
}

/** IDEA's *Separate Procedures and Functions* option: the folder a routine is listed in. */
export function routineFolder(kind: DbRoutineInfo["kind"], separate = false): "routines" | "procedures" | "functions" {
  if (!separate) return "routines";
  return kind === "procedure" ? "procedures" : "functions";
}

/** Where a table-level node lives: connection target, schema, table. */
interface InTable {
  id: string;
  schema: string;
  table: string;
}

export type DbNode =
  | { kind: "source"; key: string; source: DataSource }
  /** A database of a PostgreSQL / SQL Server host; `id` is its connection target. */
  | { kind: "database"; key: string; id: string; name: string; current: boolean }
  | { kind: "schema"; key: string; id: string; schema: string }
  | { kind: "folder"; key: string; id: string; schema: string; folder: Folder }
  | { kind: "table"; key: string; id: string; schema: string; table: DbTableInfo }
  | { kind: "routine"; key: string; id: string; schema: string; routine: DbRoutineInfo }
  | { kind: "package"; key: string; id: string; schema: string; package: DbPackageInfo }
  | { kind: "sequence"; key: string; id: string; schema: string; sequence: DbSequenceInfo }
  | ({ kind: "group"; key: string; group: Group } & InTable)
  | ({ kind: "column"; key: string; column: DbColumnInfo; foreignKey: boolean } & InTable)
  | ({ kind: "key"; key: string; columns: string[] } & InTable)
  | ({ kind: "foreignKey"; key: string; fk: DbForeignKey } & InTable)
  | ({ kind: "index"; key: string; index: DbIndexInfo } & InTable)
  | ({ kind: "trigger"; key: string; trigger: DbTriggerInfo } & InTable)
  | { kind: "message"; key: string; text: string; error?: boolean };

/** The connection target a node belongs to. */
export function nodeTarget(n: DbNode): string | null {
  if (n.kind === "source") return n.source.id ?? null;
  if ("id" in n && typeof n.id === "string") return n.id;
  return n.key.split("/")[0] ?? null;
}

/** The table (or view) a node is, or is inside of. */
export function tableOf(
  n: DbNode,
): { id: string; schema: string; table: string; view: boolean; kind: DbTableKind } | null {
  if (n.kind === "table")
    return { id: n.id, schema: n.schema, table: n.table.name, view: n.table.kind !== "table", kind: n.table.kind };
  if ("table" in n && typeof n.table === "string")
    return { id: n.id, schema: n.schema, table: n.table, view: false, kind: "table" };
  return null;
}

/** A routine, package, trigger or sequence node: what Go to DDL / Quick Documentation read. */
export function schemaObjectOf(
  n: DbNode,
): { id: string; schema: string; kind: DbSchemaObjectKind; name: string } | null {
  if (n.kind === "routine") return { id: n.id, schema: n.schema, kind: n.routine.kind, name: n.routine.name };
  if (n.kind === "package") return { id: n.id, schema: n.schema, kind: "package", name: n.package.name };
  if (n.kind === "sequence") return { id: n.id, schema: n.schema, kind: "sequence", name: n.sequence.name };
  if (n.kind === "trigger") return { id: n.id, schema: n.schema, kind: "trigger", name: n.trigger.name };
  return null;
}

/** The schema object a node stands for (Rename, Drop, Copy Reference). */
export function objectOf(n: DbNode): DbObjectRef | null {
  switch (n.kind) {
    case "schema":
      return { kind: "schema", schema: n.schema, name: n.schema };
    case "table":
      return { kind: n.table.kind, schema: n.schema, name: n.table.name };
    case "column":
      return { kind: "column", schema: n.schema, name: n.table, column: n.column.name };
    case "index":
      return { kind: "index", schema: n.schema, name: n.index.name, table: n.table };
    case "routine":
      return { kind: n.routine.kind, schema: n.schema, name: n.routine.name, arguments: n.routine.arguments };
    case "package":
      return { kind: "package", schema: n.schema, name: n.package.name };
    case "sequence":
      return { kind: "sequence", schema: n.schema, name: n.sequence.name };
    case "trigger":
      return { kind: "trigger", schema: n.schema, name: n.trigger.name, table: n.table };
    default:
      return null;
  }
}
