/**
 * IDEA puts a new line breakpoint only where there is code: a gutter click or Toggle Line
 * Breakpoint on a blank or comment-only line does nothing. Comments come from the syntax
 * tree; in a file without a parser only blank lines are skipped.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

const PARSE_BUDGET_MS = 20;

function commentAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) if (/comment/i.test(n.name)) return n;
  return null;
}

/** Whether `line` (0-based) has anything besides whitespace and comments. */
export function lineHasCode(state: EditorState, line: number): boolean {
  if (line < 0 || line >= state.doc.lines) return false;
  const { from, to, text } = state.doc.line(line + 1);
  if (!/\S/.test(text)) return false;
  const tree = ensureSyntaxTree(state, to, PARSE_BUDGET_MS) ?? syntaxTree(state);
  for (let pos = from; pos < to;) {
    if (/\s/.test(text[pos - from]!)) {
      pos++;
      continue;
    }
    const comment = commentAt(tree, pos);
    if (!comment) return true;
    pos = Math.max(pos + 1, comment.to);
  }
  return false;
}
