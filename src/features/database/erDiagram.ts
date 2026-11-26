/** Diagrams › Show Diagram: the selected tables, their keys and indexes, linked by their foreign keys. */
import type { DbTableDetails } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";

export const DIAGRAM_KIND = "db-diagram";

export interface DiagramTable {
  /** Connection target. */
  id: string;
  schema: string;
  name: string;
  details: DbTableDetails;
}

export interface DiagramData {
  title: string;
  tables: DiagramTable[];
}

export const diagramTitle = (input: EditorInput) => (input.data as DiagramData).title;

export const tableKey = (t: Pick<DiagramTable, "id" | "schema" | "name">) => `${t.id}\u0000${t.schema}\u0000${t.name}`;

/** The set of tables, whatever their order: the tab's identity and the key of its saved layout. */
export const diagramKey = (tables: readonly DiagramTable[]) => JSON.stringify(tables.map(tableKey).sort());

/** The same tables open in the same tab. */
export function diagramInput(data: DiagramData): EditorInput {
  return { kind: DIAGRAM_KIND, key: `${DIAGRAM_KIND}:${diagramKey(data.tables)}`, data };
}

/** Tables of a schema shown at most: the layout takes too long for a diagram nobody can read beyond that. */
export const DIAGRAM_TABLE_LIMIT = 50;

export interface DiagramColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  foreignKey: boolean;
  /** Member of a unique key other than the primary key. */
  unique: boolean;
  /** Member of an index that isn't unique. */
  indexed: boolean;
  /** The indexes and unique keys the column belongs to, for its tooltip. */
  indexes: string[];
}

export interface DiagramNode {
  key: string;
  label: string;
  columns: DiagramColumn[];
  table: DiagramTable;
}

export interface DiagramEdge {
  /** Index of the referencing table in `nodes`. */
  from: number;
  fromColumns: string[];
  /** Index of the referenced table. */
  to: number;
  toColumns: string[];
  /** A referencing column is nullable: a row may reference nothing. */
  optional: boolean;
}

const sameColumns = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((c) => b.includes(c));

/**
 * The diagram of `tables`: their columns with key and index markers, and an
 * edge per foreign key whose referenced table is one of `tables`. Labels are
 * qualified by schema when the tables span several schemas or data sources.
 */
export function diagramModel(tables: readonly DiagramTable[]): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const qualify = new Set(tables.map((t) => `${t.id}\u0000${t.schema}`)).size > 1;
  const index = new Map(tables.map((t, i) => [tableKey(t), i]));
  // SQLite (and MySQL on case-insensitive file systems) keep the referenced name as the DDL spells it.
  const folded = new Map(tables.map((t, i) => [tableKey(t).toLowerCase(), i]));
  const edges: DiagramEdge[] = [];
  const nodes = tables.map((t, i): DiagramNode => {
    const { columns, indexes, foreignKeys } = t.details;
    const primary = columns.filter((c) => c.primaryKey).map((c) => c.name);
    // The primary key's own index (`users_pkey`) adds nothing to its PK marker.
    const shown = indexes.filter((x) => !(x.unique && sameColumns(x.columns, primary)));
    const fk = new Set(foreignKeys.flatMap((k) => k.columns));
    for (const k of foreignKeys) {
      const ref = tableKey({ id: t.id, schema: k.refSchema, name: k.refTable });
      const to = index.get(ref) ?? folded.get(ref.toLowerCase());
      if (to === undefined) continue;
      const optional = k.columns.some((name) => columns.find((c) => c.name === name)?.nullable ?? true);
      edges.push({ from: i, fromColumns: k.columns, to, toColumns: k.refColumns, optional });
    }
    return {
      key: tableKey(t),
      label: qualify ? `${t.schema}.${t.name}` : t.name,
      table: t,
      columns: columns.map((c) => {
        const own = shown.filter((x) => x.columns.includes(c.name));
        return {
          name: c.name,
          type: c.dataType,
          primaryKey: c.primaryKey,
          foreignKey: fk.has(c.name),
          unique: own.some((x) => x.unique),
          indexed: own.some((x) => !x.unique),
          indexes: own.map((x) => x.name),
        };
      }),
    };
  });
  return { nodes, edges };
}
