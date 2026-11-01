/**
 * Java mapper interface parsing (text-based, no language server): package,
 * imports, the interface / class and its method signatures — parameters with
 * types and annotations, varargs, generics, multi-line signatures.
 *
 * The document is scanned with comments and string literals masked (spaces,
 * newlines kept), so offsets map 1:1 to the real text and body statements or
 * string contents cannot fake declarations. A method candidate must sit
 * between declaration boundaries (`;`, `{`, `}`) and carry a return type
 * before its name, which rules out call expressions and enum constants.
 *
 * shortcut: no full Java parser — pathologically formatted signatures may be
 * missed, and methods inherited from a parent interface are not resolved.
 */

export type MethodKind = "select" | "insert" | "update" | "delete";

export type SqlAnnotation = "Select" | "Insert" | "Update" | "Delete";

export interface JavaParam {
  /** Type text with generics, e.g. `List<String>`; `final` and annotations stripped. */
  type: string;
  /** Declared parameter name. */
  name: string;
  /** XML binding name: the `@Param` value when annotated, else `name`. */
  binding: string;
  /** The parameter already carries `@Param("…")`. */
  hasParam: boolean;
  /** A `@Param` / `@Param()` without a value, ready to fill with the name. */
  emptyParamAt: { from: number; to: number } | null;
  /** Offset of the parameter's first non-space character (annotation insert point). */
  start: number;
}

export interface MapperMethod {
  name: string;
  /** 0-based line / UTF-16 col of the identifier. */
  line: number;
  col: number;
  /** Statement kind for XML generation; null for annotation-SQL methods. */
  kind: MethodKind | null;
  /** `@Select` / `@Insert` / `@Update` / `@Delete` on the method, when present. */
  sqlAnnotation: SqlAnnotation | null;
  /** 0-based line of the SQL annotation, for jumping. */
  annotationLine: number;
  /** Raw return-type text, e.g. `List<User>` or `void`. */
  returnType: string;
  /** Simple (possibly qualified) element type for `resultType`; null when unknown. */
  resultSimple: string | null;
  params: JavaParam[];
  /** `default` / `static` methods take no XML statement. */
  defaultMethod: boolean;
  /** Signature span: first char to the terminating `;` / `{` (exclusive). */
  span: { from: number; to: number };
  /** Display extent: from the previous member's end (annotations included) to `span.to`. */
  extent: { from: number; to: number };
}

export interface JavaImports {
  /** Simple name → FQN (`import a.b.User;`). */
  exact: Map<string, string>;
  /** Packages from `import a.b.*;`. */
  wildcards: string[];
}

export interface MapperInterface {
  name: string;
  pkg: string;
  fqn: string;
  kind: "interface" | "class";
  /** 0-based line of the type declaration. */
  line: number;
  /** Whole type body span (declaration to closing `}`). */
  span: { from: number; to: number };
  hasMapperAnnotation: boolean;
  methods: MapperMethod[];
  imports: JavaImports;
}

// ---------------------------------------------------------------------------
// Masking

/** Comments and string literals replaced by spaces; newlines and offsets kept. */
export function maskJava(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const c = out[k]!;
      if (c !== "\n" && c !== "\r") out[k] = " ";
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === c) {
          j++;
          break;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < text.length && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      let j = i + 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j = Math.min(j + 2, text.length);
      blank(i, j);
      i = j;
    } else i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Top-level type

const TYPE_RE = /(?<!@)\b(interface|class|enum|record)\s+([A-Za-z_$][\w$]*)/g;

interface TypeDecl {
  kind: "interface" | "class";
  name: string;
  at: number;
  bodyFrom: number;
  bodyTo: number;
}

function findTypeDecl(masked: string): TypeDecl | null {
  TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPE_RE.exec(masked))) {
    const kind = m[1] === "interface" ? "interface" : "class";
    const name = m[2]!;
    const at = m.index;
    // Body open: first `{` with `()[]{}` depths at zero (annotation args may
    // carry braces: `@Foo({1,2})`). Generic angles don't affect `{` placement.
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let bodyFrom = -1;
    for (let k = at + m[0].length; k < masked.length; k++) {
      const ch = masked[k]!;
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (ch === "[") bracket++;
      else if (ch === "]") bracket = Math.max(0, bracket - 1);
      else if (ch === "{") {
        if (paren === 0 && bracket === 0 && brace === 0) {
          bodyFrom = k;
          break;
        }
        brace++;
      } else if (ch === "}") brace = Math.max(0, brace - 1);
      else if (ch === ";") return null; // stray semicolon before the body
    }
    if (bodyFrom < 0) return null;
    // Body close: brace depth back to zero.
    let depth = 0;
    let bodyTo = -1;
    for (let k = bodyFrom; k < masked.length; k++) {
      const ch = masked[k]!;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          bodyTo = k + 1;
          break;
        }
      }
    }
    if (bodyTo < 0) return null;
    return { kind, name, at, bodyFrom, bodyTo };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Imports, annotations

function collectImports(masked: string): JavaImports {
  const exact = new Map<string, string>();
  const wildcards: string[] = [];
  const re = /^\s*import\s+(static\s+)?([\w.*]+)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (m[1]) continue; // static imports
    const fqn = m[2]!;
    if (fqn.endsWith(".*")) wildcards.push(fqn.slice(0, -2));
    else exact.set(fqn.slice(fqn.lastIndexOf(".") + 1), fqn);
  }
  return { exact, wildcards };
}

/** Whether `@name` (optionally qualified, e.g. `@org.apache.ibatis.annotations.Mapper`) annotates the declaration at `at`. */
function annotatedWith(masked: string, declAt: number, name: string): boolean {
  const from = masked.lastIndexOf("}", declAt) + 1;
  const chunk = masked.slice(from, declAt);
  return new RegExp(`@(?:[\\w.]+\\.)?${name}\\b`).test(chunk);
}

const SQL_ANNOTATION = /@(?:[\w.]+\.)?(Select|Insert|Update|Delete)\b/;

/** 0-based line of `offset`. */
export function lineAt(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Methods

const JAVA_ID = /[A-Za-z_$][\w$]*/;

/** Matches the `(` closing the parameter list opened at `openAt` (depths over `()<>[]{}`). */
function matchParen(masked: string, openAt: number): number {
  let depth = 0;
  for (let k = openAt; k < masked.length; k++) {
    const ch = masked[k]!;
    if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === ">" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Annotation-prefix strip (balanced parens, so `@Foo(a, (b))` works). */
function stripAnnotations(seg: string): string {
  return seg.replace(/@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?/g, " ");
}

const MODIFIERS =
  /\b(public|protected|private|static|final|abstract|default|native|synchronized|strictfp|transient|volatile|new|throws)\b/g;

/** Declaration prefix between the boundary and the method name: annotations, modifiers, return type. */
function returnTypeOf(prefix: string): string {
  let p = stripAnnotations(prefix).replace(MODIFIERS, " ").replace(/\s+/g, " ").trim();
  // Leading method type parameters (`<T> T select(T t)`); return types never start with `<`.
  while (p.startsWith("<")) {
    let depth = 0;
    let close = -1;
    for (let k = 0; k < p.length; k++) {
      const ch = p[k]!;
      if (ch === "<") depth++;
      else if (ch === ">") {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) break;
    p = p.slice(close + 1).trim();
  }
  return p;
}

interface MethodSpan {
  name: string;
  nameAt: number;
  parenOpen: number;
  parenClose: number;
  sigStart: number;
  sigEnd: number;
}

/** Declaration positions of the interface's methods, in document order. */
function findMethodSpans(masked: string, decl: TypeDecl): MethodSpan[] {
  const out: MethodSpan[] = [];
  const re = new RegExp(`(${JAVA_ID.source})\\s*\\(`, "g");
  re.lastIndex = decl.bodyFrom;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) && m.index < decl.bodyTo) {
    const name = m[1]!;
    const nameAt = m.index;
    // The char before the name is whitespace, `>` or a boundary (`{`, `;`)
    // (`List<User> select`, not `list.add` or a body-internal call).
    const before = masked[nameAt - 1];
    if (nameAt > 0 && before !== undefined && !/[\s>{;]/.test(before)) continue;
    // Walk back to the previous declaration boundary (depth 0 of `{}`): a
    // `}` at depth 0 closes the previous method body.
    let depth = 0;
    let boundary = decl.bodyFrom;
    for (let k = nameAt - 1; k > decl.bodyFrom; k--) {
      const ch = masked[k]!;
      if (ch === "}") {
        if (depth === 0) {
          boundary = k;
          break;
        }
        depth++;
      } else if (ch === "{") {
        if (depth === 0) {
          boundary = k;
          break;
        }
        depth--;
      } else if (ch === ";" && depth === 0) {
        boundary = k;
        break;
      }
    }
    const segment = masked.slice(boundary + 1, nameAt);
    const cleaned = stripAnnotations(segment);
    if (!/[\w$]/.test(cleaned)) continue; // bare call / constant, e.g. `RED(1),`
    if (/[^A-Za-z0-9_$\s<>[\].,?]/.test(cleaned)) continue; // statements, `=` etc.
    if (/\.\s*$/.test(cleaned)) continue; // `list.add(` — receiver dot
    const rt = returnTypeOf(cleaned);
    if (!rt) continue; // only annotations / keywords (`new`, `for`) — a call
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchParen(masked, parenOpen);
    if (parenClose < 0) continue;
    // Signature end: after `)` comes `;`, `{`, or `throws …`.
    let k = parenClose + 1;
    let sigEnd = -1;
    while (k < masked.length) {
      const ch = masked[k]!;
      if (ch === ";") {
        sigEnd = k + 1;
        break;
      }
      if (ch === "{") {
        sigEnd = k;
        break;
      }
      if (!/\s/.test(ch)) break; // something unexpected
      k++;
    }
    if (sigEnd < 0) continue;
    const sigStart = boundary + 1;
    out.push({ name, nameAt, parenOpen, parenClose, sigStart, sigEnd });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parameters

/** Top-level comma positions (depths over `()<>[]{}`) within `( … )`. */
function splitParams(masked: string, from: number, to: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const ch = masked[k]!;
    if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === ">" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push({ from: start, to: k });
      start = k + 1;
    }
  }
  if (start < to) out.push({ from: start, to });
  return out;
}

const PARAM_ANNOTATION = /@(?:[\w.]+\.)?Param\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
/** `@Param` written without a value: bare or with empty parens (the space inside the paren group). */
const EMPTY_PARAM = /@(?:[\w.]+\.)?Param(\s*\(\s*\))?/;

function parseParam(text: string, from: number, to: number): JavaParam | null {
  const raw = text.slice(from, to);
  const segStart = from + (raw.length - raw.trimStart().length);
  let seg = raw.trim();
  if (!seg) return null;
  const paramMatch = PARAM_ANNOTATION.exec(seg);
  let emptyParamAt: { from: number; to: number } | null = null;
  if (!paramMatch) {
    const empty = EMPTY_PARAM.exec(seg);
    if (empty) emptyParamAt = { from: segStart + empty.index, to: segStart + empty.index + empty[0].length };
  }
  seg = stripAnnotations(seg)
    .replace(/\bfinal\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!seg) return null;
  // Array brackets after the name (`String args[]`) belong to the type.
  let arraySuffix = "";
  const arrayMatch = /(\s*\[\s*\])+\s*$/.exec(seg);
  if (arrayMatch) {
    arraySuffix = arrayMatch[1]!;
    seg = seg.slice(0, seg.length - arrayMatch[0].length).trimEnd();
  }
  const nameMatch = /([A-Za-z_$][\w$]*)\s*$/.exec(seg);
  if (!nameMatch) return null;
  const name = nameMatch[1]!;
  let type = seg.slice(0, seg.length - nameMatch[0].length).trim();
  // Varargs: `String... ids` → `String`.
  type = type.replace(/\.{3}\s*$/, "").trim();
  type = (type + arraySuffix.replace(/\s+/g, "")).trim();
  if (!type) return null;
  return {
    type,
    name,
    binding: paramMatch ? paramMatch[1]!.replace(/\\./g, (c) => c[1] ?? c) : name,
    hasParam: !!paramMatch,
    emptyParamAt,
    start: segStart,
  };
}

// ---------------------------------------------------------------------------
// Return types

const JAVA_LANG = new Set([
  "String",
  "Object",
  "Boolean",
  "Byte",
  "Short",
  "Integer",
  "Long",
  "Float",
  "Double",
  "Character",
  "Void",
  "Number",
  "Math",
  "Enum",
  "Class",
  "Iterable",
  "Comparable",
]);

const COUNT_SCALARS = new Set([
  "boolean",
  "Boolean",
  "int",
  "Integer",
  "long",
  "Long",
  "short",
  "Short",
  "byte",
  "Byte",
]);

const COLLECTION_RE =
  /^(?:java\.util\.)?(?:List|Collection|Set|Iterable|ArrayList|LinkedList|HashSet|LinkedHashSet|TreeSet|Queue|Deque)<\s*([\w$]+(?:\.[\w$]+)*)\s*>$/;
const OPTIONAL_RE = /^(?:java\.util\.)?Optional<\s*([\w$]+(?:\.[\w$]+)*)\s*>$/;
const ARRAY_RE = /^([\w$]+(?:\.[\w$]+)*)\[\]$/;

/** Element type for `resultType` (`User` for `List<User>`), null when unknown. */
export function resultElement(returnType: string): string | null {
  const rt = returnType.trim();
  const m = COLLECTION_RE.exec(rt) ?? OPTIONAL_RE.exec(rt) ?? ARRAY_RE.exec(rt);
  if (m) return m[1]!;
  if (/^(?:java\.util\.)?Map\b/.test(rt)) return null;
  if (/^(?:void|boolean|Boolean|int|Integer|long|Long|short|Short|byte|Byte|float|Float|double|Double)$/.test(rt))
    return null;
  // Direct entity / scalar: strip generics, keep possible FQN.
  return rt.replace(/<.*>\s*$/, "").trim();
}

const P_SELECT = /^(select|find|get|query|list|search|load|count|exists|is|has)/;
const P_INSERT = /^(insert|save|add|create|persist)/;
const P_UPDATE = /^(update|modify|edit|change|merge|refresh)/;
const P_DELETE = /^(delete|remove|drop|clear)/;

/**
 * Statement kind by the method's return type, refined by the name prefix where
 * the type alone is ambiguous (`void` and the int/long/boolean counts).
 */
export function inferKind(name: string, returnType: string, sqlAnnotation: SqlAnnotation | null): MethodKind | null {
  if (sqlAnnotation) return null;
  const lower = name.toLowerCase();
  const simple = returnType.replace(/<.*>\s*$/, "").trim();
  const isVoid = simple === "void";
  const isCount = COUNT_SCALARS.has(simple);
  if (isVoid) {
    if (P_INSERT.test(lower)) return "insert";
    if (P_DELETE.test(lower)) return "delete";
    return "update";
  }
  if (isCount) {
    if (P_DELETE.test(lower)) return "delete";
    if (P_INSERT.test(lower)) return "insert";
    if (P_UPDATE.test(lower)) return "update";
    if (P_SELECT.test(lower)) return "select";
    return "update";
  }
  return "select";
}

/** Resolves a simple name against imports, `java.lang`, then the same package; else the simple name. */
export function resolveType(simple: string, iface: MapperInterface): string {
  if (!simple) return "";
  if (simple.includes(".")) return simple;
  const exact = iface.imports.exact.get(simple);
  if (exact) return exact;
  if (JAVA_LANG.has(simple)) return `java.lang.${simple}`;
  // Wildcard imports: the package is unknown, so a same-package guess would
  // be wrong; the caller emits the simple name with a TODO.
  if (iface.imports.wildcards.length) return simple;
  if (iface.pkg) return `${iface.pkg}.${simple}`;
  return simple;
}

// ---------------------------------------------------------------------------
// Main entry

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

export function parseMapperInterface(text: string): MapperInterface | null {
  const masked = maskJava(text);
  const starts = lineStartsOf(masked);
  const decl = findTypeDecl(masked);
  if (!decl) return null;
  const pkgMatch = /^\s*package\s+([\w.]+)\s*;/m.exec(masked);
  const pkg = pkgMatch?.[1] ?? "";
  const fqn = pkg ? `${pkg}.${decl.name}` : decl.name;
  const hasMapperAnnotation = annotatedWith(masked, decl.at, "Mapper");
  const methods: MapperMethod[] = [];
  for (const span of findMethodSpans(masked, decl)) {
    const maskedSig = masked.slice(span.sigStart, span.sigEnd);
    const sqlMatch = SQL_ANNOTATION.exec(maskedSig);
    const sqlAnnotation = (sqlMatch?.[1] as SqlAnnotation | undefined) ?? null;
    let annotationLine = -1;
    if (sqlMatch) {
      const at = span.sigStart + sqlMatch.index;
      annotationLine = lineAt(starts, at);
    }
    const returnType = returnTypeOf(masked.slice(span.sigStart, span.nameAt));
    const defaultMethod = /\b(default|static)\b/.test(maskedSig);
    const params: JavaParam[] = [];
    for (const p of splitParams(masked, span.parenOpen + 1, span.parenClose)) {
      const param = parseParam(text, p.from, p.to);
      if (param) params.push(param);
    }
    const line = lineAt(starts, span.nameAt);
    const prev = methods[methods.length - 1];
    methods.push({
      name: span.name,
      line,
      col: span.nameAt - starts[line]!,
      kind: inferKind(span.name, returnType, sqlAnnotation),
      sqlAnnotation,
      annotationLine,
      returnType,
      resultSimple: resultElement(returnType),
      params,
      defaultMethod,
      span: { from: span.sigStart, to: span.sigEnd },
      extent: { from: prev ? prev.span.to : decl.bodyFrom, to: span.sigEnd },
    });
  }
  return {
    name: decl.name,
    pkg,
    fqn,
    kind: decl.kind,
    line: lineAt(starts, decl.at),
    span: { from: decl.at, to: decl.bodyTo },
    hasMapperAnnotation,
    methods,
    imports: collectImports(masked),
  };
}

/** The method whose display extent covers `offset` (annotations included), if any. */
export function methodAt(iface: MapperInterface, offset: number): MapperMethod | null {
  return iface.methods.find((m) => offset >= m.extent.from && offset < m.extent.to) ?? null;
}

/** Whether `offset` lies inside the type body. */
export function inType(iface: MapperInterface, offset: number): boolean {
  return offset >= iface.span.from && offset < iface.span.to;
}
