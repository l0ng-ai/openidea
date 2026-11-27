/**
 * Smart Type completion (⌃⇧Space) for Python: the lookup keeps the items whose type fits the
 * caret's expected type. basedpyright's items carry no type, so each candidate is resolved and
 * its type read from the documentation's code block; types are compared by name.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { CompletionItem, Markup, SignatureHelp } from "@/platform/ipc";

export const SMART_TYPE_LANGUAGES = new Set(["python"]);

/** At most this many candidates are resolved per lookup, this many at a time. */
const MAX_RESOLVED = 150;
const RESOLVE_CONCURRENCY = 8;

const TYPING_ALIASES: Record<string, string> = {
  List: "list",
  Dict: "dict",
  Set: "set",
  FrozenSet: "frozenset",
  Tuple: "tuple",
  Type: "type",
};

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One non-union type, canonical: no module prefix, `typing` aliases lowered, arguments canonical. */
function canonicalMember(type: string): string {
  const m = /^([A-Za-z_][\w.]*)\s*(?:\[([\s\S]*)\])?$/.exec(type);
  if (!m) return type.replace(/\s+/g, "");
  const base = m[1]!.slice(m[1]!.lastIndexOf(".") + 1);
  const name = Object.hasOwn(TYPING_ALIASES, base) ? TYPING_ALIASES[base]! : base;
  return m[2] === undefined ? name : `${name}[${splitTopLevel(m[2], ",").map(canonicalType).join(", ")}]`;
}

/** The union members of a type, each canonical: `Optional[a.B]` → `B`, `None`. */
export function typeParts(type: string): string[] {
  const text = type.trim().replace(/^["']|["']$/g, "");
  const members = splitTopLevel(text, "|");
  if (members.length > 1) return [...new Set(members.flatMap(typeParts))];
  const optional = /^(?:typing\.)?Optional\s*\[([\s\S]*)\]$/.exec(text);
  if (optional) return [...new Set([...typeParts(optional[1]!), "None"])];
  const union = /^(?:typing\.)?Union\s*\[([\s\S]*)\]$/.exec(text);
  if (union) return [...new Set(splitTopLevel(union[1]!, ",").flatMap(typeParts))];
  return text ? [canonicalMember(text)] : [];
}

/** A type written canonically: `List[Optional[int]]` and `list[int | None]` read the same. */
function canonicalType(type: string): string {
  return typeParts(type).sort().join(" | ");
}

/** Numeric promotion (PEP 484): `float` accepts `int`, `complex` accepts both; `bool` is an `int`. */
const PROMOTED: Record<string, readonly string[]> = {
  bool: ["int", "float", "complex"],
  int: ["float", "complex"],
  float: ["complex"],
};

/** How a value of type `actual` fits the expected members: yes, maybe (`Any`, unknown arguments), no. */
export function typeFit(
  actual: string,
  expected: readonly string[],
  bases: (name: string) => readonly string[] = () => [],
): "yes" | "maybe" | "no" {
  const parts = typeParts(actual);
  if (!parts.length) return "no";
  let maybe = false;
  for (const part of parts) {
    if (expected.includes(part)) continue;
    const name = part.replace(/\[[\s\S]*$/, "");
    if (Object.hasOwn(PROMOTED, part) && PROMOTED[part]?.some((p) => expected.includes(p))) continue;
    if (ancestors(name, bases).some((a) => expected.includes(a))) continue;
    // `Any`, or a generic whose arguments the server could not infer (`list[Unknown]`).
    const unknownArgs =
      part !== name && /\b(?:Unknown|Any)\b/.test(part) && expected.some((e) => e.startsWith(`${name}[`) || e === name);
    if (part === "Any" || unknownArgs) {
      maybe = true;
      continue;
    }
    return "no";
  }
  return maybe ? "maybe" : "yes";
}

/** The base class names of `name`, transitively (by name: the project's classes). */
function ancestors(name: string, bases: (name: string) => readonly string[]): string[] {
  const seen = new Set<string>();
  const todo = [...bases(name)];
  while (todo.length) {
    const next = todo.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    todo.push(...bases(next));
  }
  return [...seen];
}

/** The annotation of a parameter label (`p: Priority = ...` → `Priority`), or null. */
export function parameterAnnotation(label: string): string | null {
  const colon = label.indexOf(":");
  if (colon < 0 || label.trimStart().startsWith("*")) return null;
  const type = splitTopLevel(label.slice(colon + 1), "=")[0]?.trim();
  return type || null;
}

/** The caret's expected type from the signature help: the active parameter's annotation. */
export function expectedFromSignature(help: SignatureHelp | null): string | null {
  const sig = help?.signatures[help.activeSignature] ?? help?.signatures[0];
  const range = sig?.parameters[help!.activeParameter];
  return sig && range ? parameterAnnotation(sig.label.slice(range[0], range[1])) : null;
}

const NOT_A_TARGET = new Set([
  "else",
  "try",
  "finally",
  "lambda",
  "if",
  "elif",
  "while",
  "for",
  "with",
  "except",
  "match",
  "case",
]);

/** The annotation for an assignment or return, including when a member name is being typed. */
export function expectedFromText(state: EditorState, from: number): string | null {
  const line = state.doc.lineAt(from);
  const before = line.text
    .slice(0, from - line.from)
    .replace(/(?:[A-Za-z_]\w*(?:\([^()]*\)|\[[^[\]]*\])*\s*\.\s*)+$/, "");
  // `[^=]`: the type holds no `=`, so `ok: bool = a <= |` is not an assignment to the caret.
  const assigned = /^\s*([A-Za-z_][\w.]*)\s*:\s*([^=]+?)\s*=\s*$/.exec(before);
  if (assigned) return NOT_A_TARGET.has(assigned[1]!) ? null : assigned[2]!;
  if (!/^\s*return\s+$/.test(before)) return null;

  const keyword = line.from + before.indexOf("return");
  const tree = ensureSyntaxTree(state, from, 10) ?? syntaxTree(state);
  const statement = tree.resolveInner(keyword + 1, 1).parent;
  if (statement?.name !== "ReturnStatement") return null;
  for (let node = statement.parent; node; node = node.parent) {
    if (node.name === "ClassDefinition") return null;
    if (node.name === "FunctionDefinition") {
      const annotation = node.getChild("TypeDef")?.firstChild;
      return annotation ? state.sliceDoc(annotation.from, annotation.to) : null;
    }
  }
  return null;
}

/** The type of a resolved item from its documentation's code block: a variable's, or a call's result. */
export function itemType(item: CompletionItem, documentation: Markup | null): string | null {
  const value = documentation?.value ?? "";
  const code = (/```\w*\n([\s\S]*?)```/.exec(value)?.[1] ?? item.detail ?? "").trim().replace(/^\(\w+\)\s*/, "");
  if (!code) return null;
  if (/^async\s/.test(code)) return null;
  if (/^def\s/.test(code)) return /\)\s*->\s*([\s\S]+)$/.exec(code)?.[1]?.trim() ?? null;
  const name = item.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${name}\\s*:\\s*([\\s\\S]+)$`).exec(code)?.[1]?.trim() ?? null;
}

const TYPED_KINDS = new Set(["variable", "field", "property", "constant", "enumMember", "function", "method"]);

export interface SmartOptions {
  /** The identifier typed so far: only items it matches are resolved. */
  typed: string;
  /** Completing after `x.`: attributes are resolved whether or not the file mentions them. */
  member: boolean;
  /** Names the document mentions (`mentionedNames`). */
  mentioned: ReadonlySet<string>;
  /** Base class names of a class name, from the project's classes. */
  bases?: (name: string) => readonly string[];
  /** True once the lookup was cancelled: no further resolves are sent. */
  aborted?: () => boolean;
}

export interface SmartResult {
  items: CompletionItem[];
  /** Items that may fit (`Any`, unknown type arguments): listed after the others. */
  lower: ReadonlySet<CompletionItem>;
}

/** Whether `label` contains the letters of `typed` in order, ignoring case (as the lookup filters). */
function matches(label: string, typed: string): boolean {
  let i = 0;
  const l = label.toLowerCase();
  const t = typed.toLowerCase();
  for (let j = 0; j < l.length && i < t.length; j++) if (l[j] === t[i]) i++;
  return i === t.length;
}

/** Resolves `items`, a few at a time (the server answers one request at a time); stops when `aborted`. */
async function resolveFew(
  items: readonly CompletionItem[],
  resolve: (item: CompletionItem) => Promise<CompletionItem>,
  aborted: () => boolean,
): Promise<(CompletionItem | undefined)[]> {
  const out: (CompletionItem | undefined)[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && !aborted()) {
      const i = next++;
      // oxlint-disable-next-line no-await-in-loop -- each worker resolves one item at a time and re-checks `aborted()` before taking the next
      out[i] = await resolve(items[i]!).catch(() => items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * The items of `items` whose type fits `expected`, in their order. A class fits by its name (or a
 * base's) and literals by their value (`True` / `False` for `bool`, `None` for an optional type);
 * the others are resolved for their type. Outside a member access, only names the document's
 * text mentions are resolved: its own declarations, imports and the builtins it uses, not every
 * builtin. An expected `Any` or `object` keeps every item.
 */
export async function smartItems(
  items: readonly CompletionItem[],
  expected: string,
  resolve: (item: CompletionItem) => Promise<CompletionItem>,
  opts: SmartOptions,
): Promise<SmartResult> {
  const want = typeParts(expected);
  if (want.includes("Any") || want.includes("object")) return { items: [...items], lower: new Set() };
  const bases = opts.bases ?? (() => []);
  const literal = (item: CompletionItem) =>
    ((item.label === "True" || item.label === "False") &&
      ["bool", "int", "float", "complex"].some((t) => want.includes(t))) ||
    (item.label === "None" && want.includes("None"));
  // ponytail: capped resolves; a file mentioning more matching names misses the rest.
  const candidates = items
    .filter(
      (i) =>
        i.kind !== null &&
        TYPED_KINDS.has(i.kind) &&
        matches(i.label, opts.typed) &&
        (opts.member || opts.mentioned.has(i.label)),
    )
    .slice(0, MAX_RESOLVED);
  const resolved = await resolveFew(candidates, resolve, opts.aborted ?? (() => false));
  // The matched type fills the lookup's type column, which basedpyright's items leave empty.
  const fits = new Map<CompletionItem, { type: string; fit: "yes" | "maybe" }>();
  candidates.forEach((item, i) => {
    const done = resolved[i];
    const type = done ? itemType(done, done.documentation) : null;
    const fit = type === null ? "no" : typeFit(type, want, bases);
    if (type !== null && fit !== "no") fits.set(item, { type, fit });
  });
  const lower = new Set<CompletionItem>();
  const out = items.flatMap((item) => {
    const found =
      item.kind === "class" && typeFit(item.label, want, bases) === "yes"
        ? { type: item.label, fit: "yes" as const }
        : fits.get(item);
    if (found) {
      const typed = { ...item, labelDescription: item.labelDescription ?? found.type.replace(/\s+/g, " ") };
      if (found.fit === "maybe") lower.add(typed);
      return [typed];
    }
    return literal(item) ? [item] : [];
  });
  return { items: out, lower };
}

/** The identifiers of `text`, for `smartItems`. */
export function mentionedNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_]\w*/g));
}
