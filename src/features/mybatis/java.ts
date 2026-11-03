/**
 * Java side of a MyBatis mapper: the interface, its package, and the methods a
 * mapper.xml statement can bind to.
 *
 * Parsing runs on a mask (see `mask.ts`), so comments, string literals and text
 * blocks never contribute declarations. Each member of the type body is taken
 * on its own, its leading annotations are consumed first — including their
 * balanced argument lists, so `@Options(timeout = 5)` cannot be mistaken for
 * the method's own parameter list — and what is left has to look like a
 * declaration: `name(`, a matching `)`, then `;`, `throws` or a `default` body.
 *
 * Deliberately shallow: this resolves method names, parameter names and the
 * annotations that matter for binding and generation. It does not model
 * generics beyond what a signature literally contains, and it ignores anything
 * a mapper interface does not declare at its top level.
 */
import { blankOut, lineAt, scanJava, type MaskSource } from "./mask";

/** Annotations whose presence means the SQL lives in Java, not in mapper.xml. */
export const SQL_ANNOTATIONS = [
  "Select",
  "Insert",
  "Update",
  "Delete",
  "SelectProvider",
  "InsertProvider",
  "UpdateProvider",
  "DeleteProvider",
] as const;

/** Modifiers that may precede the return type of an interface method. */
const MODIFIERS = /^(?:public|abstract|default|static|final)\s+/;

export interface MapperParameter {
  name: string;
  /** The `@Param("value")` of this parameter, or null when it has none. */
  paramAnnotation: string | null;
}

export interface MapperMethod {
  name: string;
  /** UTF-16 offset of the method name; the gutter icon anchors on its line. */
  at: number;
  /** 0-based line of `at`. */
  line: number;
  /** Return type as written, with modifiers stripped (`List<User>`, `int`…). */
  returnType: string;
  parameters: MapperParameter[];
  /** Name of the SQL annotation on the method (`Select`), or null. */
  sqlAnnotation: string | null;
  /** True when every parameter is bindable by name (`@Param`, or a single parameter). */
  fullyAnnotated: boolean;
}

export interface JavaMapper {
  /** `com.example.mapper.UserMapper` — the namespace a mapper.xml must use. */
  qualifiedName: string;
  /** Simple type name. */
  name: string;
  /** Offset of the type name. */
  at: number;
  isInterface: boolean;
  methods: MapperMethod[];
}

/**
 * A MyBatis mapper interface, or null when `text` declares no type at all (not
 * Java, or an empty file). `mask` may come from `literalRanges` of an open
 * document; it is scanned from the text when omitted.
 */
export function parseJavaMapper(text: string, mask?: MaskSource): JavaMapper | null {
  const shadow = blankOut(text, mask ?? scanJava(text));
  const decl = findTypeDecl(shadow);
  if (!decl) return null;
  const pkg = /^\s*package\s+([\w.]+)/m.exec(shadow)?.[1] ?? "";
  const body = findBody(shadow, decl.bodyFrom);
  const methods: MapperMethod[] = [];
  for (const member of splitMembers(shadow, decl.bodyFrom, body)) {
    const parsed = parseMember(text, shadow, member, decl.name);
    if (parsed) methods.push(parsed);
  }
  return {
    qualifiedName: pkg ? `${pkg}.${decl.name}` : decl.name,
    name: decl.name,
    at: decl.nameAt,
    isInterface: decl.kind === "interface",
    methods,
  };
}

interface TypeDecl {
  kind: "interface" | "class";
  name: string;
  /** Offset of the type name. */
  nameAt: number;
  /** Offset of the `{` that opens the type body. */
  bodyFrom: number;
}

/**
 * First type declaration that is not an `@interface` — the `@` is matched and
 * rejected rather than excluded by a lookbehind, which WebKit < 16.4 lacks.
 */
function findTypeDecl(shadow: string): TypeDecl | null {
  const re = /@?\b(interface|class|enum|record)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(shadow))) {
    if (shadow[m.index] === "@") continue;
    const brace = shadow.indexOf("{", m.index);
    if (brace < 0) continue;
    return {
      kind: m[1] === "interface" ? "interface" : "class",
      name: m[2]!,
      nameAt: m.index + m[0].indexOf(m[2]!),
      bodyFrom: brace,
    };
  }
  return null;
}

/** Offset just past the `{}` block opened at `open`, honouring nesting. */
function findBody(shadow: string, open: number): number {
  let depth = 0;
  for (let i = open; i < shadow.length; i++) {
    const c = shadow[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return shadow.length;
}

/** Half-open `[from, to)` of each top-level member of a type body. */
interface Member {
  from: number;
  to: number;
}

/**
 * Top-level members between `from` and `to`: cut at a `;` and at the end of a
 * whole nested block, so a `default` method body or a nested type stays inside
 * its own member.
 */
function splitMembers(shadow: string, from: number, to: number): Member[] {
  const out: Member[] = [];
  let start = from + 1;
  let depth = 0;
  // A closed body's own `}` is not a member; an unterminated one (the file is
  // being typed) has no such terminator, so its last `;` still has to be seen.
  const stop = shadow[to - 1] === "}" ? to - 1 : to;
  for (let i = from + 1; i < stop; i++) {
    const c = shadow[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") {
        out.push({ from: start, to: i + 1 });
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      out.push({ from: start, to: i });
      start = i + 1;
    }
  }
  return out;
}

/**
 * The method a member declares, or null when the member is a constant, a
 * nested type, an import or anything else that is not a method signature.
 */
function parseMember(text: string, shadow: string, member: Member, typeName: string): MapperMethod | null {
  const annotations = readAnnotations(shadow, member.from, member.to);
  const head = annotations.at;
  const open = shadow.indexOf("(", head);
  if (open < 0 || open >= member.to) return null;
  const nameAt = lastIdentifier(shadow, head, open);
  if (nameAt < 0) return null;
  const name = shadow.slice(nameAt, open).trim();
  if (name === typeName) return null; // a constructor is never a statement
  const close = matchParen(shadow, open);
  if (close < 0 || close > member.to) return null;
  if (!startsDeclaration(shadow, close + 1, member.to)) return null;

  const parameters = readParameters(text, shadow, open + 1, close);
  const sql = annotations.names.find((n) => (SQL_ANNOTATIONS as readonly string[]).includes(n)) ?? null;
  return {
    name,
    at: nameAt,
    line: lineAt(text, nameAt),
    returnType: returnTypeOf(shadow, head, nameAt),
    parameters,
    sqlAnnotation: sql,
    fullyAnnotated: parameters.length <= 1 || parameters.every((p) => p.paramAnnotation !== null),
  };
}

/** Leading `@Name` / `@Name(...)` run of a member, and where it ends. */
function readAnnotations(shadow: string, from: number, to: number): { names: string[]; at: number } {
  const names: string[] = [];
  let i = from;
  for (;;) {
    i = skipSpace(shadow, i, to);
    if (shadow[i] !== "@") return { names, at: i };
    const at = skipIdentifier(shadow, i + 1);
    const name = shadow.slice(i + 1, at).trim();
    if (!name) return { names, at: i };
    names.push(name);
    const after = skipSpace(shadow, at, to);
    i = shadow[after] === "(" ? matchParen(shadow, after) + 1 : after;
  }
}

/** The parameter list of a signature, in declaration order. */
function readParameters(text: string, shadow: string, from: number, to: number): MapperParameter[] {
  const out: MapperParameter[] = [];
  for (const part of splitTopLevel(shadow, from, to)) {
    const paramAnnotation = readParamAnnotation(text, shadow, part);
    const nameAt = lastIdentifier(shadow, part.from, part.to);
    if (nameAt < 0) continue;
    out.push({ name: shadow.slice(nameAt, part.to).trim(), paramAnnotation });
  }
  return out;
}

/** `@Param("id")` of one parameter, taken from the original text. */
function readParamAnnotation(text: string, shadow: string, part: { from: number; to: number }): string | null {
  const re = /@Param\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(shadow.slice(part.from, part.to)))) {
    const open = part.from + m.index + m[0].length - 1;
    const close = matchParen(shadow, open);
    if (close < 0) continue;
    const value = /"([^"]*)"/.exec(text.slice(open, close));
    if (value) return value[1]!;
  }
  return null;
}

/** The return type as written: everything before the method name, minus modifiers. */
function returnTypeOf(shadow: string, from: number, nameAt: number): string {
  let out = shadow.slice(from, nameAt).trim();
  while (MODIFIERS.test(out)) out = out.replace(MODIFIERS, "");
  return out.replace(/\s+/g, " ").trim();
}

/** After `)`: a declaration ends in `;`, a body or a `throws` clause. */
function startsDeclaration(shadow: string, from: number, to: number): boolean {
  const i = skipSpace(shadow, from, to);
  const c = shadow[i];
  if (c === ";" || c === "{") return true;
  return shadow.startsWith("throws", i) && /[A-Za-z_$\s]/.test(shadow[i + 6] ?? " ");
}

/** Offsets of the comma-separated parts of a list, ignoring nested brackets. */
function splitTopLevel(shadow: string, from: number, to: number): { from: number; to: number }[] {
  const parts: { from: number; to: number }[] = [];
  let start = from;
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = shadow[i] ?? "";
    if ("(<[".includes(c)) depth++;
    else if (")>]".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push({ from: start, to: i });
      start = i + 1;
    }
  }
  if (shadow.slice(start, to).trim()) parts.push({ from: start, to });
  return parts;
}

/** Offset of the identifier that ends `text[from, to)`, or -1. */
function lastIdentifier(shadow: string, from: number, to: number): number {
  const slice = shadow.slice(from, to);
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(slice);
  return m ? from + slice.lastIndexOf(m[1]!) : -1;
}

/** Offset of the `)` that closes the `(` at `open`, or -1 when unbalanced. */
function matchParen(shadow: string, open: number): number {
  let depth = 0;
  for (let i = open; i < shadow.length; i++) {
    if (shadow[i] === "(") depth++;
    else if (shadow[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function skipSpace(s: string, i: number, to: number): number {
  while (i < to && /\s/.test(s[i]!)) i++;
  return i;
}

function skipIdentifier(s: string, i: number): number {
  while (i < s.length && /[\w$.]/.test(s[i]!)) i++;
  return i;
}
