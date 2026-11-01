/**
 * mapper.xml parsing: the `<mapper namespace>` declaration and the four
 * statement tags (`select` / `insert` / `update` / `delete`) with their `id`
 * and position. Comments, CDATA, processing instructions and the DOCTYPE
 * (with its internal subset) are skipped, so SQL text containing `<select`
 * or `<!--` cannot fake a declaration; multi-line tags are handled.
 */
import { lineAt, lineStartsOf } from "./javaParse";

export type StatementTag = "select" | "insert" | "update" | "delete";

export interface XmlStatement {
  tag: StatementTag;
  id: string;
  /** 0-based line / col of the tag's `<`. */
  line: number;
  col: number;
}

export interface MapperXml {
  /** `null` when the file has no `<mapper namespace=…>` (not a mapper). */
  namespace: string | null;
  /** 0-based line of the `<mapper>` tag. */
  line: number;
  statements: XmlStatement[];
}

const STATEMENT_TAGS = new Set(["select", "insert", "update", "delete"]);

export function parseMapperXml(text: string): MapperXml {
  const out: MapperXml = { namespace: null, line: -1, statements: [] };
  const starts = lineStartsOf(text);
  let i = 0;
  let mapperDepth = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // DOCTYPE, possibly with an internal subset `[ … ]` holding `>`.
      let depth = 0;
      let k = lt + 2;
      for (; k < text.length; k++) {
        const c = text[k]!;
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth === 0) {
          k++;
          break;
        }
      }
      i = k;
      continue;
    }
    const tagMatch = /^<(\/?)([A-Za-z_][\w.-]*)/.exec(text.slice(lt));
    if (!tagMatch) {
      i = lt + 1;
      continue;
    }
    const closing = tagMatch[1] === "/";
    const name = tagMatch[2]!;
    // Tag end: `>` outside quotes (attributes may span lines).
    let k = lt + tagMatch[0].length;
    let quote = "";
    for (; k < text.length; k++) {
      const c = text[k]!;
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === ">") break;
    }
    if (k >= text.length) {
      i = lt + 1;
      continue;
    }
    const tagText = text.slice(lt, k + 1);
    if (closing) {
      if (name === "mapper") mapperDepth--;
      i = k + 1;
      continue;
    }
    if (name === "mapper") {
      mapperDepth++;
      const ns = /namespace\s*=\s*"([^"]*)"/.exec(tagText);
      out.namespace = ns?.[1] ?? null;
      out.line = lineAt(starts, lt);
    } else if (mapperDepth > 0 && STATEMENT_TAGS.has(name)) {
      const id = /id\s*=\s*"([^"]*)"/.exec(tagText);
      if (id) {
        const line = lineAt(starts, lt);
        out.statements.push({ tag: name as StatementTag, id: id[1]!, line, col: lt - starts[line]! });
      }
    }
    i = k + 1;
  }
  return out;
}

/** All statement ids of the four tags, in document order (duplicates kept). */
export function statementIds(xml: MapperXml): Set<string> {
  return new Set(xml.statements.map((s) => s.id));
}
