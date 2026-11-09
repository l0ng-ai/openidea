/** Pure mapping from backend completion items to CodeMirror completions. */
import type { Completion } from "@codemirror/autocomplete";
import type { CompletionItem, CompletionKind } from "@/bindings";

/** Completion kind → the design system's symbol badge kind (`ui/icons` `SymbolBadge`). */
const KIND_TO_SYMBOL: Record<CompletionKind, string> = {
  text: "text",
  method: "method",
  function: "function",
  constructor: "constructor",
  field: "field",
  variable: "variable",
  class: "class",
  interface: "interface",
  module: "module",
  property: "property",
  unit: "constant",
  value: "constant",
  enum: "enum",
  keyword: "keyword",
  snippet: "snippet",
  color: "constant",
  file: "file",
  reference: "variable",
  folder: "package",
  enumMember: "constant",
  constant: "constant",
  struct: "struct",
  event: "field",
  operator: "keyword",
  typeParameter: "type",
};

export function completionSymbolKind(kind: CompletionKind | null): string {
  return kind ? KIND_TO_SYMBOL[kind] : "text";
}

/**
 * Maps the declarative fields. `label` is what CodeMirror filters on, so an
 * LSP `filterText` that differs from the label becomes the label and the
 * original label is shown through `displayLabel`.
 */
export function toCmCompletion(item: CompletionItem): Completion {
  const filter = item.filterText && item.filterText !== item.label && !extendsLabel(item) ? item.filterText : null;
  const c: Completion = {
    label: filter ?? item.label,
    type: completionSymbolKind(item.kind),
  };
  if (filter) c.displayLabel = item.label;
  if (item.labelDetail) c.detail = item.labelDetail;
  if (item.sortText) c.sortText = item.sortText;
  if (item.preselect) c.boost = 99;
  else if (item.deprecated) c.boost = -20;
  if (item.commitCharacters.length) c.commitCharacters = item.commitCharacters;
  return c;
}

/**
 * A `filterText` that is the label plus what the item inserts after it (jdtls
 * `String(${0})`, `List<>()`): typing a word never reaches that part, and
 * matching on it would rank the exact `String` like `StringBuilder`.
 */
function extendsLabel(item: CompletionItem): boolean {
  const rest = item.filterText!.slice(item.label.length);
  return item.filterText!.startsWith(item.label) && /^[^\p{L}\p{N}_$]/u.test(rest);
}

/**
 * Items that look and insert the same, listed once. kotlin-language-server
 * repeats a class once per classpath entry declaring it (`String()` ×3);
 * these all have their own `apply` (see `makeCompletion`), so CodeMirror
 * wouldn't merge them.
 */
export function withoutDuplicates(items: readonly CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = JSON.stringify([
      it.server,
      it.label,
      it.labelDetail,
      it.labelDescription,
      it.detail,
      it.kind,
      it.insertText,
      it.additionalEdits,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const IMPORT_SOURCE = [
  /^\s*from\s+([\w.]+)\s+import\b/m, // Python
  /^\s*import\s+(?:static\s+)?([\w.]+?)\.\w+;?\s*$/m, // Java, Kotlin
  /^\s*use\s+([\w:]+)::/m, // Rust
  /\bfrom\s+["']([^"']+)["']/, // JS / TS
];

/**
 * Where an auto-import item comes from (`collections`, `java.util`): the
 * module its import edit names. Servers like pyright put it nowhere else, so
 * same-named items (`OrderedDict` from typing / collections) look identical.
 */
export function importSource(item: Pick<CompletionItem, "additionalEdits">): string | null {
  for (const e of item.additionalEdits) {
    for (const re of IMPORT_SOURCE) {
      const m = re.exec(e.new_text);
      if (m) return m[1]!;
    }
  }
  return null;
}

/**
 * Text of the right-aligned type column: the label description (`void`, `String`), else the
 * detail, with the import source when it lacks one. JDT.LS sends the whole signature as `detail`
 * (`PrintStream.print(Object obj) : void`), which would repeat the name and parameters already
 * shown next to the label; the documentation panel still shows it.
 */
export function typeColumnText(
  item: Pick<CompletionItem, "detail" | "additionalEdits"> & { labelDescription?: string | null },
): string | null {
  const detail = (item.labelDescription?.trim() || item.detail)?.replace(/\s+/g, " ") || null;
  const source = importSource(item);
  if (!source || detail?.includes(source)) return detail;
  return !detail || /^auto[- ]?import$/i.test(detail) ? source : `${detail} (${source})`;
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** End of the identifier starting at `pos` in `line` (for ⇥ Replace without a server range). */
export function identifierEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
  return i;
}

/** Completion trigger character for the text just before the caret, if any. */
export function triggerCharacter(before: string): string | null {
  const last = before.slice(-1);
  if (last === ".") return before.slice(-2) === ".." ? null : ".";
  if (last === ":") return before.slice(-2) === "::" ? ":" : null;
  if (last === ">") return before.slice(-2) === "->" ? ">" : null;
  if (last === "@") return "@";
  return null;
}
