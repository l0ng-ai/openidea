/**
 * MyBatis code generation: statement XML from a mapper method, a full
 * mapper.xml from an interface, `@Param` insertion plans and the import edit.
 * All pure; the callers apply the edits (editor transaction) or write the
 * file (`fsCreateFileBytes`).
 */
import type { JavaParam, MapperInterface, MapperMethod } from "./javaParse";
import { resolveType } from "./javaParse";

const IND = "    "; // statements indent 4 spaces (MyBatisX convention)

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

const COLLECTION_TYPES =
  /^(?:java\.util\.)?(?:List|Collection|Set|Iterable|ArrayList|LinkedList|HashSet|LinkedHashSet|TreeSet|Queue|Deque)(?:<|$)/;

/** `#{…}` references for the TODO comment: multi-params, `#{list}` for a single collection. */
function refsHint(params: readonly JavaParam[]): string {
  if (params.length === 0) return "";
  if (params.length === 1) {
    const p = params[0]!;
    const collection = COLLECTION_TYPES.test(p.type) || /\[\]$/.test(p.type);
    return collection ? "; params: #{list}" : "";
  }
  return `; params: ${params.map((p) => `#{${p.binding}}`).join(", ")}`;
}

/** `resultType` for a select: the element type, a count scalar, or null (TODO). */
function resultTypeOf(m: MapperMethod, iface: MapperInterface): string | null {
  if (m.kind !== "select") return null;
  if (m.resultSimple) return resolveType(m.resultSimple, iface);
  const simple = m.returnType.replace(/<.*>\s*$/, "").trim();
  // Count scalars (`long count()`, `boolean exists()`): the type itself is the result.
  if (/^(boolean|int|long|short|byte)$/.test(simple)) return simple;
  if (/^(Boolean|Integer|Long|Short|Byte)$/.test(simple)) return resolveType(simple, iface);
  return null; // Map or unresolved generics: leave for a resultMap
}

/** `parameterType` for the single parameter; primitives and arrays kept as-is. */
function parameterTypeOf(p: JavaParam, iface: MapperInterface): string {
  const base = p.type.replace(/<.*>\s*$/, "").trim();
  const array = /\[\]$/.test(base);
  const simple = array ? base.slice(0, -2) : base;
  const resolved = resolveType(simple, iface);
  return array ? `${resolved}[]` : resolved;
}

const DOTLESS_SCALARS = /^(boolean|int|long|short|byte)$/;

export function statementXml(m: MapperMethod, iface: MapperInterface): string {
  const kind = m.kind ?? "select";
  const attrs: string[] = [];
  const rt = resultTypeOf(m, iface);
  if (rt) attrs.push(`resultType="${rt}"`);
  let pt: string | null = null;
  if (m.params.length === 1) {
    pt = parameterTypeOf(m.params[0]!, iface);
    attrs.push(`parameterType="${pt}"`);
  }
  const attrText = attrs.length ? ` ${attrs.join(" ")}` : "";
  const hint = refsHint(m.params);
  const body = `<!-- TODO: write ${kind.toUpperCase()}${hint} -->`;
  const lines = [`<${kind} id="${m.name}"${attrText}>`, `${IND}${body}`];
  if (kind === "insert")
    lines.push(`${IND}<!-- TODO: add useGeneratedKeys="true" keyProperty="id" to return generated keys -->`);
  // Simple names without a known import are not valid MyBatis types (no
  // alias resolution): flag them instead of guessing.
  if ([rt, pt].some((t) => t && !t.includes(".") && !DOTLESS_SCALARS.test(t)))
    lines.push(`${IND}<!-- TODO: use a fully qualified type (unresolved import) -->`);
  lines.push(`</${kind}>`);
  return lines.map((l) => IND + l).join("\n");
}

export function mapperXmlContent(iface: MapperInterface): string {
  const stmts = iface.methods.filter((m) => m.kind && !m.defaultMethod);
  const body = stmts.map((m) => statementXml(m, iface)).join("\n\n");
  const header =
    `<?xml version="1.0" encoding="UTF-8" ?>\n` +
    `<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n` +
    `<mapper namespace="${iface.fqn}">`;
  return `${header}\n\n${body ? `${body}\n` : ""}</mapper>\n`;
}

/** Where a generated statement goes: before `</mapper>`, else the end of the file. */
export function appendStatementEdit(xmlText: string, stmtXml: string): TextEdit {
  const close = xmlText.lastIndexOf("</mapper>");
  if (close >= 0) {
    const prefix = close > 0 && xmlText[close - 1] === "\n" ? "" : "\n";
    return { from: close, to: close, insert: `${stmtXml}\n\n${prefix}` };
  }
  const prefix = xmlText.endsWith("\n") ? "" : "\n";
  return { from: xmlText.length, to: xmlText.length, insert: `${prefix}${stmtXml}\n` };
}

// ---------------------------------------------------------------------------
// @Param

/**
 * `@Param` edits for `scope` (one method) or the whole interface: a written
 * `@Param` / `@Param()` without a value is filled with the parameter name,
 * and multi-parameter methods get `@Param("name") ` before every parameter
 * that has none (single-parameter methods need no annotation in MyBatis).
 */
export function paramAnnotationEdits(iface: MapperInterface, scope: MapperMethod | null): TextEdit[] {
  const methods = scope ? [scope] : iface.methods;
  const edits: TextEdit[] = [];
  for (const m of methods) {
    for (const p of m.params) {
      if (p.hasParam) continue;
      if (p.emptyParamAt) {
        edits.push({ from: p.emptyParamAt.from, to: p.emptyParamAt.to, insert: `@Param("${p.name}")` });
      } else if (m.params.length >= 2) {
        edits.push({ from: p.start, to: p.start, insert: `@Param("${p.name}") ` });
      }
    }
  }
  return edits;
}

const IMPORT_RE = /^\s*import\s+[\w.]+\s*;$/gm;

/** Inserts the `org.apache.ibatis.annotations.Param` import; null when present. */
export function importEdit(text: string): TextEdit | null {
  if (/^\s*import\s+(?:[\w.]+\.)?Param\s*;/m.test(text)) return null;
  let last = -1;
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) last = m.index + m[0].length;
  if (last >= 0) {
    const eol = /^\r?\n/.exec(text.slice(last))?.[0] ?? "\n";
    return { from: last, to: last, insert: `${eol}import org.apache.ibatis.annotations.Param;` };
  }
  const pkg = /^\s*package\s+[\w.]+\s*;\r?\n/m.exec(text);
  if (pkg)
    return {
      from: pkg.index + pkg[0].length,
      to: pkg.index + pkg[0].length,
      insert: "\nimport org.apache.ibatis.annotations.Param;",
    };
  return { from: 0, to: 0, insert: "import org.apache.ibatis.annotations.Param;\n\n" };
}

/** Applies non-overlapping edits (descending order). */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

// ---------------------------------------------------------------------------
// Spring mapper-locations

/**
 * Directory patterns of Spring's `mybatis.mapper-locations`
 * (`classpath:mapper/*.xml` → `mapper`), from an application.yml /
 * application.properties text. Backslashes normalize to `/` (Windows configs).
 */
export function mapperLocationDirs(configText: string): string[] {
  const out: string[] = [];
  for (const line of configText.split(/\r?\n/)) {
    const m = /mapper-locations\s*[:=]\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[1]!.replace(/\s+#.*$/, "").trim();
    if (!value) continue;
    for (const part of value.split(",")) {
      let v = part
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\\/g, "/");
      v = v.replace(/^classpath\*?:/, "").replace(/^\/+/, "");
      const star = v.search(/[*?]/);
      const dir = (star < 0 ? v : v.slice(0, star)).replace(/\/+$/, "");
      out.push(dir);
    }
  }
  return [...new Set(out)];
}
