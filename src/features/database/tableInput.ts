import type { EditorInput } from "@/workbench/contributions";

export const TABLE_KIND = "db-table";

export interface TableRef {
  id: string;
  schema: string;
  table: string;
  catalog?: string;
}

export function tableTitle(input: EditorInput): string {
  const { catalog, schema, table } = input.data as TableRef;
  return catalog === undefined ? table : `${catalog}.${schema}.${table}`;
}

export function tableInput(id: string, schema: string, table: string, catalog?: string): EditorInput {
  const data: TableRef = catalog === undefined ? { id, schema, table } : { id, schema, table, catalog };
  const key = catalog === undefined ? `${id}:${schema}.${table}` : JSON.stringify([id, catalog, schema, table]);
  return { kind: TABLE_KIND, key: `${TABLE_KIND}:${key}`, data };
}
