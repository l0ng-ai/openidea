/**
 * Generating what a mapper is usually missing: the XML statement of a Java
 * method, and the `@Param` annotations a multi-parameter method needs.
 *
 * This is arithmetic on text. The parsers say where things are; these functions
 * say what to insert and where, and the editor layer applies the result as one
 * reversible CodeMirror transaction.
 *
 * The SQL is a skeleton on purpose: a real query needs the table's columns and
 * the entity behind the return type, and neither is in the file being edited. So
 * the table name comes from the interface name, the columns from the parameter
 * names, and the caret lands on the line the user has to fix.
 */
import type { JavaMapper, MapperMethod } from "./java";
import type { Found } from "./mapperStore";
import type { BINDING_TAGS, MapperXml } from "./xml";

export type BindingTag = (typeof BINDING_TAGS)[number];

/** Half-open replacement of `text[from, to)` — the shape one editor transaction takes. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** An edit plus the document range of the SQL line it puts in. */
export interface Placement {
  edit: Edit;
  /** The guess is selected, so typing replaces it. */
  from: number;
  to: number;
}

/** One generation offer per method line of a mapper interface. */
export interface Generation {
  /** 0-based line of the method name. */
  line: number;
  name: string;
  /** No statement of this id exists, and the method does not carry the SQL in an annotation. */
  statement: boolean;
  /** At least two parameters, and not all of them have `@Param`. */
  params: boolean;
}

const VERBS: Record<string, BindingTag> = {
  select: "select",
  find: "select",
  get: "select",
  load: "select",
  search: "select",
  query: "select",
  list: "select",
  count: "select",
  exists: "select",
  insert: "insert",
  save: "insert",
  add: "insert",
  create: "insert",
  update: "update",
  edit: "update",
  modify: "update",
  set: "update",
  delete: "delete",
  remove: "delete",
  clear: "delete",
  drop: "delete",
};

/** The statement tag a name suggests: the first camel-case word that is a known verb. */
export function statementTag(name: string): BindingTag {
  for (const word of name.split(/(?=[A-Z])/)) {
    const tag = VERBS[word.toLowerCase()];
    if (tag) return tag;
  }
  return "select";
}

/** `SysUserMapper` → `sys_user`; a name that says nothing about a table → `table_name`. */
export function tableName(mapperName: string): string {
  const base = mapperName.replace(/(?:Mapper|Dao|DAO)$/, "");
  if (!base) return "table_name";
  return base
    .replace(/([^A-Z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** The `resultType` of a return type: the element of a collection, the row of an array, `map` for a map. */
export function resultTypeOf(returnType: string): string | null {
  const type = returnType.replace(/\s+/g, " ").trim();
  if (!type || type === "void") return null;
  if (/^(?:java\.util\.)?(?:Map|HashMap)\b/.test(type)) return "map";
  const inner = /<(.+)>/.exec(type)?.[1];
  const base = (inner ? inner.split(",")[0]!.trim() : type).replace(/\[\]$/, "");
  return base || null;
}

const condition = (column: string) => `${column} = #{${column}}`;

/** The SQL body: a shape to edit, never a query to run. */
function sqlOf(tag: BindingTag, table: string, params: readonly string[]): string {
  const where = params.length ? ` WHERE ${params.map(condition).join(" AND ")}` : "";
  const columns = params.length ? params : ["column"];
  if (tag === "insert") {
    return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `#{${c}}`).join(", ")})`;
  }
  if (tag === "update") {
    const [first = "column", ...rest] = params;
    return `UPDATE ${table} SET ${condition(first)}${rest.length ? ` WHERE ${rest.map(condition).join(" AND ")}` : ""}`;
  }
  if (tag === "delete") return `DELETE FROM ${table}${where}`;
  return `SELECT * FROM ${table}${where}`;
}

/** The statement block of `method`; every line, including the first, carries `indent`. */
export function statementXml(method: MapperMethod, indent: string, table: string): string {
  const tag = statementTag(method.name);
  const attrs = [`id="${method.name}"`];
  const result = tag === "select" ? resultTypeOf(method.returnType) : null;
  if (result) attrs.push(`resultType="${result}"`);
  const sql = sqlOf(
    tag,
    table,
    method.parameters.map((p) => p.paramAnnotation ?? p.name),
  );
  return [`${indent}<${tag} ${attrs.join(" ")}>`, `${indent}  ${sql}`, `${indent}</${tag}>`].join("\n");
}

/** Offsets, inside a block, of its SQL line. */
function blockSelection(block: string): { from: number; to: number } {
  const open = block.indexOf("\n");
  if (open < 0) return { from: block.length, to: block.length };
  const close = block.indexOf("\n", open + 1);
  const line = block.slice(open + 1, close < 0 ? undefined : close);
  const from = open + 1 + (line.length - line.trimStart().length);
  return { from, to: from + line.trim().length };
}

/** Offset of the first character of the line containing `offset`. */
function startOfLine(text: string, offset: number): number {
  let i = Math.min(offset, text.length);
  while (i > 0 && text[i - 1] !== "\n") i--;
  return i;
}

/** The whitespace a line starts with. */
function lineIndent(text: string, offset: number): string {
  const from = startOfLine(text, offset);
  let i = from;
  while (text[i] === " " || text[i] === "\t") i++;
  return text.slice(from, i);
}

/** Indentation of a generated child: an existing statement's, or four past the root tag. */
function childIndent(text: string, xml: MapperXml): string {
  const first = xml.statements[0];
  return first ? lineIndent(text, first.at) : `${lineIndent(text, xml.bodyFrom)}    `;
}

/**
 * Inserting `method`'s statement into `text`: before the closing tag, or — for a
 * self-closed `<mapper/>`, which has no children yet — by opening it. Null when
 * the root has no end at all, which means the file is still being typed.
 */
export function statementInsertion(
  text: string,
  xml: MapperXml,
  method: MapperMethod,
  table: string,
): Placement | null {
  const block = statementXml(method, childIndent(text, xml), table);
  const rel = blockSelection(block);
  if (xml.closeAt >= 0) {
    const pad = startOfLine(text, xml.closeAt) === xml.closeAt ? "" : "\n";
    const at = xml.closeAt + pad.length;
    return {
      edit: { from: xml.closeAt, to: xml.closeAt, insert: `${pad}${block}\n` },
      from: at + rel.from,
      to: at + rel.to,
    };
  }
  if (text.slice(xml.bodyFrom - 2, xml.bodyFrom) !== "/>") return null;
  // The insert replaces `/>` with `>`, so the block starts two characters in.
  const at = xml.bodyFrom;
  return {
    edit: {
      from: xml.bodyFrom - 2,
      to: xml.bodyFrom,
      insert: `>\n${block}\n${lineIndent(text, xml.bodyFrom)}</mapper>`,
    },
    from: at + rel.from,
    to: at + rel.to,
  };
}

/** The three lines a mapper XML starts with. */
function mapperXmlHeader(qualifiedName: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
    `<mapper namespace="${qualifiedName}">`,
  ].join("\n");
}

/** The whole document for an interface that has no XML yet: write it into the empty file. */
export function newMapperXml(mapper: JavaMapper, method: MapperMethod, table: string): Placement {
  const header = `${mapperXmlHeader(mapper.qualifiedName)}\n`;
  const block = statementXml(method, "    ", table);
  const rel = blockSelection(block);
  return {
    edit: { from: 0, to: 0, insert: `${header}${block}\n</mapper>\n` },
    from: header.length + rel.from,
    to: header.length + rel.to,
  };
}

/** Where a new mapper XML goes: the resources twin of the interface folder, else beside the interface. */
export function mapperXmlPath(javaPath: string, qualifiedName: string): string {
  const parent = javaPath.slice(0, Math.max(javaPath.lastIndexOf("/"), 0));
  const dir = parent.replace(/(^|\/)src\/main\/java(?=$|\/)/, (_all, lead: string) => `${lead}src/main/resources`);
  const simpleName = qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);
  return `${dir}/${simpleName}.xml`;
}

const PARAM_IMPORT = "import org.apache.ibatis.annotations.Param;";

/** End of the line the `Param` import belongs after, or -1 for the file's start. */
function importAnchor(text: string): number {
  let end = -1;
  const imports = /^import\b[^\n]*;$/gm;
  let m: RegExpExecArray | null;
  while ((m = imports.exec(text))) end = m.index + m[0].length;
  if (end >= 0) return end;
  const pkg = /^package\b[^\n]*;$/m.exec(text);
  return pkg ? pkg.index + pkg[0].length : -1;
}

/**
 * One `@Param("name") ` per parameter that has none, plus the import the file
 * does not have yet. Offsets refer to `text`, so run this on the live document.
 */
export function paramEdits(text: string, method: MapperMethod): Edit[] {
  const missing = method.parameters.filter((p) => p.paramAnnotation === null);
  if (!missing.length) return [];
  const edits: Edit[] = missing.map((p) => ({ from: p.at, to: p.at, insert: `@Param("${p.name}") ` }));
  if (!/import\s+org\.apache\.ibatis\.annotations\.(?:Param|\*)\s*;/.test(text)) {
    const at = importAnchor(text);
    edits.push(
      at < 0 ? { from: 0, to: 0, insert: `${PARAM_IMPORT}\n` } : { from: at, to: at, insert: `\n${PARAM_IMPORT}` },
    );
  }
  return edits.sort((a, b) => a.from - b.from);
}

/** Enough in the file itself to offer creating an XML for an interface that has none. */
export function looksLikeMapper(mapper: JavaMapper): boolean {
  return (
    /(?:Mapper|Dao)$/.test(mapper.name) ||
    mapper.methods.some((m) => m.sqlAnnotation !== null || m.parameters.some((p) => p.paramAnnotation !== null))
  );
}

/** What each method of `mapper` could still be given. */
export function generations(mapper: JavaMapper, xml: Found<MapperXml> | null): Generation[] {
  if (!mapper.isInterface || (!xml && !looksLikeMapper(mapper))) return [];
  const out: Generation[] = [];
  for (const method of mapper.methods) {
    const bound = xml?.parsed.statements.some((s) => s.bindable && s.id === method.name) ?? false;
    const statement = method.sqlAnnotation === null && !bound;
    const params = method.parameters.length > 1 && !method.fullyAnnotated;
    if (statement || params) out.push({ line: method.line, name: method.name, statement, params });
  }
  return out;
}
