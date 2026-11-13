/** The dump / restore dialogs' model: their forms, file names, tool choice and version hints. */
import type {
  DataSource,
  DbDumpFormat,
  DbDumpKind,
  DbPgDumpOptions,
  DbPgRestoreOptions,
  DbPsqlOptions,
  DbTool,
  DbToolInstall,
} from "@/platform/ipc";
import { splitTarget } from "./model";
import { nodeTarget, type DbNode } from "./nodes";

export const DUMP_FORMATS: readonly { id: DbDumpFormat; label: string; extension: string }[] = [
  { id: "plain", label: "Plain SQL", extension: ".sql" },
  { id: "custom", label: "Custom archive", extension: ".dump" },
  { id: "directory", label: "Directory", extension: "" },
  { id: "tar", label: "Tar archive", extension: ".tar" },
];

/** A name list as typed in a field (`public, audit`). */
type Typed<T, K extends keyof T> = Omit<T, K> & { [P in K]: string };

export type DumpForm = Typed<DbPgDumpOptions, "schemas" | "tables" | "excludeTables">;
export type RestoreForm = Typed<DbPgRestoreOptions, "schemas">;

export const DEFAULT_DUMP: DumpForm = {
  format: "plain",
  statements: "copy",
  content: "all",
  schemas: "",
  tables: "",
  excludeTables: "",
  clean: false,
  ifExists: false,
  create: false,
  noOwner: false,
  noPrivileges: false,
  jobs: 1,
};

export const DEFAULT_RESTORE: RestoreForm = {
  content: "all",
  schemas: "",
  clean: false,
  ifExists: false,
  noOwner: false,
  noPrivileges: false,
  singleTransaction: false,
  exitOnError: true,
  jobs: 1,
};

export const DEFAULT_PSQL: DbPsqlOptions = { singleTransaction: true, stopOnError: true };

/** `a, b c` → `["a", "b", "c"]`. */
export function nameList(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

export function dumpOptions(f: DumpForm): DbPgDumpOptions {
  return { ...f, schemas: nameList(f.schemas), tables: nameList(f.tables), excludeTables: nameList(f.excludeTables) };
}

export function restoreOptions(f: RestoreForm): DbPgRestoreOptions {
  return { ...f, schemas: nameList(f.schemas) };
}

/**
 * The PostgreSQL tool for a dump: from its header when known, else `psql` for a `.sql` file and
 * `pg_restore` for anything else (archives, directories).
 */
export function restoreToolFor(path: string, kind: DbDumpKind | null = null): Extract<DbTool, "pgRestore" | "psql"> {
  if (kind === "postgresArchive") return "pgRestore";
  if (kind === "postgresSql") return "psql";
  return /\.sql$/i.test(path.trim()) ? "psql" : "pgRestore";
}

export type DumpMismatch = "mysqlIntoPostgres" | "archiveIntoPsql" | "sqlIntoPgRestore";

/** Why `tool` cannot restore a dump of `kind`; `null` when it can, or the kind is unknown. */
export function dumpMismatch(tool: DbTool, kind: DbDumpKind | null): DumpMismatch | null {
  if (!kind || kind === "unknown") return null;
  if (kind === "mysqlSql") return "mysqlIntoPostgres";
  if (tool === "psql" && kind === "postgresArchive") return "archiveIntoPsql";
  if (tool === "pgRestore" && kind === "postgresSql") return "sqlIntoPgRestore";
  return null;
}

/** `2026-03-07_09-05-02` (local time). */
export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const unsafe = /[\\/:*?"<>|\s]+/g;

/** Fills `{data_source}`, `{database}` and `{timestamp}` of an output path pattern. */
export function outputPath(pattern: string, values: { dataSource: string; database: string; now: Date }): string {
  return pattern
    .replaceAll("{data_source}", values.dataSource.replace(unsafe, "_"))
    .replaceAll("{database}", values.database.replace(unsafe, "_"))
    .replaceAll("{timestamp}", timestamp(values.now));
}

/** The pattern with the format's extension in place of the previous one. */
export function withExtension(pattern: string, format: DbDumpFormat): string {
  const ext = DUMP_FORMATS.find((f) => f.id === format)!.extension;
  return pattern.replace(/\.(sql|dump|backup|tar)$/i, "") + ext;
}

/** A name as a `pg_dump` pattern: quoted unless it is a lower-case identifier. */
function patternName(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

export interface DumpScope {
  target: string;
  database: string;
  schemas?: string;
  tables?: string;
}

/** What the dump / restore actions act on for tree node `n`; `null` when they don't apply. */
export function dumpScope(n: DbNode, source: DataSource | undefined): DumpScope | null {
  const target = nodeTarget(n);
  if (!target || source?.driver !== "postgres") return null;
  const database = n.kind === "database" ? n.name : (splitTarget(target).database ?? source.database ?? "");
  if (n.kind === "source" || n.kind === "database") return { target, database };
  if (n.kind === "schema") return { target, database, schemas: patternName(n.schema) };
  if (n.kind === "table" && n.table.kind === "table")
    return { target, database, tables: `${patternName(n.schema)}.${patternName(n.table.name)}` };
  return null;
}

/** The major version in a `--version` line (`pg_dump (PostgreSQL) 17.2` → 17). */
export function majorOf(version: string): number | null {
  const m = /(\d+)(?:\.\d+)?/.exec(version);
  return m ? Number(m[1]) : null;
}

/**
 * How a tool's major version fits the server's: `pg_dump` refuses an older-than-server
 * copy, and what newer `pg_dump` / `pg_restore` write may not load into an older server
 * (17 and later set `transaction_timeout`, unknown before 17).
 */
export function versionFit(tool: DbTool, toolMajor: number | null, serverMajor: number | null) {
  if (tool === "psql" || toolMajor === null || serverMajor === null || toolMajor === serverMajor) return "ok";
  if (toolMajor < serverMajor) return tool === "pgDump" ? "tooOld" : "ok";
  return "newer";
}

/** The copy to preselect: the server's major version, else the one used last, else the newest. */
export function pickInstall(installs: DbToolInstall[], serverMajor: number | null, last: string | null): string {
  const matching = installs.find((i) => majorOf(i.version) === serverMajor);
  return matching?.path ?? last ?? installs[0]?.path ?? "";
}

/** `< 1 s`, `4 s`, `12 min 4 s`, `2 h 5 min`. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return "< 1 s";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${sec} s`;
  return `${sec} s`;
}

/** The last part of a path, for one-line summaries. */
export function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}
