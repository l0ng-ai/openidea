/**
 * Code › Unwrap/Remove (⇧⌘⌦): replaces the `if` / loop / `try` / `with` …
 * around the caret by the body the caret is in (an `else` / `catch` branch
 * keeps that branch). Works on the tree-sitter ancestor chain of the caret, so
 * every language with a grammar is covered.
 */
import type { Text } from "@codemirror/state";
import { tx } from "@/platform/i18n";

export interface ChainNode {
  kind: string;
  from: number;
  to: number;
  /** Field name in the parent (`consequence`, `body`, `alternative`…). */
  field: string | null;
}

export interface UnwrapOption {
  label: string;
  /** The statement affected by the unwrap. */
  target: { from: number; to: number };
  /** Original range of the body that will be kept. */
  retained: { from: number; to: number } | null;
  from: number;
  to: number;
  insert: string;
}

const STATEMENTS = new Set([
  "if_statement",
  "if_expression",
  "if_let_expression",
  "for_statement",
  "for_in_statement",
  "for_of_statement",
  "enhanced_for_statement",
  "foreach_statement",
  "for_range_loop",
  "range_based_for_statement",
  "for_expression",
  "while_statement",
  "while_expression",
  "while_let_expression",
  "do_statement",
  "loop_expression",
  "try_statement",
  "try_with_resources_statement",
  "with_statement",
  "synchronized_statement",
  "unsafe_block",
  "lock_statement",
  "using_statement",
]);

const CLAUSES: Record<string, string> = {
  else_clause: "else",
  elif_clause: "elif",
  else_if_clause: "else if",
  catch_clause: "catch",
  except_clause: "except",
  finally_clause: "finally",
};

/** The child on the caret's path must be a body, not the condition / header. */
const HEADER_FIELDS = new Set([
  "condition",
  "left",
  "right",
  "value",
  "pattern",
  "initializer",
  "update",
  "resources",
  "parameters",
  "type",
  "name",
]);

function isBody(n: ChainNode): boolean {
  if (n.field && HEADER_FIELDS.has(n.field)) return false;
  return (
    /block|body|statement|compound|suite/.test(n.kind) ||
    n.field === "consequence" ||
    n.field === "alternative" ||
    n.field === "body"
  );
}

const leading = (s: string) => /^[ \t]*/.exec(s)![0];

/** Body text without its braces, re-indented to `base`, and its original range. */
function unwrapBody(doc: Text, body: ChainNode, base: string) {
  let from = body.from;
  let to = body.to;
  const raw = doc.sliceString(from, to);
  if (raw.startsWith("{") && raw.endsWith("}")) {
    from += 1;
    to -= 1;
  }
  const first = doc.lineAt(from);
  if (!doc.sliceString(first.from, from).trim()) from = first.from;
  const text = doc.sliceString(from, to);
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => leading(l).length);
  const strip = indents.length ? Math.min(...indents) : 0;
  const retained = lines.length
    ? { from: from + text.length - text.trimStart().length, to: from + text.trimEnd().length }
    : null;
  return { insert: lines.map((l) => (l.trim() ? base + l.slice(strip) : "")).join("\n"), retained };
}

function keyword(doc: Text, n: ChainNode): string {
  return (
    /^[A-Za-z_]+/.exec(doc.sliceString(n.from, Math.min(n.to, n.from + 20)))?.[0] ??
    n.kind.replace(/_(statement|expression|block)$/, "")
  );
}

function replacement(
  doc: Text,
  target: ChainNode,
  body: ChainNode,
): Pick<UnwrapOption, "from" | "to" | "insert" | "retained"> {
  const startLine = doc.lineAt(target.from);
  const endLine = doc.lineAt(target.to);
  const wholeLines =
    !doc.sliceString(startLine.from, target.from).trim() && !doc.sliceString(target.to, endLine.to).trim();
  if (wholeLines) {
    const { insert, retained } = unwrapBody(doc, body, leading(startLine.text));
    // An empty body removes the statement's lines altogether.
    if (!retained) {
      const to = endLine.number < doc.lines ? endLine.to + 1 : endLine.to;
      const from = to === endLine.to && startLine.number > 1 ? startLine.from - 1 : startLine.from;
      return { from, to, insert, retained };
    }
    return { from: startLine.from, to: endLine.to, insert, retained };
  }
  // Mid-line (`} else if (…) {…}`): the branch stays a braced block.
  return {
    from: target.from,
    to: target.to,
    insert: doc.sliceString(body.from, body.to),
    retained: { from: body.from, to: body.to },
  };
}

/**
 * Unwrap options for a caret whose tree-sitter chain is `chain`
 * (innermost first), innermost statement first.
 */
export function unwrapOptions(doc: Text, chain: readonly ChainNode[]): UnwrapOption[] {
  const out: UnwrapOption[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < chain.length; i++) {
    const w = chain[i]!;
    const child = chain[i - 1]!;
    const clause = CLAUSES[w.kind];
    if (!clause && !STATEMENTS.has(w.kind)) continue;
    if (!isBody(child)) continue;
    let target = w;
    let label = clause ?? keyword(doc, w);
    if (clause) {
      const stmt = chain.slice(i + 1).find((n) => STATEMENTS.has(n.kind));
      if (!stmt) continue;
      target = stmt;
      // Python / Rust `elif` / `else if` chains: the whole `if` goes.
    } else if (child.field === "alternative") label = "else";
    const key = `${target.from}:${target.to}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: tx`Unwrap '${label}'`,
      target: { from: target.from, to: target.to },
      ...replacement(doc, target, child),
    });
  }
  return out;
}
