/**
 * Smart Type completion (⌃⇧Space) for Python: the lookup keeps the items whose type fits the
 * caret's expected type. basedpyright's items carry no type, so each candidate is resolved and
 * its type read from the documentation's code block; types are compared by name.
 */
import type { CompletionItem, Markup, SignatureHelp } from "@/platform/ipc";

export const SMART_TYPE_LANGUAGES = new Set(["python"]);

/** At most this many candidates are resolved per lookup. */
const MAX_RESOLVED = 150;

const TYPING_ALIASES: Record<string, string> = { List: "list", Dict: "dict", Set: "set", Tuple: "tuple", Type: "type" };

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

/** The union members of a type, without module prefixes: `Optional[a.B]` → `B`, `None`. */
export function typeParts(type: string): string[] {
  const text = type
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "");
  const optional = /^(?:typing\.)?Optional\[(.*)\]$/.exec(text);
  if (optional) return [...typeParts(optional[1]!), "None"];
  const union = /^(?:typing\.)?Union\[(.*)\]$/.exec(text);
  const members = union ? splitTopLevel(union[1]!, ",") : splitTopLevel(text, "|");
  if (members.length > 1) return [...new Set(members.flatMap(typeParts))];
  // `a.b.C[x.Y]` → `C[Y]`; `typing.List` → `list`.
  return [
    text.replace(/\b(?:[A-Za-z_]\w*\.)+(?=[A-Za-z_])/g, "").replace(/\b[A-Z]\w*\b/g, (n) => TYPING_ALIASES[n] ?? n),
  ];
}

/** Whether a value of type `actual` fits `expected`: each union member of it is one of expected's. */
export function typeFits(actual: string, expected: readonly string[]): boolean {
  const parts = typeParts(actual);
  return parts.length > 0 && parts.every((p) => expected.includes(p));
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

/**
 * The caret's expected type from the text before it: `x: T = |`, or `return |` in a function
 * annotated `-> T` (the nearest less indented `def` above).
 */
export function expectedFromText(lines: readonly string[], line: number, before: string): string | null {
  const assigned = /^\s*[A-Za-z_][\w.]*\s*:\s*(.+?)\s*=\s*$/.exec(before);
  if (assigned) return assigned[1]!;
  if (!/^\s*return\s+$/.test(before)) return null;
  const indent = before.length - before.trimStart().length;
  for (let i = line - 1; i >= 0; i--) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    const own = text.length - text.trimStart().length;
    if (own >= indent) continue;
    if (!/^\s*(?:async\s+)?def\b/.test(text)) {
      if (/^\s*class\b/.test(text) || own === 0) return null;
      continue;
    }
    // The header may span lines: up to the `:` that ends it.
    let header = text;
    for (let j = i + 1; j < line && !/:\s*(?:#.*)?$/.test(header); j++) header += " " + lines[j]!.trim();
    if (/^\s*async\b/.test(text)) return null;
    return /->\s*(.+?)\s*:\s*(?:#.*)?$/.exec(header)?.[1] ?? null;
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

/**
 * The items of `items` whose type fits `expected`, in their order. A class fits by its name and
 * literals by their value (`True` / `False` for `bool`, `None` for an optional type); the others
 * are resolved for their type. Only names the document's text mentions are resolved: its own
 * declarations, imports and the builtins it uses, not every builtin (each resolve is a round trip).
 */
export async function smartItems(
  items: readonly CompletionItem[],
  expected: string,
  resolve: (item: CompletionItem) => Promise<CompletionItem>,
  mentioned: ReadonlySet<string>,
): Promise<CompletionItem[]> {
  const want = typeParts(expected);
  const literal = (item: CompletionItem) =>
    ((item.label === "True" || item.label === "False") && want.includes("bool")) ||
    (item.label === "None" && want.includes("None"));
  // ponytail: capped resolves; a file mentioning more names misses the rest.
  const candidates = items
    .filter((i) => i.kind !== null && TYPED_KINDS.has(i.kind) && mentioned.has(i.label))
    .slice(0, MAX_RESOLVED);
  const resolved = await Promise.all(candidates.map((item) => resolve(item).catch(() => item)));
  // The matched type fills the lookup's type column, which basedpyright's items leave empty.
  const fits = new Map<CompletionItem, string>();
  candidates.forEach((item, i) => {
    const type = itemType(item, resolved[i]!.documentation);
    if (type !== null && typeFits(type, want)) fits.set(item, type);
  });
  return items.flatMap((item) => {
    const type = item.kind === "class" && want.includes(item.label) ? item.label : fits.get(item);
    if (type !== undefined) return [{ ...item, labelDescription: item.labelDescription ?? type.replace(/\s+/g, " ") }];
    return literal(item) ? [item] : [];
  });
}

/** The identifiers of `text`, for `smartItems`. */
export function mentionedNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_]\w*/g));
}
