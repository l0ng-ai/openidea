/**
 * Result-set export formats (IDEA's data extractors): CSV, TSV, JSON, SQL
 * INSERT statements, a Markdown table and One-Row (all values on one `, ` list).
 * Values arrive as text; numeric columns are written unquoted where the format
 * distinguishes them.
 */
import type { DbDriver } from "@/platform/ipc";
import { jsonNumber } from "@/platform/losslessJson";
import { isNumericColumn } from "./Grid";
import { toCsv, toOneRow, toTsv, type Cell } from "./model";
import { quoteIdent } from "./sql/complete";

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "onerow";

export const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; extension: string }> = [
  { id: "csv", label: "CSV", extension: "csv" },
  { id: "tsv", label: "TSV", extension: "tsv" },
  { id: "json", label: "JSON", extension: "json" },
  { id: "sql", label: "SQL Inserts", extension: "sql" },
  { id: "markdown", label: "Markdown", extension: "md" },
  { id: "onerow", label: "One-Row", extension: "txt" },
];

export interface ExportData {
  columns: ReadonlyArray<{ name: string; type: string }>;
  rows: ReadonlyArray<readonly Cell[]>;
  /** Target of SQL inserts (the query's table, when it reads one). */
  table: string;
  driver: DbDriver;
}

/** The Export Data dialog's options (CSV, TSV and Markdown; JSON and SQL keep their shape). */
export interface ExportOptions {
  columnHeader: boolean;
  rowHeader: boolean;
  transpose: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { columnHeader: true, rowHeader: false, transpose: false };

/** Header and rows of a delimited export after the row header / transpose options. */
function laidOut(d: ExportData, o: ExportOptions): { head: string[] | null; rows: Cell[][] } {
  let head = d.columns.map((c) => c.name);
  let rows = d.rows.map((r) => [...r]);
  if (o.rowHeader) {
    head = ["#", ...head];
    rows = rows.map((r, i) => [String(i + 1), ...r]);
  }
  if (!o.transpose) return { head: o.columnHeader ? head : null, rows };
  return { head: null, rows: head.map((h, c) => [...(o.columnHeader ? [h] : []), ...rows.map((r) => r[c] ?? null)]) };
}

/** A cell as JSON: numeric columns keep their exact digits, everything else is a string. */
function jsonCell(v: Cell, numeric: boolean): string {
  if (v === null) return "null";
  if (!numeric) return JSON.stringify(v);
  const literal = jsonNumber(v);
  if (literal !== null) return literal;
  const number = Number(v);
  return Number.isFinite(number) ? JSON.stringify(number) : JSON.stringify(v);
}

export function exportData(
  format: ExportFormat,
  d: ExportData,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  const names = d.columns.map((c) => c.name);
  const numeric = d.columns.map((c, i) =>
    isNumericColumn(
      c.type,
      d.rows.slice(0, 50).map((r) => r[i] ?? null),
    ),
  );
  switch (format) {
    case "csv": {
      const t = laidOut(d, options);
      return toCsv(t.head, t.rows);
    }
    case "tsv": {
      const t = laidOut(d, options);
      return toTsv(t.head, t.rows);
    }
    case "json": {
      const rows = d.rows.map((r) => {
        const cells = Object.fromEntries(names.map((n, i) => [n, jsonCell(r[i] ?? null, numeric[i]!)]));
        const members = Object.entries(cells).map(([name, value]) => `    ${JSON.stringify(name)}: ${value}`);
        return members.length ? `  {\n${members.join(",\n")}\n  }` : "  {}";
      });
      return rows.length ? `[\n${rows.join(",\n")}\n]` : "[]";
    }
    case "sql": {
      const literal = (v: Cell, i: number) =>
        v === null
          ? "NULL"
          : numeric[i] && Number.isFinite(Number(v))
            ? v
            : `'${(d.driver === "clickhouse" || d.driver === "snowflake" ? v.replace(/\\/g, "\\\\") : v).replace(/'/g, "''")}'`;
      const head = `INSERT INTO ${quoteIdent(d.table, d.driver)} (${names.map((n) => quoteIdent(n, d.driver)).join(", ")}) VALUES`;
      return d.rows.map((r) => `${head} (${r.map(literal).join(", ")});`).join("\n");
    }
    case "markdown": {
      const cell = (v: Cell) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      const t = laidOut(d, options);
      const width = t.head?.length ?? t.rows[0]?.length ?? 0;
      // A Markdown table always has a header row: blank when left out.
      const head = t.head ?? Array.from({ length: width }, () => "");
      const align =
        options.transpose || t.head === null
          ? head.map(() => "---")
          : [...(options.rowHeader ? ["--:"] : []), ...numeric.map((n) => (n ? "--:" : "---"))];
      return [head.map(cell), align, ...t.rows.map((r) => r.map(cell))].map((r) => `| ${r.join(" | ")} |`).join("\n");
    }
    case "onerow":
      return toOneRow(d.rows, (c) => numeric[c]!);
  }
}
