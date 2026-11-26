/**
 * Variable names by type, as IDEA's JavaCodeStyleManager suggests them: typing the name of a
 * Java declaration (`private IUserService |`, `List<Order> |`, `catch (IOException |`) lists
 * `userService`, `service`, `orders`, `e`… The language server offers nothing there.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { lspDoc } from "./lsp";

/** The declared type at a name being typed: `Map<String, Order>[]` → `Map`, `[String, Order]`, array. */
export interface DeclaredType {
  name: string;
  args: string[];
  array: boolean;
  kind: "field" | "parameter" | "local";
}

const PRIMITIVES = new Set(["int", "long", "short", "byte", "char", "boolean", "float", "double"]);

/** Words before a type that make what follows something other than a declaration's name. */
const NOT_A_DECLARATION = new Set([
  "new",
  "class",
  "interface",
  "enum",
  "record",
  "extends",
  "implements",
  "permits",
  "throws",
  "import",
  "package",
  "return",
  "throw",
  "yield",
  "assert",
  "goto",
  "var",
  "this",
  "super",
]);

const FIELD_MODIFIERS = /\b(?:private|protected|public|static|volatile|transient)\b/;

const DECLARATION =
  /(^|[\s(,;{}])((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*(<[^;(){}=]*>)?((?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)?$/;

/**
 * The type whose variable's name ends `before` (the line up to the caret), with the name typed so
 * far; null when the caret isn't at a declared name.
 */
export function declarationAt(before: string): { type: DeclaredType; typed: string } | null {
  const m = DECLARATION.exec(before);
  if (!m) return null;
  const qualified = m[2]!;
  const name = qualified.slice(qualified.lastIndexOf(".") + 1);
  if (!PRIMITIVES.has(name) && !/^[A-Z]/.test(name)) return null;
  const head = before.slice(0, m.index + m[1]!.length);
  const previous = /([A-Za-z_@][\w]*)\s*$/.exec(head)?.[1];
  if (previous && (NOT_A_DECLARATION.has(previous) || previous.startsWith("@"))) return null;
  if (/@\s*$/.test(head)) return null;
  const params = /[(,]\s*$/.test(head) || /\(\s*(?:final\s+)?$/.test(head) || /\bcatch\s*\(\s*$/.test(head);
  const kind = params ? "parameter" : FIELD_MODIFIERS.test(head) ? "field" : "local";
  return {
    type: { name, args: typeArguments(m[3] ?? ""), array: !!m[4]?.trim(), kind },
    typed: m[5] ?? "",
  };
}

/** The top-level type arguments' simple names (`<String, List<Order>>` → `String`, `List`); `?` and bounds skipped. */
function typeArguments(generic: string): string[] {
  const inner = generic.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else if (depth === 0 && ch !== ">") current += ch;
  }
  out.push(current);
  return out
    .map((a) => a.trim())
    .filter((a) => /^[A-Za-z_$][\w$.]*$/.test(a))
    .map((a) => a.slice(a.lastIndexOf(".") + 1));
}

/** IDEA's NameUtilCore.nameToWordList: `IUserURLService` → `I`, `User`, `URL`, `Service`. */
function words(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]/g) ?? [];
}

/** StringUtil.pluralize for the usual cases. */
export function pluralize(word: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** `UserService` → `userService`, `service` (longest first); an all-caps first word goes lower case. */
function suffixNames(name: string): string[] {
  const ws = words(name);
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const first = ws[i]!;
    if (!/^[A-Za-z]/.test(first)) continue;
    const head = first === first.toUpperCase() ? first.toLowerCase() : first[0]!.toLowerCase() + first.slice(1);
    out.push(head + ws.slice(i + 1).join(""));
  }
  return out;
}

const SHORT_NAMES: Record<string, string> = {
  int: "i",
  boolean: "b",
  byte: "b",
  char: "c",
  long: "l",
  short: "i",
  double: "v",
  float: "v",
  Integer: "i",
  Short: "i",
  Long: "l",
  Boolean: "b",
  Byte: "b",
  Character: "c",
  Double: "v",
  Float: "v",
  Object: "o",
  String: "s",
};

const ITERABLES = new Set([
  "Iterable",
  "Collection",
  "List",
  "ArrayList",
  "LinkedList",
  "Set",
  "HashSet",
  "LinkedHashSet",
  "TreeSet",
  "SortedSet",
  "NavigableSet",
  "Queue",
  "Deque",
  "ArrayDeque",
  "PriorityQueue",
  "Stack",
  "Vector",
  "CopyOnWriteArrayList",
]);

/** `UserServiceImpl` names a `userService`, as in IDEA. */
const normalize = (name: string) => (name.length > 4 && name.endsWith("Impl") ? name.slice(0, -4) : name);

const JAVA_KEYWORDS = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends " +
    "final finally float for goto if implements import instanceof int interface long native new package private " +
    "protected public return short static strictfp super switch synchronized this throw throws transient try void " +
    "volatile while true false null var record yield"
  ).split(" "),
);

/** The names IDEA suggests for a variable of `type`, best first. */
export function namesForType(type: DeclaredType): string[] {
  const base: string[] = [];
  const short = type.kind === "field" ? undefined : SHORT_NAMES[type.name];
  if (short) base.push(type.array ? pluralize(short) : short);
  const name = normalize(type.name);
  if (type.args.length === 1 && ITERABLES.has(type.name)) base.push(pluralize(normalize(type.args[0]!)));
  if (type.args.length === 1 && type.name === "Optional") {
    const content = normalize(type.args[0]!);
    base.push(content, `optional${content}`);
  }
  if (type.args.length) base.push(type.args.map(normalize).join("") + name);
  const own = type.array ? pluralize(name) : name;
  if (type.kind === "parameter" && type.name.endsWith("Exception")) base.push("e");
  base.push(own);
  if (own.length > "Entity".length && own.endsWith("Entity")) base.push(own.slice(0, -"Entity".length));
  const out: string[] = [];
  for (const b of base) {
    for (const n of PRIMITIVES.has(b) || b.length === 1 ? [b] : suffixNames(b)) {
      if (!out.includes(n) && !JAVA_KEYWORDS.has(n) && /^[A-Za-z_$][\w$]*$/.test(n)) out.push(n);
    }
  }
  return out;
}

/** The declaration under the caret in a Java file (not in a comment or string), or null. */
export function javaDeclarationAt(ctx: CompletionContext): { type: DeclaredType; typed: string } | null {
  if (ctx.state.facet(lspDoc)?.language !== "java") return null;
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  if (/Comment|String|TextBlock/.test(node.name)) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  return declarationAt(line.text.slice(0, ctx.pos - line.from));
}

/** Completion source: the type's names at a Java declaration's name. */
export function variableNameSource(ctx: CompletionContext): CompletionResult | null {
  const found = javaDeclarationAt(ctx);
  if (!found) return null;
  const names = namesForType(found.type);
  const options: Completion[] = names.map((label, i) => ({ label, type: "variable", boost: 50 - i }));
  return options.length ? { from: ctx.pos - found.typed.length, options, validFor: /^[\w$]*$/ } : null;
}
