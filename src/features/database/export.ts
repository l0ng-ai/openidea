/**
 * Result-set export formats (IDEA's data extractors): CSV, TSV, JSON, SQL
 * INSERT statements and a Markdown table. Values arrive as text; numeric
 * columns are written unquoted where the format distinguishes them.
 */
import type { DbDriver } from "@/platform/ipc";
import { isNumericColumn } from "./Grid";
import { toCsv, toTsv, type Cell } from "./model";
import { quoteIdent } from "./sql/complete";

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

export const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; extension: string }> = [
  { id: "csv", label: "CSV", extension: "csv" },
  { id: "tsv", label: "TSV", extension: "tsv" },
  { id: "json", label: "JSON", extension: "json" },
  { id: "sql", label: "SQL Inserts", extension: "sql" },
  { id: "markdown", label: "Markdown", extension: "md" },
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
      const value = (v: Cell, i: number) =>
        v === null ? null : numeric[i] && Number.isFinite(Number(v)) ? Number(v) : v;
      return JSON.stringify(
        d.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, value(r[i] ?? null, i)]))),
        null,
        2,
      );
    }
    case "sql": {
      const literal = (v: Cell, i: number) =>
        v === null ? "NULL" : numeric[i] && Number.isFinite(Number(v)) ? v : `'${v.replace(/'/g, "''")}'`;
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
  }
}
