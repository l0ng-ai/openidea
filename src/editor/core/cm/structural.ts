/**
 * Structural editing for languages without a Lezer grammar (legacy stream
 * modes, or no CodeMirror mode at all): Move Statement and Complete Current
 * Statement answered by the backend's tree-sitter structure service
 * (`structure.structuralRanges` / `structure.syntaxErrors`).
 *
 * The planners here are pure (state + query results → transaction) and only
 * act when the tree is unambiguous; otherwise they report `fallback` and the
 * caller runs the line-based command. Where a Lezer tree exists the Lezer
 * commands in `editing.ts` stay in charge.
 */
import { StreamLanguage, language as languageFacet, syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getIndentUnit, indentString } from "@codemirror/language";
import type { Pos, StructuralRanges, SyntaxError, SyntaxErrors, SyntaxNode } from "@/bindings";
import { offsetToPos, posToOffset } from "@/editor/lsp/positions";
import {
  BARE_CONDITION,
  SEMICOLON_LANGS,
  codeEnd,
  completeStatementSpec,
  isBlockHead,
  lineCommentToken,
  recordSelectionAfter,
  unclosedQuote,
} from "./editing";

/** The document has a real (Lezer) syntax tree, not a stream mode's flat token list or nothing. */
export function hasLezerTree(state: EditorState): boolean {
  const lang = state.facet(languageFacet);
  if (!lang || lang instanceof StreamLanguage) return false;
  return syntaxTree(state).length > 0 || state.doc.length === 0;
}

/** Backend structure queries for one document; `null` when the service cannot answer. */
export interface StructureQueries {
  ranges(pos: Pos): Promise<StructuralRanges | null>;
  errors(): Promise<SyntaxErrors | null>;
}

export interface CachedQueriesDeps {
  /** Bumped by every document change (cache key). */
  stamp(): number;
  /** Resolves once local edits reached the backend document. */
  synced(): Promise<void>;
  fetchRanges(pos: Pos): Promise<StructuralRanges>;
  fetchErrors(): Promise<SyntaxErrors>;
}

const MAX_CACHED_POSITIONS = 64;

/**
 * Queries cached per document version, so repeated presses (Move Statement
 * Up ×3) cost one backend round trip per position and none while nothing
 * changed. Failures (no grammar, too large, not open) answer `null`.
 */
export function cachedStructureQueries(deps: CachedQueriesDeps): StructureQueries {
  let stamp = -1;
  let ranges = new Map<string, Promise<StructuralRanges | null>>();
  let errors: Promise<SyntaxErrors | null> | null = null;
  const fresh = async () => {
    await deps.synced();
    const now = deps.stamp();
    if (now !== stamp) {
      stamp = now;
      ranges = new Map();
      errors = null;
    }
  };
  const settle = <T>(p: Promise<T>) => p.catch(() => null);
  return {
    async ranges(pos) {
      await fresh();
      const key = `${pos.line}:${pos.col}`;
      let p = ranges.get(key);
      if (!p) {
        if (ranges.size >= MAX_CACHED_POSITIONS) ranges.delete(ranges.keys().next().value!);
        p = settle(deps.fetchRanges(pos));
        ranges.set(key, p);
      }
      return p;
    },
    async errors() {
      await fresh();
      return (errors ??= settle(deps.fetchErrors()));
    },
  };
}

// --- move statement -------------------------------------------------------------

interface Span {
  from: number;
  to: number;
}

export type MovePlan = { kind: "move"; spec: TransactionSpec } | { kind: "noop" } | { kind: "fallback" };

const offsets = (state: EditorState, n: SyntaxNode): Span => ({
  from: posToOffset(state.doc, n.range.start),
  to: posToOffset(state.doc, n.range.end),
});

const contains = (outer: Span, inner: Span) => outer.from <= inner.from && inner.to <= outer.to;

/**
 * Whether the statement (rather than the member declaration) is the innermost
 * unit: a statement inside a method, not a method whose enclosing "statement"
 * is the whole class.
 */
function statementIsInnermost(state: EditorState, r: StructuralRanges): boolean {
  if (!r.statement) return false;
  return !r.declaration || contains(offsets(state, r.declaration), offsets(state, r.statement));
}

/** Without the line breaks a node may end with (Go's `case 1:` branch ends at the next line's start). */
function trimEnd(state: EditorState, s: Span): Span {
  const text = state.sliceDoc(s.from, s.to);
  return { from: s.from, to: s.from + text.trimEnd().length };
}

/** The node starts its line and nothing but `;`, `,` or a comment follows it on its last line. */
function ownsLines(state: EditorState, s: Span): boolean {
  const first = state.doc.lineAt(s.from);
  if (state.sliceDoc(first.from, s.from).trim()) return false;
  const last = state.doc.lineAt(s.to);
  const rest = state.sliceDoc(s.to, last.to);
  const token = lineCommentToken(state, s.to);
  const code = rest.slice(0, codeEnd(rest, token)).trim();
  return code === "" || code === ";" || code === ",";
}

/** Whole lines of `s`, extended upwards over the comment lines directly above it (doc comments move along). */
function lineSpan(state: EditorState, s: Span): Span {
  const tokens = state.languageDataAt<{ line?: string; block?: { open: string; close: string } }>(
    "commentTokens",
    s.from,
  )[0];
  let first = state.doc.lineAt(s.from);
  const isLineComment = (t: string) => !!tokens?.line && t.startsWith(tokens.line);
  for (let guard = 0; first.number > 1 && guard < 500; guard++) {
    const prev = state.doc.line(first.number - 1);
    const t = prev.text.trim();
    if (isLineComment(t)) {
      first = prev;
      continue;
    }
    const block = tokens?.block;
    if (block && t.endsWith(block.close)) {
      // Climb to the line opening this block comment.
      let open = prev;
      while (!open.text.trim().startsWith(block.open) && open.number > 1 && first.number - open.number < 500) {
        open = state.doc.line(open.number - 1);
      }
      if (!open.text.trim().startsWith(block.open)) break;
      first = open;
      continue;
    }
    break;
  }
  return { from: first.from, to: state.doc.lineAt(s.to).to };
}

/**
 * A node with syntax errors still moves as a unit when its boundaries are
 * trustworthy: every error lies strictly inside it, off its first and last
 * line (a broken statement in a method body does not pin the method).
 */
function reliableBounds(state: EditorState, n: SyntaxNode, s: Span, errors: SyntaxErrors | null): boolean {
  if (!n.hasError) return true;
  if (!errors || errors.truncated) return false;
  const first = state.doc.lineAt(s.from).number;
  const last = state.doc.lineAt(s.to).number;
  return errors.errors.every((e) => {
    const from = posToOffset(state.doc, e.range.start);
    const to = posToOffset(state.doc, e.range.end);
    if (to < s.from || from > s.to) return true;
    if (from < s.from || to > s.to) return false;
    return state.doc.lineAt(from).number > first && state.doc.lineAt(to).number < last;
  });
}

/**
 * Move Statement Up / Down from backend ranges queried at the caret line:
 * swaps the innermost statement (or class / file member) with its previous /
 * next sibling, whole lines, doc comments included. `noop` at the first / last
 * statement of a block (never moves code past the block's delimiters) or when
 * the sibling shares its lines with other code; `fallback` (move the line)
 * when there is no usable statement at the caret: none found, one that shares
 * its line, or one whose extent the parser is unsure of (syntax errors at its edges).
 */
export function planMoveStatement(
  state: EditorState,
  r: StructuralRanges | null,
  up: boolean,
  errors: SyntaxErrors | null = null,
): MovePlan {
  if (!r) return { kind: "fallback" };
  const useStatement = statementIsInnermost(state, r);
  const node = useStatement ? r.statement : r.declaration;
  const sibling = useStatement ? (up ? r.prevStatement : r.nextStatement) : up ? r.prevDeclaration : r.nextDeclaration;
  if (!node) return { kind: "fallback" };
  const cur = trimEnd(state, offsets(state, node));
  if (!ownsLines(state, cur) || !reliableBounds(state, node, cur, errors)) return { kind: "fallback" };
  if (!sibling) return { kind: "noop" };
  const sib = trimEnd(state, offsets(state, sibling));
  if (!ownsLines(state, sib) || !reliableBounds(state, sibling, sib, errors)) return { kind: "noop" };
  const curLines = lineSpan(state, cur);
  const sibLines = lineSpan(state, sib);
  const [a, b] = up ? [sibLines, curLines] : [curLines, sibLines];
  if (a.to >= b.from) return { kind: "fallback" };
  const head = state.selection.main.head;
  const caretOffset = head - curLines.from;
  const textA = state.sliceDoc(a.from, a.to);
  const textB = state.sliceDoc(b.from, b.to);
  const between = state.sliceDoc(a.to, b.from);
  const anchor = up ? a.from + caretOffset : a.from + textB.length + between.length + caretOffset;
  return {
    kind: "move",
    spec: {
      changes: { from: a.from, to: b.to, insert: textB + between + textA },
      selection: EditorSelection.cursor(anchor),
      scrollIntoView: true,
      userEvent: "move.line",
    },
  };
}

// --- complete statement -----------------------------------------------------------

/** Missing tokens the fallback inserts where tree-sitter placed them. */
const INSERTABLE = new Set([";", ")", "]"]);
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Brackets opened on `code` and not closed there, innermost last (string literals skipped). */
export function unclosedBrackets(code: string): string[] {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      // An unmatched closer means the line continues an outer construct: stay out.
      if (!stack.length) return [];
      stack.pop();
    }
  }
  return stack;
}

const errorTouches = (state: EditorState, e: SyntaxError, from: number, to: number) => {
  const a = posToOffset(state.doc, e.range.start);
  const b = posToOffset(state.doc, e.range.end);
  return a <= to && b >= from;
};

interface KeywordBlock {
  head: RegExp;
  /** Keyword the head line must end with (`then` / `do`), added when missing. */
  opener?: (text: string) => string | null;
}

/** Block heads of `end`-terminated languages. */
const KEYWORD_BLOCKS: Record<string, KeywordBlock> = {
  ruby: {
    head: /^\s*(def|class|module|if|unless|while|until|case|begin|for)\b|\bdo(\s*\|[^|]*\|)?$/,
  },
  lua: {
    head: /^\s*(local\s+)?(function|if|for|while)\b|=\s*function\b|\bfunction\s*\(.*\)$/,
    opener: (text) => (/^\s*if\b/.test(text) ? "then" : /^\s*(for|while)\b/.test(text) ? "do" : null),
  },
  elixir: {
    head: /^\s*(defmodule|if|unless|case|cond|for|with|receive|try)\b/,
    opener: () => "do",
  },
};

/**
 * The head at `lineNo` (1-based) has no `end` of its own: the code returns to
 * the head's indentation (or below it) with something other than `end` or a
 * continuation (`else`, `rescue`…) first.
 */
export function unterminated(state: EditorState, lineNo: number): boolean {
  const indent = /^[ \t]*/.exec(state.doc.line(lineNo).text)![0].length;
  for (let n = lineNo + 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    if (!text.trim()) continue;
    const own = /^[ \t]*/.exec(text)![0].length;
    if (own > indent) continue;
    if (own < indent) return true;
    if (/^\s*end\b/.test(text)) return false;
    if (/^\s*(else|elsif|elseif|rescue|ensure|when|catch|after|in)\b/.test(text)) continue;
    return true;
  }
  return true;
}

function keywordBlockSpec(state: EditorState, language: string, errors: SyntaxErrors): TransactionSpec | null {
  const rules = KEYWORD_BLOCKS[language];
  if (!rules) return null;
  const line = state.doc.lineAt(state.selection.main.head);
  const full = line.text.trimEnd();
  const text = full.slice(0, codeEnd(full, lineCommentToken(state, line.from)));
  if (!rules.head.test(text) || /\bend\s*$/.test(text) || /\bdo:/.test(text)) return null;
  // Certain only when the parser agrees the construct is broken here (Elixir
  // parses `if x` as a plain call, so indentation alone decides there).
  const broken = language === "elixir" || errors.errors.some((e) => errorTouches(state, e, line.from, line.to));
  if (!broken || !unterminated(state, line.number)) return null;
  const opener = rules.opener?.(text);
  const keyword = opener && !new RegExp(`\\b${opener}(\\s*\\|[^|]*\\|)?$`).test(text) ? ` ${opener}` : "";
  const indent = /^[ \t]*/.exec(line.text)![0];
  const unit = indentString(state, getIndentUnit(state));
  const br = state.lineBreak;
  const from = line.from + text.length;
  const insert = `${keyword}${full.slice(text.length)}${br}${indent}${unit}${br}${indent}end`;
  return {
    changes: { from, to: line.to, insert },
    selection: { anchor: from + keyword.length + full.length - text.length + br.length + indent.length + unit.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

/**
 * Complete Current Statement (⌘⇧↵) with the parse tree's help:
 *  1. tokens tree-sitter reports missing on the caret line (`;`, `)`, `]`) are
 *     inserted where it expects them, brackets left open on a broken line are
 *     closed;
 *  2. `end`-terminated languages get `then` / `do` and an `end` for an
 *     unterminated block head;
 *  3. inside a complete multi-line statement the caret moves below it;
 *  then the text-based completion (`;`, `{ }`, new line) finishes the line.
 */
export function planCompleteStatement(
  state: EditorState,
  language: string,
  r: StructuralRanges | null,
  errors: SyntaxErrors | null,
): TransactionSpec | null {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (!line.text.trim()) return null;
  if (errors) {
    const block = keywordBlockSpec(state, language, errors);
    if (block) return block;
  }
  const full = line.text.trimEnd();
  const codeTo = line.from + codeEnd(full, lineCommentToken(state, line.from));
  const lineCode = state.sliceDoc(line.from, codeTo);
  // A block head gets its body and an open string its quote: the parser's recovery
  // asks for a `;` there (`if (x);`, `"text;`), which would change what the code means.
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1).text.trim() : "";
  const finishedHead = isBlockHead(lineCode, language) && !unclosedBrackets(lineCode).length && nextLine !== "{";
  if (
    SEMICOLON_LANGS.has(language) &&
    (finishedHead || BARE_CONDITION.test(lineCode) || unclosedQuote(lineCode, language))
  )
    return completeStatementSpec(state, language);
  const inserts: ChangeSpec[] = [];
  const lineErrors = errors?.errors.filter((e) => errorTouches(state, e, line.from, line.to)) ?? [];
  let closers = "";
  for (const e of lineErrors) {
    if (e.kind !== "missing" || !e.expected || !INSERTABLE.has(e.expected)) continue;
    const at = posToOffset(state.doc, e.range.start);
    if (at < line.from || at > codeTo) continue;
    // Recovery noise: a token "missing" right after `;` / `{` / `}` belongs to some other construct.
    if (/[;{}]$/.test(state.sliceDoc(line.from, at).trimEnd())) continue;
    if (e.expected === ";") inserts.push({ from: at, insert: ";" });
    else closers += e.expected;
  }
  if (lineErrors.length) {
    // Close what this line opened (after the closers the parser asked for), before a `;`.
    // A line ending in `{` opens a block (finished below); other brackets
    // it leaves open (`foo(a`, `= {1, 2`) are closed.
    const code = state.sliceDoc(line.from, codeTo);
    const open = /[{;]$/.test(code) ? [] : unclosedBrackets(code);
    const wanted = open
      .map((c) => OPENERS[c]!)
      .reverse()
      .join("");
    if (wanted.startsWith(closers)) closers = wanted;
    // `= {1, 2` → `= {1, 2};` (the text rules leave a line ending in `}` alone).
    if (closers.endsWith("}") && SEMICOLON_LANGS.has(language)) closers += ";";
    if (closers) inserts.unshift({ from: codeTo, insert: closers });
  }
  if (!inserts.length && errors && !lineErrors.length) {
    const code = state.sliceDoc(line.from, codeTo);
    const br = state.lineBreak;
    // Allman style: the block opens on the next line; continue inside it.
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    if (next && next.text.trim() === "{" && !/[;{}]$/.test(code)) {
      const insert = br + /^[ \t]*/.exec(next.text)![0] + indentString(state, getIndentUnit(state));
      return {
        changes: { from: next.to, insert },
        selection: { anchor: next.to + insert.length },
        scrollIntoView: true,
        userEvent: "input.complete",
      };
    }
    // Inside a complete statement spanning more lines: continue below it, not inside it.
    const node = r && (statementIsInnermost(state, r) ? r.statement : r.declaration);
    const opensBlock = /[{([]$|\b(do|then)$|:$/.test(code) || !!KEYWORD_BLOCKS[language]?.head.test(code);
    if (node && !node.hasError && !opensBlock) {
      const span = offsets(state, node);
      const endLine = state.doc.lineAt(span.to);
      if (endLine.number > line.number && contains(span, { from: head, to: head })) {
        const insert = br + /^[ \t]*/.exec(state.doc.lineAt(span.from).text)![0];
        return {
          changes: { from: endLine.to, insert },
          selection: { anchor: endLine.to + insert.length },
          scrollIntoView: true,
          userEvent: "input.complete",
        };
      }
    }
  }
  if (!inserts.length) return completeStatementSpec(state, language);
  const first = state.changes(inserts);
  const next = state.update({ changes: first, selection: { anchor: first.mapPos(head, 1) } }).state;
  const rest = completeStatementSpec(next, language);
  if (!rest) return { changes: first, userEvent: "input.complete" };
  const second = next.changes(rest.changes ?? []);
  return {
    changes: first.compose(second),
    selection: rest.selection,
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

// --- commands ----------------------------------------------------------------------

/** Runs `plan` on fresh query results, unless the editor changed while they were computed. */
async function runPlanned(
  view: EditorView,
  query: () => Promise<TransactionSpec | "noop" | null>,
): Promise<"done" | "fallback" | "stale"> {
  const before = view.state;
  const spec = await query();
  if (view.state.doc !== before.doc || !view.state.selection.eq(before.selection)) return "stale";
  if (spec === "noop") return "done";
  if (!spec) return "fallback";
  view.dispatch(spec);
  return "done";
}

export async function moveStatementStructural(
  view: EditorView,
  up: boolean,
  q: StructureQueries,
): Promise<"done" | "fallback" | "stale"> {
  const before = view.state.doc;
  const result = await runPlanned(view, async () => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (!line.text.trim()) return null;
    const r = await q.ranges(offsetToPos(view.state.doc, line.from));
    const errors =
      r &&
      (r.statement?.hasError ||
        r.declaration?.hasError ||
        r.prevStatement?.hasError ||
        r.nextStatement?.hasError ||
        r.prevDeclaration?.hasError ||
        r.nextDeclaration?.hasError)
        ? await q.errors()
        : null;
    const plan = planMoveStatement(view.state, r, up, errors);
    return plan.kind === "move" ? plan.spec : plan.kind === "noop" ? "noop" : null;
  });
  if (result === "done" && view.state.doc !== before) recordSelectionAfter(view);
  return result;
}

export async function completeStatementStructural(
  view: EditorView,
  language: string,
  q: StructureQueries,
): Promise<"done" | "fallback" | "stale"> {
  return runPlanned(view, async () => {
    const pos = offsetToPos(view.state.doc, view.state.selection.main.head);
    const [r, errors] = await Promise.all([q.ranges(pos), q.errors()]);
    if (!r && !errors) return null;
    return planCompleteStatement(view.state, language, r, errors);
  });
}
