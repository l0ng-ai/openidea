/** Nodes of the Database tool window tree and the objects they stand for. */
import type {
  DataSource,
  DbColumnInfo,
  DbForeignKey,
  DbIndexInfo,
  DbSourceFolder,
  DbObjectKind as DbSchemaObjectKind,
  DbPackageInfo,
  DbRoutineInfo,
  DbSchemaObject,
  DbSequenceInfo,
  DbTableInfo,
  DbTableKind,
  DbTriggerInfo,
} from "@/platform/ipc";
import type { DbObjectRef } from "./objects";
import type { TableRef } from "./tableInput";

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
  | "sequences"
  | OtherFolder;

/** Folders of object kinds only some databases have (Snowflake), by the kind the backend names. */
export const OTHER_FOLDERS = {
  stage: "stages",
  stream: "streams",
  task: "tasks",
  pipe: "pipes",
  fileFormat: "fileFormats",
} as const;

export type OtherFolder = (typeof OTHER_FOLDERS)[keyof typeof OTHER_FOLDERS];

export const isOtherFolder = (folder: Folder): folder is OtherFolder =>
  (Object.values(OTHER_FOLDERS) as string[]).includes(folder);

/** The folder an object of `kind` is listed in (unknown kinds are not shown). */
export const otherFolder = (kind: string): OtherFolder | undefined =>
  (OTHER_FOLDERS as Record<string, OtherFolder | undefined>)[kind];

/** The folder a table, view or materialized view is listed in. */
export function tableFolder(kind: DbTableKind): Folder {
  return kind === "view" ? "views" : kind === "materializedView" ? "materializedViews" : "tables";
}

/** IDEA's *Separate Procedures and Functions* option: the folder a routine is listed in. */
export function routineFolder(kind: DbRoutineInfo["kind"], separate = false): "routines" | "procedures" | "functions" {
  if (!separate) return "routines";
  return kind === "procedure" ? "procedures" : "functions";
}

type InSchema = Pick<TableRef, "id" | "catalog" | "schema">;

export type DbNode =
  | { kind: "workspace"; key: string }
  | { kind: "source"; key: string; source: DataSource }
  | { kind: "sourceFolder"; key: string; folder: DbSourceFolder }
  /** DuckDB's `catalog` stays on the session of `id`; other databases have their own target. */
  | { kind: "database"; key: string; id: string; name: string; current: boolean; catalog?: string }
  | ({ kind: "schema"; key: string } & InSchema)
  | ({ kind: "folder"; key: string; folder: Folder } & InSchema)
  | ({ kind: "table"; key: string; table: DbTableInfo } & InSchema)
  | { kind: "routine"; key: string; id: string; schema: string; routine: DbRoutineInfo }
  | { kind: "package"; key: string; id: string; schema: string; package: DbPackageInfo }
  | { kind: "sequence"; key: string; id: string; schema: string; sequence: DbSequenceInfo }
  /** A stage, stream, task, pipe or file format: listed by name. */
  | { kind: "object"; key: string; id: string; schema: string; object: DbSchemaObject }
  | ({ kind: "group"; key: string; group: Group } & TableRef)
  | ({ kind: "column"; key: string; column: DbColumnInfo; foreignKey: boolean } & TableRef)
  | ({ kind: "key"; key: string; columns: string[] } & TableRef)
  | ({ kind: "foreignKey"; key: string; fk: DbForeignKey } & TableRef)
  | ({ kind: "index"; key: string; index: DbIndexInfo } & TableRef)
  | ({ kind: "trigger"; key: string; trigger: DbTriggerInfo } & TableRef)
  | { kind: "message"; key: string; text: string; error?: boolean };

/** The connection target a node belongs to. */
export function nodeTarget(n: DbNode): string | null {
  if (n.kind === "workspace") return null;
  if (n.kind === "source") return n.source.id ?? null;
  if (n.kind === "sourceFolder" || n.kind === "message") return null;
  if ("id" in n && typeof n.id === "string") return n.id;
  return n.key.split("/")[0] ?? null;
}

/** The schema a node is, or is inside of; `null` for data sources, databases and messages. */
export function nodeSchema(n: DbNode): string | null {
  return "schema" in n && n.schema ? n.schema : null;
}

/** The table (or view) a node is, or is inside of. */
export function tableOf(n: DbNode): (TableRef & { view: boolean; kind: DbTableKind }) | null {
  if (n.kind === "table")
    return {
      id: n.id,
      catalog: n.catalog,
      schema: n.schema,
      table: n.table.name,
      view: n.table.kind !== "table",
      kind: n.table.kind,
    };
  if ("table" in n && typeof n.table === "string")
    return { id: n.id, catalog: n.catalog, schema: n.schema, table: n.table, view: false, kind: "table" };
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
