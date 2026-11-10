/**
 * Introduce Variable (⌥⌘V) / Introduce Constant (⌥⌘C) without the language
 * server, from the tree-sitter structure service (IDEA's dumb mode). Called by
 * the LSP actions only when the server is not usable, or answered nothing over
 * code with syntax errors. Does only what is syntactically certain: refuses
 * with a hint otherwise, asks when there is a choice (which expression, which
 * occurrences), then lets the user pick the name. One undo step.
 */
import type { EditorView } from "@codemirror/view";
import type { ChangeSet, ChangeSpec, EditorState, Text } from "@codemirror/state";
import { redo, undo } from "@codemirror/commands";
import type { NodeAt, Range, SyntaxNode } from "@/bindings";
import { structure, type ExpressionAt } from "@/editor/structure";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange, rangeToOffsets } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { clearTemporaryHighlight, highlightRanges } from "@/editor/lsp/tempHighlight";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { expressionWords, findTextOccurrences, normalizeExpression } from "./occurrences";
import { isIdentifier, isKeyword, suggestNames, uniqueNames } from "./names";
import { cIsC23, javaLanguageLevel } from "./projectLevel";
import {
  constantDeclaration,
  isLiteral,
  isTsJs,
  javaConstructedType,
  javaTypeFromHover,
  literalType,
  replacesBareStatement,
  trailingName,
  variableDeclaration,
  type DeclContext,
  type DeclResult,
  type Declaration,
} from "./templates";
import { tx } from "@/platform/i18n";

/** Why the language server could not do it (see `withFallback`). */
export type FallbackReason = "notReady" | "error" | "empty";
export type IntroduceKind = "variable" | "constant";

const NOTES: Record<FallbackReason, string> = {
  notReady: "Based on syntax (language server not ready)",
  error: "Based on syntax (language server failed)",
  empty: "Based on syntax (the code has errors)",
};

/** At most this many other occurrences are checked and offered. */
const MAX_OCCURRENCES = 30;

const FUNCTION_LIKE = /lambda|arrow_function|closure|function|func_literal|method|anonymous|class_body|object_creation/;
/** Ruby blocks are closures. */
const RUBY_BLOCK = /^(block|do_block)$/;

function functionLike(language: string, kind: string): boolean {
  return FUNCTION_LIKE.test(kind) || (language === "ruby" && RUBY_BLOCK.test(kind));
}
/** Fields of a sub-expression that is evaluated conditionally or repeatedly by its parent. */
const CONDITIONAL_FIELDS = new Set(["consequence", "alternative", "body", "update", "increment"]);
const LOOP = /while|for|loop|do_statement|repeat|until/;
const BLOCKISH =
  /^(block|chunk|statement_list|program|module|source_file|compound_statement|statement_block|body|do_block|statements|declaration_list|class_body|template_body)$/;

interface Prepared {
  view: EditorView;
  ctx: EditorDocContext;
  kind: IntroduceKind;
  reason: FallbackReason;
  /** Document the structure answers refer to. */
  doc: Text;
  at: ExpressionAt;
}

function nodeText(doc: Text, node: { range: Range }): string {
  const { from, to } = rangeToOffsets(doc, node.range);
  return doc.sliceString(from, to);
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col
  );
}

/**
 * `[node, ...ancestors]` from `nodeAt`, and the index of the outermost node
 * spanning exactly `range` and of `kind` (wrappers such as Kotlin's
 * `value_argument` share the expression's range).
 */
function chainOf(n: NodeAt | null, range: Range, kind: string): { chain: SyntaxNode[]; self: number } | null {
  if (!n) return null;
  const chain = [n.node, ...n.ancestors];
  let self = -1;
  chain.forEach((c, i) => {
    if (sameRange(c.range, range) && c.kind === kind) self = i;
  });
  return self < 0 ? null : { chain, self };
}

/** Assignment target / increment operand: replacing it by a variable changes meaning. */
function isWritten(chain: SyntaxNode[], self: number): boolean {
  for (let i = self; i <= self + 1 && i + 1 < chain.length; i++) {
    const node = chain[i]!;
    const parent = chain[i + 1]!;
    if (node.field === "left" && /assign/.test(parent.kind)) return true;
    if (
      /update_expression|increment|decrement|postfix_unary|prefix_unary/.test(parent.kind) &&
      /\+\+|--/.test(parent.kind + node.kind)
    )
      return true;
    if (/update_expression|inc_statement|dec_statement/.test(parent.kind)) return true;
    if (node.kind !== "expression_list") break;
  }
  return false;
}

/** The expression is a statement of its own (`foo();`, a Python docstring). */
function isBareStatement(chain: SyntaxNode[], self: number, doc: Text): boolean {
  const parent = chain[self + 1];
  if (!parent) return false;
  if (BLOCKISH.test(parent.kind)) return true;
  if (parent.kind !== "expression_statement") return false;
  const node = chain[self]!;
  const { to } = rangeToOffsets(doc, node.range);
  const end = rangeToOffsets(doc, parent.range).to;
  return /^\s*;?\s*$/.test(doc.sliceString(to, end));
}

/** Lines above `pos`'s line that belong to the declaration there (comments, annotations). */
function declarationStart(doc: Text, pos: number): number {
  let line = doc.lineAt(pos);
  while (line.number > 1) {
    const prev = doc.line(line.number - 1);
    const t = prev.text.trim();
    if (!t || !/^(\/\/|\/\*|\*|#(?!include|define|if|!)|@)/.test(t)) break;
    line = prev;
  }
  return line.from;
}

function indentOf(doc: Text, pos: number): string {
  return /^[ \t]*/.exec(doc.lineAt(pos).text)![0];
}

/** `o.get` in `o.get()`: a function reference, not a value worth extracting. */
function isCallee(doc: Text, node: SyntaxNode, outer: SyntaxNode | undefined): boolean {
  if (!outer || !/call|invocation/.test(outer.kind) || outer.range.start.line !== node.range.start.line) return false;
  if (outer.range.start.col !== node.range.start.col) return false;
  const end = rangeToOffsets(doc, node.range).to;
  return /^\s*(\(|<|::<)/.test(doc.sliceString(end, end + 4));
}

/** Chooser label of an expression: one line, shortened. */
export function expressionPreview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

/**
 * Entry point from the action: true when it handled the request (refactored,
 * asked, or explained why not); false to let the caller report the server's
 * own answer.
 */
export async function introduceFallback(
  view: EditorView,
  kind: IntroduceKind,
  reason: FallbackReason,
): Promise<boolean> {
  const before = view.state.doc;
  try {
    return await introduce(view, kind, reason);
  } catch (e) {
    if (!isCancelled(e)) console.debug("[refactor]", e);
    return view.state.doc !== before;
  }
}

async function introduce(view: EditorView, kind: IntroduceKind, reason: FallbackReason): Promise<boolean> {
  const ctx = docOf(view);
  if (!ctx) return false;
  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return false;
  if (ctx.readOnly) {
    showHint(view, "The file is read-only");
    return true;
  }
  await whenSynced(view);
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const at = await structure.expressionAt(ctx.doc, offsetsToRange(doc, sel.from, sel.to));
  // A server that is up and answered nothing is respected unless the code there is broken.
  if (reason === "empty" && !(await brokenAround(ctx, doc, sel.from, sel.to, at))) return false;
  if (view.state.doc !== doc) return true;

  const p: Prepared = { view, ctx, kind, reason, doc, at };
  let candidates: SyntaxNode[];
  if (sel.empty) {
    candidates = expressionCandidates(doc, at);
    if (!candidates.length) return refuse(p, "no expression at the caret");
  } else {
    if (!at.expression || !at.exact) return refuse(p, "selected block should represent an expression");
    candidates = [at.expression];
  }
  if (candidates.length === 1) {
    await perform(p, candidates[0]!);
    return true;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, sel.head),
    title: "Expressions",
    items: candidates.map((c, i) => ({
      id: `${i}`,
      label: expressionPreview(nodeText(doc, c)),
      onActive: () => highlightRanges(view, [rangeToOffsets(doc, c.range)]),
      run: () => perform(p, c),
    })),
    onClose: () => clearTemporaryHighlight(view),
  });
  return true;
}

/** The expressions at an empty selection, innermost first, that are worth extracting (no callee names). */
export function expressionCandidates(doc: Text, at: ExpressionAt): SyntaxNode[] {
  return at.candidates.filter((c, i) => !c.error && !c.missing && !isCallee(doc, c, at.candidates[i + 1]));
}

async function brokenAround(
  ctx: EditorDocContext,
  doc: Text,
  from: number,
  to: number,
  at: ExpressionAt,
): Promise<boolean> {
  if (at.hasError) return true;
  const lineFrom = doc.lineAt(from).from;
  const lineTo = doc.lineAt(to).to;
  const { errors } = await structure.syntaxErrors(ctx.doc);
  return errors.some((e) => {
    const r = rangeToOffsets(doc, e.range);
    return r.from <= lineTo && r.to >= lineFrom;
  });
}

function refuse(p: Prepared, why: string): true {
  showHint(p.view, `Cannot perform refactoring: ${why}`);
  return true;
}

async function perform(p: Prepared, expr: SyntaxNode): Promise<void> {
  const { view, doc } = p;
  if (view.state.doc !== doc) {
    showHint(view, "The document changed; invoke the refactoring again");
    return;
  }
  if (expr.error || expr.missing || expr.hasError) {
    refuse(p, "the expression contains syntax errors");
    return;
  }
  const at = chainOf(await structure.nodeAt(p.ctx.doc, expr.range), expr.range, expr.kind);
  if (!at) {
    refuse(p, "the expression could not be located");
    return;
  }
  if (isWritten(at.chain, at.self)) {
    refuse(p, "the expression is assigned to");
    return;
  }
  if (p.kind === "variable") await introduceVariable(p, expr, at.chain, at.self);
  else await introduceConstant(p, expr, at.chain, at.self);
}

// ---------------------------------------------------------------------------
// Variable

async function introduceVariable(p: Prepared, expr: SyntaxNode, chain: SyntaxNode[], self: number) {
  const { doc, ctx, at } = p;
  const statement = at.statement;
  if (!statement || !at.block) return void refuse(p, "no statement to put the declaration before");
  if (at.functionBoundary) {
    return void refuse(p, "the expression is in a lambda with an expression body; convert it to a block body first");
  }
  // Hoisting before the statement must not change how often / whether it runs.
  for (let i = self; i < chain.length; i++) {
    const node = chain[i]!;
    const parent = chain[i + 1];
    if (!parent || sameRange(node.range, statement.range)) break;
    if (CONDITIONAL_FIELDS.has(node.field ?? "") || (node.field === "condition" && LOOP.test(parent.kind))) {
      return void refuse(p, "the expression is evaluated conditionally or repeatedly by its statement");
    }
    if (i > self && /comprehension|generator_expression/.test(node.kind)) {
      return void refuse(p, "the expression is inside a comprehension");
    }
  }

  const exprText = nodeText(doc, expr);
  const { from: exprFrom, to: exprTo } = rangeToOffsets(doc, expr.range);
  const { from: stmtFrom, to: stmtTo } = rangeToOffsets(doc, statement.range);
  // `foo();` / `foo()` alone (a missing `;` may make the parser swallow the next line into the statement).
  const rest = doc.sliceString(exprTo, stmtTo);
  const bare =
    replacesBareStatement(ctx.language, statement.kind) &&
    stmtFrom === exprFrom &&
    (/^\s*;?\s*$/.test(rest) || (statement.hasError && /^[ \t]*;?[ \t]*(\n|$)/.test(rest)));
  const bareTo = /^\s*;?\s*$/.test(rest) ? stmtTo : exprTo + /^[ \t]*;?/.exec(rest)![0].length;

  const declCx = await variableContext(p, expr, exprText, statement);
  const probe = variableDeclaration(ctx.language, "x", exprText, declCx);
  if (!probe.ok) return void refuse(p, probe.reason);

  const blockRange = rangeToOffsets(doc, at.block.range);
  const block = at.block;
  const resolution = resolutionOf(p);
  const others = await verifiedOccurrences(p, expr, exprText, stmtFrom, blockRange.to, async (o, s) => {
    // In the same block, not inside a nested function / lambda.
    const above = s.chain.slice(s.self + 1);
    const blockAt = above.findIndex((n) => sameRange(n.range, block.range));
    if (blockAt < 0 || above.slice(0, blockAt).some((n) => functionLike(ctx.language, n.kind))) return false;
    if (isWritten(s.chain, s.self) || isBareStatement(s.chain, s.self, doc)) return false;
    return sameResolution(p, resolution, { from: exprFrom, to: exprTo }, o);
  });

  const names = await nameSuggestions(p, expr, exprText);
  const firstOnLine = !doc.sliceString(doc.lineAt(stmtFrom).from, stmtFrom).trim();
  const plan = (all: boolean) => (name: string, state: EditorState) => {
    const result = variableDeclaration(ctx.language, name, exprText, declCx);
    if (!result.ok) return null;
    const decl = result.decl;
    const specs: ChangeSpec[] = [];
    const refs: number[] = [];
    if (bare) specs.push({ from: stmtFrom, to: bareTo, insert: decl.text });
    else {
      const sep = firstOnLine ? `\n${indentOf(doc, stmtFrom)}` : decl.terminated ? " " : "; ";
      specs.push({ from: stmtFrom, insert: decl.text + sep });
      specs.push({ from: exprFrom, to: exprTo, insert: decl.reference });
      refs.push(exprFrom);
    }
    if (all) {
      for (const o of others) {
        specs.push({ from: o.from, to: o.to, insert: decl.reference });
        refs.push(o.from);
      }
    }
    return { changes: state.changes(specs), decl, declAt: stmtFrom, refs };
  };
  await chooseOccurrences(p, { from: exprFrom, to: exprTo }, others, (all) => applyAndName(p, plan(all), names));
}

async function variableContext(
  p: Prepared,
  expr: SyntaxNode,
  text: string,
  statement: SyntaxNode,
): Promise<DeclContext> {
  const { ctx, doc } = p;
  const root = useProject.getState().project?.root ?? null;
  if (ctx.language === "java") {
    const level = await javaLanguageLevel(ctx.path, root).catch(() => null);
    if (level !== null && level >= 10) return { javaVar: true };
    const type =
      literalType("java", expr.kind, text) ?? javaConstructedType(text) ?? (await javaHoverType(p, expr, text));
    return { type };
  }
  if (ctx.language === "c") {
    if (await cIsC23(ctx.path, root).catch(() => false)) return { cAuto: true };
    return { type: literalType("c", expr.kind, text) };
  }
  if (isTsJs(ctx.language)) return { semicolons: usesSemicolons(doc, statement) };
  return {};
}

function usesSemicolons(doc: Text, statement: SyntaxNode): boolean {
  if (nodeText(doc, statement).trimEnd().endsWith(";")) return true;
  return /;[ \t]*$/m.test(doc.toString());
}

/** Return / declared type of a Java call or name from the server's hover, if it answers. */
async function javaHoverType(p: Prepared, expr: SyntaxNode, text: string): Promise<string | null> {
  const last = trailingName(text);
  if (!last || !/method_invocation|identifier|field_access/.test(expr.kind)) return null;
  const { from } = rangeToOffsets(p.doc, expr.range);
  const pos = p.doc.lineAt(from + last.index);
  const at = { line: pos.number - 1, col: from + last.index - pos.from };
  try {
    const hover = await Promise.race([
      call(commands.lspHover(nextRequestId(), p.ctx.doc, at)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return hover ? javaTypeFromHover(hover.contents.value, last.name) : null;
  } catch {
    return null;
  }
}

/** Memoised `locals` lookups: local definition / not-local reason of the identifier at an offset. */
function resolutionOf(p: Prepared): (offset: number) => Promise<string> {
  const memo = new Map<number, Promise<string>>();
  const supported = structure.support(p.ctx.language).then(
    (s) => s.locals,
    () => false,
  );
  return (offset) => {
    let r = memo.get(offset);
    if (!r) {
      r = (async () => {
        if (!(await supported)) return "unknown";
        const line = p.doc.lineAt(offset);
        const l = await structure.locals(p.ctx.doc, { line: line.number - 1, col: offset - line.from });
        if (l.status === "local") return `local:${l.symbol.definition.start.line}:${l.symbol.definition.start.col}`;
        return l.status === "notLocal" ? `not:${l.reason}` : "none";
      })();
      memo.set(offset, r);
    }
    return r;
  };
}

/** Every name in the two (equal up to whitespace) expressions resolves alike: no shadowing in between. */
async function sameResolution(
  p: Prepared,
  resolve: (offset: number) => Promise<string>,
  a: Occurrence,
  b: Occurrence,
): Promise<boolean> {
  const wa = expressionWords(p.doc.sliceString(a.from, a.to));
  const wb = expressionWords(p.doc.sliceString(b.from, b.to));
  if (wa.length !== wb.length) return false;
  for (let i = 0; i < Math.min(wa.length, 8); i++) {
    if (wa[i]!.word !== wb[i]!.word) return false;
    if ((await resolve(a.from + wa[i]!.offset)) !== (await resolve(b.from + wb[i]!.offset))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Constant

async function introduceConstant(p: Prepared, expr: SyntaxNode, chain: SyntaxNode[], self: number) {
  const { doc, ctx } = p;
  const text = nodeText(doc, expr);
  if (!isLiteral(ctx.language, expr.kind, text)) {
    return void refuse(p, "only literal values can be extracted as constants without the language server");
  }
  if (isBareStatement(chain, self, doc)) return void refuse(p, "the literal is a statement on its own");
  if (!constantPosition(ctx.language, chain, self))
    return void refuse(p, "the literal is not in an expression position");

  const declCx: DeclContext = { type: ctx.language === "java" ? literalType("java", expr.kind, text) : null };
  if (isTsJs(ctx.language)) declCx.semicolons = /;[ \t]*$/m.test(doc.toString());
  const probe = constantDeclaration(ctx.language, "X", text, declCx);
  if (!probe.ok) return void refuse(p, probe.reason);

  const place = await constantPlacement(p, expr, chain);
  if (typeof place === "string") return void refuse(p, place);

  const { from: exprFrom, to: exprTo } = rangeToOffsets(doc, expr.range);
  const others = await verifiedOccurrences(
    p,
    expr,
    text,
    place.insertAt,
    place.scopeTo,
    async (_o, s) => constantPosition(ctx.language, s.chain, s.self) && !isBareStatement(s.chain, s.self, doc),
  );

  const names = await nameSuggestions(p, expr, text);
  const plan = (all: boolean) => (name: string, state: EditorState) => {
    const result: DeclResult = constantDeclaration(ctx.language, name, text, declCx);
    if (!result.ok) return null;
    const decl = result.decl;
    const specs: ChangeSpec[] = [
      { from: place.insertAt, insert: place.indent + decl.text + "\n" + place.after },
      { from: exprFrom, to: exprTo, insert: decl.reference },
    ];
    const refs = [exprFrom];
    if (all) {
      for (const o of others) {
        specs.push({ from: o.from, to: o.to, insert: decl.reference });
        refs.push(o.from);
      }
    }
    return { changes: state.changes(specs), decl, declAt: place.insertAt, declIndent: place.indent.length, refs };
  };
  await chooseOccurrences(p, { from: exprFrom, to: exprTo }, others, (all) => applyAndName(p, plan(all), names));
}

/** Not an object key, type, import source…: a place where a named constant can stand. */
function constantPosition(language: string, chain: SyntaxNode[], self: number): boolean {
  if (
    chain.slice(self + 1).some((n) => /import|literal_type|type_annotation|predefined_type|case_pattern/.test(n.kind))
  )
    return false;
  return !(isTsJs(language) && chain[self]!.field === "key");
}

interface Placement {
  insertAt: number;
  indent: string;
  /** Text after the declaration's line (blank line separator). */
  after: string;
  /** End of the region where the constant is visible (occurrence search). */
  scopeTo: number;
}

async function constantPlacement(p: Prepared, expr: SyntaxNode, chain: SyntaxNode[]): Promise<Placement | string> {
  const { doc, ctx } = p;
  if (ctx.language === "java") {
    const exprFrom = rangeToOffsets(doc, expr.range).from;
    const line = doc.lineAt(exprFrom);
    const ranges = await structure.structuralRanges(ctx.doc, { line: line.number - 1, col: exprFrom - line.from });
    const member = ranges.declaration;
    if (!member) return "no class member contains the expression";
    const i = chain.findIndex((n) => sameRange(n.range, member.range));
    const body = chain[i + 1];
    const owner = chain[i + 2];
    if (i < 0 || !body || body.kind !== "class_body" || !owner || !/^(class|record)_declaration$/.test(owner.kind)) {
      return "constants can only be added to a class or record without the language server";
    }
    const memberFrom = rangeToOffsets(doc, member.range).from;
    return {
      insertAt: declarationStart(doc, memberFrom),
      indent: indentOf(doc, memberFrom),
      after: "\n",
      scopeTo: rangeToOffsets(doc, body.range).to,
    };
  }
  // Module level: before the top-level statement containing the expression.
  const top = chain[chain.length - 2];
  if (!top) return "the expression is not inside a top-level declaration";
  if (
    /import|package|future/.test(top.kind) ||
    (top.kind === "export_statement" && /\bfrom\s*["']/.test(nodeText(doc, top)))
  ) {
    return "the literal is part of an import";
  }
  const topFrom = rangeToOffsets(doc, top.range).from;
  return { insertAt: declarationStart(doc, topFrom), indent: "", after: "\n", scopeTo: doc.length };
}

// ---------------------------------------------------------------------------
// Shared steps

interface Occurrence {
  from: number;
  to: number;
}

/** Other occurrences of `exprText` in `[from, to)` that the tree confirms (`accept`). */
async function verifiedOccurrences(
  p: Prepared,
  expr: SyntaxNode,
  exprText: string,
  from: number,
  to: number,
  accept: (o: Occurrence, s: { chain: SyntaxNode[]; self: number }) => Promise<boolean>,
): Promise<Occurrence[]> {
  const { doc } = p;
  const { from: exprFrom, to: exprTo } = rangeToOffsets(doc, expr.range);
  const literal = isLiteral(p.ctx.language, expr.kind, exprText);
  const found = findTextOccurrences(doc.toString(), from, to, exprText, MAX_OCCURRENCES + 1).filter(
    (o) => o.to <= exprFrom || o.from >= exprTo,
  );
  const out: Occurrence[] = [];
  for (const o of found.slice(0, MAX_OCCURRENCES)) {
    const range = offsetsToRange(doc, o.from, o.to);
    const s = chainOf(await structure.nodeAt(p.ctx.doc, range), range, expr.kind);
    if (!s || s.chain[s.self]!.hasError) continue;
    if (literal && doc.sliceString(o.from, o.to) !== exprText) continue;
    if (normalizeExpression(doc.sliceString(o.from, o.to)) !== normalizeExpression(exprText)) continue;
    if (await accept(o, s)) out.push(o);
  }
  return out;
}

/** IDEA's "Multiple occurrences found" choice; runs `apply` directly when there are none. */
async function chooseOccurrences(p: Prepared, self: Occurrence, others: Occurrence[], apply: (all: boolean) => void) {
  if (!others.length) {
    apply(false);
    return;
  }
  const { view } = p;
  const head = view.state.selection.main.head;
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, head),
    title: "Multiple occurrences found",
    items: [
      {
        id: "one",
        label: "Replace this occurrence only",
        onActive: () => highlightRanges(view, [self]),
        run: () => apply(false),
      },
      {
        id: "all",
        label: tx`Replace all ${others.length + 1} occurrences`,
        onActive: () => highlightRanges(view, [self, ...others]),
        run: () => apply(true),
      },
    ],
    onClose: () => clearTemporaryHighlight(view),
  });
}

async function nameSuggestions(p: Prepared, expr: SyntaxNode, text: string): Promise<string[]> {
  const raw = suggestNames({ kind: expr.kind, text, language: p.ctx.language, constant: p.kind === "constant" });
  return uniqueNames(raw, (name) => nameTaken(p, name));
}

async function nameTaken(p: Prepared, name: string): Promise<boolean> {
  const found = await structure.identifiers(p.ctx.doc, name);
  return found.some((o) => !o.qualified);
}

type Plan = (
  name: string,
  state: EditorState,
) => { changes: ChangeSet; decl: Declaration; declAt: number; declIndent?: number; refs: number[] } | null;

/** Name ranges (declaration + references) of the variable in the document after `plan`. */
function nameRanges(planned: NonNullable<ReturnType<Plan>>, name: string): { from: number; to: number }[] {
  const { changes, decl, declAt, refs } = planned;
  const declStart = changes.mapPos(declAt, -1) + (planned.declIndent ?? 0) + decl.nameOffset;
  return [
    { from: declStart, to: declStart + name.length },
    ...refs.map((r) => {
      const at = changes.mapPos(r, -1) + decl.referenceNameOffset;
      return { from: at, to: at + name.length };
    }),
  ];
}

/** Caret after the refactoring: after the replaced occurrence, else after the declared name. */
function caretOf(planned: NonNullable<ReturnType<Plan>>, name: string): number {
  const ranges = nameRanges(planned, name);
  return (ranges[1] ?? ranges[0]!).to;
}

function applyAndName(p: Prepared, plan: Plan, names: string[]) {
  const { view } = p;
  if (view.state.doc !== p.doc) {
    showHint(view, "The document changed; invoke the refactoring again");
    return;
  }
  const original = view.state.doc;
  const name = names[0]!;
  const planned = plan(name, view.state);
  if (!planned) return;
  view.dispatch({
    changes: planned.changes,
    selection: { anchor: caretOf(planned, name) },
    scrollIntoView: true,
    userEvent: "refactor.introduce",
  });
  const applied = view.state.doc;
  const ranges = nameRanges(planned, name);
  view.focus();
  openPopup({
    kind: "rename",
    anchor: caretAnchor(view, ranges[0]!.from),
    title: p.kind === "variable" ? "Name for the new variable" : "Name for the new constant",
    initial: name,
    suggestions: names,
    note: NOTES[p.reason],
    hint: tx`↵ Apply · Esc Keep '${name}'`,
    onSubmit: (chosen) => void rename(p, chosen, name, { original, applied, plan, ranges }),
  });
}

async function rename(
  p: Prepared,
  chosen: string,
  current: string,
  st: { original: Text; applied: Text; plan: Plan; ranges: { from: number; to: number }[] },
) {
  const { view } = p;
  const name = chosen.replace(/^\$/, "");
  if (!name || name === current) return;
  if (!isIdentifier(name) || isKeyword(name)) {
    showHint(view, `'${chosen}' is not a valid name; kept '${current}'`, { tone: "warning" });
    return;
  }
  if (view.state.doc !== st.applied) {
    showHint(view, "The document changed; the name was not applied");
    return;
  }
  // Redo the whole refactoring with the chosen name, so it stays one undo step.
  const planned = undo(view) && view.state.doc.eq(st.original) ? st.plan(name, view.state) : null;
  if (planned) {
    view.dispatch({
      changes: planned.changes,
      selection: { anchor: caretOf(planned, name) },
      scrollIntoView: true,
      userEvent: "refactor.introduce",
    });
  } else {
    if (view.state.doc !== st.applied) redo(view);
    if (view.state.doc !== st.applied) return;
    view.dispatch({
      changes: st.ranges.map((r) => ({ from: r.from, to: r.to, insert: name })),
      userEvent: "refactor.rename",
    });
  }
  await whenSynced(view);
  const uses = (await structure.identifiers(p.ctx.doc, name).catch(() => [])).filter((o) => !o.qualified).length;
  if (uses > st.ranges.length) showHint(view, `'${name}' is also used elsewhere in this file`, { tone: "warning" });
}
