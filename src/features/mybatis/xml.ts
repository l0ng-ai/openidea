/**
 * XML side of a MyBatis mapper: the `namespace` of the `<mapper>` root and the
 * statements declared directly under it.
 *
 * Structure is read from a mask (see `mask.ts`), so a `<select>` written inside
 * an XML comment or a CDATA block cannot be mistaken for a real statement, and
 * a `>` or a `<` inside an attribute value cannot end a tag early. The mask
 * keeps every offset, so attribute *values* are taken from the original text.
 *
 * Deliberately shallow: only the root namespace and its direct children are
 * modelled. `<include refid>`, cross-file `resultMap` references and type
 * aliases are out of scope — they need the statement graph, not this index.
 */
import { blankOut, lineAt, scanXml, type MaskSource } from "./mask";

/** Tags that a mapper interface method can bind to. */
export const BINDING_TAGS = ["select", "insert", "update", "delete"] as const;

/** `<sql>` fragments share an `id` with the statements but bind to nothing. */
export const STATEMENT_TAGS: readonly string[] = [...BINDING_TAGS, "sql"];

export interface XmlStatement {
  id: string;
  /** Element name as written (`select`, `insert`, …). */
  tag: string;
  /** Offset of the opening tag; the gutter icon anchors on its line. */
  at: number;
  /** 0-based line of the opening tag. */
  line: number;
  /** 0-based line of the closing tag (same line for a self-closed element). */
  endLine: number;
  /** False for `<sql>` fragments. */
  bindable: boolean;
}

export interface MapperXml {
  /** The `namespace` attribute, i.e. the qualified name of the Java interface. */
  namespace: string;
  /** Offset of the namespace value, for jumping from the root line. */
  namespaceAt: number;
  /** Offset just past the root tag's `>` — past its `/>` when the root is self-closed. */
  bodyFrom: number;
  /** Offset of the `<` of `</mapper>`, or -1 for a self-closed or unterminated root. */
  closeAt: number;
  statements: XmlStatement[];
}

/** A mapper XML file, or null when it has no `<mapper>` root. */
export function parseMapperXml(text: string, mask?: MaskSource): MapperXml | null {
  const shadow = blankOut(text, mask ?? scanXml(text));
  const tags = scanTags(shadow);
  const root = tags.find((t) => !t.closing && t.name === "mapper");
  if (!root) return null;
  return {
    namespace: attrValue(text, root.from, root.contentEnd, "namespace") ?? "",
    namespaceAt: attrValueAt(text, root.from, root.contentEnd, "namespace"),
    bodyFrom: root.to,
    closeAt: root.selfClosed
      ? -1
      : (tags.find((t) => t.closing && t.name === "mapper" && t.from >= root.to)?.from ?? -1),
    statements: readStatements(text, tags, root),
  };
}

/** Direct children of the root that are statements, with their line spans. */
function readStatements(text: string, tags: Tag[], root: Tag): XmlStatement[] {
  const out: XmlStatement[] = [];
  /** Open elements waiting for their close tag; `level` counts depth below `<mapper>`. */
  const stack: { tag: Tag; level: number }[] = [{ tag: root, level: 0 }];
  for (const tag of tags) {
    if (tag.to <= root.to) continue;
    if (tag.closing) {
      const open = stack[stack.length - 1];
      if (!open || open.tag.name !== tag.name) continue;
      stack.pop();
      if (open.level !== 1) continue;
      const statement = statementOf(text, open.tag);
      if (statement) out.push({ ...statement, endLine: lineAt(text, tag.from) });
      continue;
    }
    const level = stack.length;
    if (tag.selfClosed) {
      if (level === 1) {
        const statement = statementOf(text, tag);
        if (statement) out.push({ ...statement, endLine: lineAt(text, tag.from) });
      }
      continue;
    }
    stack.push({ tag, level });
  }
  return out;
}

/** A statement record for an open tag, or null when it is not one or has no id. */
function statementOf(text: string, tag: Tag): Omit<XmlStatement, "endLine"> | null {
  if (!STATEMENT_TAGS.includes(tag.name)) return null;
  const id = attrValue(text, tag.from, tag.contentEnd, "id");
  if (!id) return null;
  return {
    id,
    tag: tag.name,
    at: tag.nameAt,
    line: lineAt(text, tag.from),
    bindable: (BINDING_TAGS as readonly string[]).includes(tag.name),
  };
}

interface Tag {
  name: string;
  /** Offset of the element name inside the tag. */
  nameAt: number;
  /** Offset of the tag start (`<`). */
  from: number;
  /** Offset just past the tag end (`>`). */
  to: number;
  /** Offset of the end of the tag's own text (`/` or `>` before `to`). */
  contentEnd: number;
  closing: boolean;
  selfClosed: boolean;
}

/**
 * Every tag token of the masked text, in order. Operates on the mask, so the
 * attribute values inside a tag are blank and only the tag shape counts.
 */
function scanTags(shadow: string): Tag[] {
  const out: Tag[] = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(shadow))) {
    const body = m[3] ?? "";
    const selfClosed = body.trimEnd().endsWith("/");
    out.push({
      name: m[2]!,
      nameAt: m.index + 1 + m[1]!.length,
      from: m.index,
      to: m.index + m[0].length,
      contentEnd: m.index + m[0].length - (selfClosed ? 2 : 1),
      closing: m[1] === "/",
      selfClosed,
    });
  }
  return out;
}

/** The `name="value"` of a tag, read from the original text. */
function attrValue(text: string, from: number, to: number, name: string): string | null {
  const at = attrValueAt(text, from, to, name);
  if (at < 0) return null;
  const quote = text[at]!;
  const end = text.indexOf(quote, at + 1);
  return end < 0 ? null : text.slice(at + 1, end);
}

/** Offset of the opening quote of an attribute value, or -1. */
function attrValueAt(text: string, from: number, to: number, name: string): number {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']`, "g");
  const m = re.exec(text.slice(from, to));
  return m ? from + m.index + m[0].length - 1 : -1;
}
