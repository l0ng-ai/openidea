/** Diagrams › Show Diagram: the selected tables as a Mermaid ER diagram, linked by their foreign keys. */
import type { DbTableDetails } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";

export const DIAGRAM_KIND = "db-diagram";

export interface DiagramData {
  title: string;
  /** Mermaid `erDiagram` source. */
  source: string;
}

export const diagramTitle = (input: EditorInput) => (input.data as DiagramData).title;

/** The same diagram opens in the same tab. */
export function diagramInput(data: DiagramData): EditorInput {
  return { kind: DIAGRAM_KIND, key: `${DIAGRAM_KIND}:${data.source}`, data };
}

export interface DiagramTable {
  /** Connection target. */
  id: string;
  schema: string;
  name: string;
  details: DbTableDetails;
}

/** Tables of a schema shown at most: Mermaid lays out and sizes larger diagrams poorly. */
export const DIAGRAM_TABLE_LIMIT = 50;

/** Mermaid's default `maxTextSize`: a longer source renders as an error. */
export const MERMAID_MAX_TEXT = 50_000;

/**
 * Text Mermaid shows as written: anything but letters, digits and spaces
 * becomes an entity code (`#34;`), so quotes, backticks, `%`, `\`, `#` and
 * Markdown markers in a name can neither end its token nor format it.
 */
function text(s: string): string {
  return s.replace(/[^\p{L}\p{N} ]/gu, (c) => `#${c.codePointAt(0)};`);
}

const tableKey = (id: string, schema: string, name: string) => `${id}\u0000${schema}\u0000${name}`;

/**
 * The Mermaid `erDiagram` source of `tables`: their columns with PK / FK
 * markers, and a relationship per foreign key whose referenced table is one of
 * `tables`. Names are qualified by schema when the tables span several.
 */
export function erDiagram(tables: readonly DiagramTable[]): string {
  const qualify = new Set(tables.map((t) => tableKey(t.id, t.schema, ""))).size > 1;
  const ids = new Map(tables.map((t, i) => [tableKey(t.id, t.schema, t.name), `t${i}`]));
  // SQLite (and MySQL on case-insensitive file systems) keep the referenced name as the DDL spells it.
  const folded = new Map(tables.map((t, i) => [tableKey(t.id, t.schema, t.name).toLowerCase(), `t${i}`]));
  const lines = ["erDiagram"];
  const relations: string[] = [];
  tables.forEach((t, i) => {
    const label = qualify ? `${t.schema}.${t.name}` : t.name;
    const fkColumns = new Set(t.details.foreignKeys.flatMap((k) => k.columns));
    lines.push(`  t${i}["${text(label)}"] {`);
    for (const c of t.details.columns) {
      const keys = [c.primaryKey && "PK", fkColumns.has(c.name) && "FK"].filter(Boolean).join(", ");
      lines.push(`    \`${text(c.dataType || "?")}\` \`${text(c.name || "?")}\`${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
    for (const k of t.details.foreignKeys) {
      const ref = tableKey(t.id, k.refSchema, k.refTable);
      const parent = ids.get(ref) ?? folded.get(ref.toLowerCase());
      if (!parent) continue;
      // A nullable referencing column lets a row reference nothing: zero or one parent.
      const optional = k.columns.some((name) => t.details.columns.find((c) => c.name === name)?.nullable ?? true);
      relations.push(`  ${parent} ${optional ? "|o" : "||"}--o{ t${i} : "${text(k.columns.join(", "))}"`);
    }
  });
  return [...lines, ...relations].join("\n");
}
