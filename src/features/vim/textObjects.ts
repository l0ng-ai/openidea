/**
 * `af` / `if`: the function around the cursor, from the syntax tree — the
 * whole function, or its body without the braces. A repeated `af` / `if` in
 * Visual mode, or a count, takes the next enclosing function.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { Vim } from "@replit/codemirror-vim";

/** Functions, methods, constructors and lambdas across the Lezer grammars. */
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionDefinition",
  "FunctionExpression",
  "ArrowFunction",
  "MethodDeclaration",
  "ConstructorDeclaration",
  "CompactConstructorDeclaration",
  "LambdaExpression",
  "FunctionItem",
  "ClosureExpression",
  "FunctionDecl",
  "MethodDecl",
  "FunctionLiteral",
]);
/** A function's body; a lambda without one has an expression body (its last child). */
const BODIES = new Set(["Block", "Body", "CompoundStatement", "ConstructorBody"]);
const LAMBDAS = new Set(["ArrowFunction", "LambdaExpression", "ClosureExpression"]);

interface TextObjectRange {
  from: number;
  to: number;
  /** Whole lines: the operator or Visual mode works linewise. */
  linewise: boolean;
}

const blank = (s: string) => !s.trim();

function body(fn: SyntaxNode): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let c = fn.firstChild; c; c = c.nextSibling) if (BODIES.has(c.name)) found = c;
  return found ?? (LAMBDAS.has(fn.name) ? fn.lastChild : null);
}

function rangeOf(state: EditorState, fn: SyntaxNode, inner: boolean): TextObjectRange | null {
  const doc = state.doc;
  if (!inner) {
    const first = doc.lineAt(fn.from);
    const last = doc.lineAt(fn.to);
    const lines =
      blank(doc.sliceString(first.from, fn.from)) &&
      blank(doc.sliceString(fn.to, last.to)) &&
      first.number < last.number;
    return lines ? { from: first.from, to: last.to, linewise: true } : { from: fn.from, to: fn.to, linewise: false };
  }
  const b = body(fn);
  if (!b) return null;
  let from = b.from;
  let to = b.to;
  if (b.firstChild && (b.firstChild.name === "{" || b.firstChild.name === ":")) from = b.firstChild.to;
  if (b.lastChild?.name === "}") to = b.lastChild.from;
  // Braces on their own lines: the lines between them.
  const open = doc.lineAt(from);
  const close = doc.lineAt(to);
  if (open.number < close.number && blank(doc.sliceString(from, open.to))) {
    const start = doc.line(open.number + 1).from;
    const end = blank(doc.sliceString(close.from, to)) ? doc.line(close.number - 1).to : to;
    if (start > end) return null;
    return { from: start, to: end, linewise: end === doc.lineAt(end).to && to !== end };
  }
  return from < to ? { from, to, linewise: false } : null;
}

/**
 * The `count`th function around `pos` (1 = innermost). With `covered` (a Visual
 * selection), functions whose range lies within it are skipped, so repeating
 * the text object grows the selection outwards.
 */
export function functionTextObject(
  state: EditorState,
  pos: number,
  inner: boolean,
  count = 1,
  covered?: { from: number; to: number },
): TextObjectRange | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const ranges: TextObjectRange[] = [];
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (!FUNCTIONS.has(n.name)) continue;
    const r = rangeOf(state, n, inner);
    if (r) ranges.push(r);
  }
  let i = 0;
  while (covered && i < ranges.length && ranges[i]!.from >= covered.from && ranges[i]!.to <= covered.to) i++;
  return ranges[i + Math.max(0, count - 1)] ?? null;
}

interface VimCm {
  cm6: EditorView;
  indexFromPos(pos: { line: number; ch: number }): number;
  posFromIndex(offset: number): { line: number; ch: number };
}
interface VimState {
  visualMode: boolean;
  visualLine: boolean;
  sel: { anchor: { line: number; ch: number }; head: { line: number; ch: number } };
}

let defined = false;

/** Defines the motion behind `af` / `if` (once). */
function defineFunctionTextObjects() {
  if (defined) return;
  defined = true;
  Vim.defineMotion("openideaFunction", ((
    cm: VimCm,
    head: { line: number; ch: number },
    args: { textObjectInner?: boolean; repeat?: number; linewise?: boolean },
    vim: VimState,
  ) => {
    const state = cm.cm6.state;
    let covered: { from: number; to: number } | undefined;
    if (vim.visualMode) {
      const a = cm.indexFromPos(vim.sel.anchor);
      const h = cm.indexFromPos(vim.sel.head);
      // A Visual head is inclusive; a fresh `v` covers only the cursor.
      if (a !== h) covered = { from: Math.min(a, h), to: Math.max(a, h) + 1 };
      if (vim.visualLine && covered) {
        covered = { from: state.doc.lineAt(covered.from).from, to: state.doc.lineAt(covered.to - 1).to };
      }
    }
    const r = functionTextObject(state, cm.indexFromPos(head), !!args.textObjectInner, args.repeat ?? 1, covered);
    if (!r) return null;
    if (r.linewise) {
      if (vim.visualMode) {
        if (!vim.visualLine) {
          vim.visualLine = true;
          (cm.constructor as { signal?: (...a: unknown[]) => void }).signal?.(cm, "vim-mode-change", {
            mode: "visual",
            subMode: "linewise",
          });
        }
      } else args.linewise = true;
      return [cm.posFromIndex(r.from), cm.posFromIndex(r.to)];
    }
    return [cm.posFromIndex(r.from), cm.posFromIndex(vim.visualMode ? r.to - 1 : r.to)];
  }) as never);
}

/** Maps `af` / `if` in Operator-pending and Visual mode; again after every `mapclear`. */
export function mapFunctionTextObjects() {
  defineFunctionTextObjects();
  for (const context of ["operatorPending", "visual"]) {
    Vim._mapCommand({ keys: "af", type: "motion", motion: "openideaFunction", context } as never);
    Vim._mapCommand({
      keys: "if",
      type: "motion",
      motion: "openideaFunction",
      motionArgs: { textObjectInner: true },
      context,
    } as never);
  }
}
