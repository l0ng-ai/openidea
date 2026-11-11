/**
 * Per-language declaration templates and literal typing for the syntax-only
 * Introduce Variable / Constant. Only what is certain from the text: no type
 * inference beyond literals and plain constructor calls.
 */

const TS_JS = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);

export function isTsJs(language: string): boolean {
  return TS_JS.has(language);
}

/** Facts about the project / file a template depends on. */
export interface DeclContext {
  /** Java: language level ≥ 10 (`var`). */
  javaVar?: boolean;
  /** C: C23 (`auto`). */
  cAuto?: boolean;
  /** TS/JS: the file ends statements with `;`. */
  semicolons?: boolean;
  /** Explicit type for languages that need one (Java without `var`, C without `auto`). */
  type?: string | null;
}

export interface Declaration {
  text: string;
  /** Offset of the variable name within `text`. */
  nameOffset: number;
  /** How occurrences refer to the variable (`$name` in PHP). */
  reference: string;
  /** Offset of the name within `reference`. */
  referenceNameOffset: number;
  /** `text` ends with a statement terminator. */
  terminated: boolean;
}

export type DeclResult = { ok: true; decl: Declaration } | { ok: false; reason: string };

function build(prefix: string, name: string, middle: string, suffix: string, sigil = ""): Declaration {
  return {
    text: `${prefix}${sigil}${name}${middle}${suffix}`,
    nameOffset: prefix.length + sigil.length,
    reference: `${sigil}${name}`,
    referenceNameOffset: sigil.length,
    terminated: suffix.endsWith(";"),
  };
}

/** `T name` with C's `char *name` spacing. */
function typed(type: string): string {
  return type.endsWith("*") ? type : `${type} `;
}

export function variableDeclaration(language: string, name: string, expr: string, cx: DeclContext = {}): DeclResult {
  const ok = (decl: Declaration): DeclResult => ({ ok: true, decl });
  const v = (prefix: string, op: string, suffix = "") => ok(build(prefix, name, ` ${op} ${expr}`, suffix));
  switch (language) {
    case "java":
      if (cx.javaVar) return v("var ", "=", ";");
      if (cx.type) return v(typed(cx.type), "=", ";");
      return {
        ok: false,
        reason:
          "the type of the expression is unknown and `var` needs Java 10+ (set maven.compiler.release / sourceCompatibility, or wait for the language server)",
      };
    case "csharp":
      return v("var ", "=", ";");
    case "kotlin":
    case "scala":
      return v("val ", "=");
    case "swift":
      return v("let ", "=");
    case "rust":
      return v("let ", "=", ";");
    case "go":
      return v("", ":=");
    case "python":
    case "ruby":
    case "elixir":
      return v("", "=");
    case "lua":
      return v("local ", "=");
    case "php":
      return ok(build("", name, ` = ${expr}`, ";", "$"));
    case "cpp":
      return v("auto ", "=", ";");
    case "c":
      if (cx.cAuto) return v("auto ", "=", ";");
      if (cx.type) return v(typed(cx.type), "=", ";");
      return { ok: false, reason: "the type of the expression is unknown (`auto` needs C23)" };
    case "dart":
      return v("final ", "=", ";");
    case "zig":
      return v("const ", "=", ";");
    case "groovy":
      return v("def ", "=");
    default:
      if (TS_JS.has(language)) return v("const ", "=", cx.semicolons === false ? "" : ";");
      return { ok: false, reason: `not supported for ${language} without the language server` };
  }
}

export function constantDeclaration(language: string, name: string, expr: string, cx: DeclContext = {}): DeclResult {
  const ok = (prefix: string, suffix = ""): DeclResult => ({
    ok: true,
    decl: build(prefix, name, ` = ${expr}`, suffix),
  });
  switch (language) {
    case "java":
      if (!cx.type)
        return { ok: false, reason: "a constant needs a type; only literals are typed without the language server" };
      return ok(`private static final ${typed(cx.type)}`, ";");
    case "python":
      return ok("");
    case "kotlin":
      return ok("private const val ");
    default:
      if (TS_JS.has(language)) return ok("const ", cx.semicolons === false ? "" : ";");
      return { ok: false, reason: `Introduce Constant is not supported for ${language} without the language server` };
  }
}

/** Languages whose block-level expression statements discard their value. */
const STATEMENT_VALUE_DISCARDED = new Set([
  "java",
  "csharp",
  "python",
  "go",
  "c",
  "cpp",
  "php",
  "dart",
  "lua",
  "zig",
  ...TS_JS,
]);

/**
 * May an expression statement that consists of exactly the extracted
 * expression be replaced by the declaration (IDEA: `foo();` → `var x = foo();`)?
 * Not where a trailing expression is the block's value (Rust tail
 * expressions, Kotlin / Scala / Ruby / Elixir / Swift blocks).
 */
export function replacesBareStatement(language: string, statementKind: string): boolean {
  if (language === "rust") return statementKind === "expression_statement";
  return STATEMENT_VALUE_DISCARDED.has(language);
}

const JAVA_INT = /^(0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*)([lL]?)$/;
const JAVA_FLOAT = /^(\d[\d_]*\.?[\d_]*([eE][+-]?\d+)?|\.\d[\d_]*([eE][+-]?\d+)?)([fFdD]?)$/;

function numericType(text: string, intTypes: [string, string], floatTypes: [string, string]): string | null {
  const t = text.replace(/^-\s*/, "");
  const i = JAVA_INT.exec(t);
  if (i) return i[2] ? intTypes[1] : intTypes[0];
  const f = JAVA_FLOAT.exec(t);
  if (f && /[.eEfFdD]/.test(t)) return /[fF]$/.test(t) ? floatTypes[1] : floatTypes[0];
  return null;
}

/**
 * Is `kind`/`text` a literal (optionally negated number) whose value does not
 * depend on anything in scope? Interpolating strings are not.
 */
export function isLiteral(language: string, kind: string, text: string): boolean {
  const t = text.trim();
  const negNumber = /^-\s*[\d.]/.test(t) && /unary|prefix/.test(kind);
  switch (language) {
    case "java":
      return negNumber || (/_literal$/.test(kind) && kind !== "null_literal") || kind === "true" || kind === "false";
    case "python":
      if (negNumber) return true;
      if (kind === "string" || kind === "concatenated_string") return !/(^|["'\s])[rRbBuU]*[fF][rRbB]*["']/.test(t);
      return ["integer", "float", "true", "false"].includes(kind);
    case "kotlin":
      if (negNumber) return true;
      if (kind === "string_literal") return !t.includes("$");
      if (kind === "identifier" || kind === "boolean_literal") return t === "true" || t === "false";
      return /^(number|float|character|integer|real|hex|bin|long|unsigned)_literal$/.test(kind);
    case "c":
    case "cpp":
      return negNumber || ["string_literal", "char_literal", "number_literal", "true", "false"].includes(kind);
    default:
      if (TS_JS.has(language)) {
        if (negNumber) return true;
        if (kind === "template_string") return !t.includes("${");
        return ["string", "number", "true", "false", "regex"].includes(kind);
      }
      return false;
  }
}

/** Java / C type of a literal, or null when it has none (or is not a literal). */
export function literalType(language: string, kind: string, text: string): string | null {
  if (!isLiteral(language, kind, text)) return null;
  const t = text.trim();
  if (language === "java") {
    if (kind === "string_literal") return "String";
    if (kind === "character_literal") return "char";
    if (kind === "true" || kind === "false") return "boolean";
    return numericType(t, ["int", "long"], ["double", "float"]);
  }
  if (language === "c") {
    if (kind === "string_literal") return "const char *";
    if (kind === "char_literal") return "char";
    if (kind === "true" || kind === "false") return null;
    const n = t.replace(/^-\s*/, "");
    if (/^(0[xX][\da-fA-F]+|\d+)[uU]?[lL]{1,2}[uU]?$/.test(n))
      return /[uU]/.test(n) ? null : /[lL]{2}/.test(n) ? "long long" : "long";
    if (/^(0[xX][\da-fA-F]+|\d+)$/.test(n)) return "int";
    return numericType(n, ["int", "long"], ["double", "float"]);
  }
  return null;
}

/** Java type of a plain constructor call / array creation (`new Foo(…)`, `new int[3]`); null with `<>` or a class body. */
export function javaConstructedType(text: string): string | null {
  const t = text.trim();
  const arr = /^new\s+([\w$.]+)\s*((?:\[[^\]]*\]\s*)+)(\{[\s\S]*\})?$/.exec(t);
  if (arr) return `${arr[1]}${"[]".repeat((arr[2]!.match(/\[/g) ?? []).length)}`;
  const obj = /^new\s+([\w$.]+(?:\s*<[\w$.,\s?<>[\]]+>)?)\s*\(/.exec(t);
  if (!obj || !t.endsWith(")")) return null;
  // The argument list must be the one closing the expression (no `{ … }` body, no chained call).
  let depth = 0;
  for (let i = obj[0].length - 1; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0 && i !== t.length - 1) return null;
  }
  return obj[1]!.replace(/\s+/g, "");
}

/**
 * The name an expression ends in — the last call's method (`a.b().c(0)` → `c`) or the last
 * name (`a.b` → `b`) — with its offset in `text`. Null when it ends in something else.
 */
export function trailingName(text: string): { name: string; index: number } | null {
  let end = text.trimEnd().length;
  if (text[end - 1] === ")") {
    // Back to the `(` that opens the trailing argument list.
    let depth = 0;
    let i = end - 1;
    for (; i >= 0; i--) {
      if (text[i] === ")") depth++;
      else if (text[i] === "(" && --depth === 0) break;
    }
    if (i < 0) return null;
    end = text.slice(0, i).trimEnd().length;
  }
  const m = /[A-Za-z_$][\w$]*$/.exec(text.slice(0, end));
  return m ? { name: m[0], index: m.index } : null;
}

/**
 * Type of a Java expression from a jdtls-style hover (```java\nString java.lang.String.trim()\n```
 * or `String name`), for a call / name ending in `name`. Null when unclear.
 */
export function javaTypeFromHover(hover: string, name: string): string | null {
  const code = /```(?:java)?\n([\s\S]*?)```/.exec(hover)?.[1] ?? hover;
  const line = code
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  const at = new RegExp(`(^|[\\s.])${name.replace(/\$/g, "\\$")}\\s*(\\(|$|\\s|-)`).exec(line);
  if (!at) return null;
  let before = line.slice(0, at.index + at[1]!.length).trim();
  before = before.replace(/\s*[\w$.]+\.$/, "").trim(); // owner: `java.lang.String.`
  before = before.replace(/^((public|protected|private|static|final|abstract|synchronized|native|default)\s+)+/, "");
  before = before.replace(/^<[^>]*>\s*/, "");
  if (!before || before === "void") return null;
  return /^[\w$.]+(\s*<[\w$.,\s?<>[\]]*>)?(\[\])*$/.test(before) ? before : null;
}
