/** PyCharm's "Insert documentation string stub" intention on a Python function name. */
import { ensureSyntaxTree, indentUnit, syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { ContributedIntention } from "@/editor/api";
import { pythonDocstringLines } from "@/editor/core/cm/docComment";
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { docOf } from "../../lsp";

interface FunctionTarget {
  owner: SyntaxNode;
  body: SyntaxNode;
  firstStatement: SyntaxNode | null;
}

/** The first statement in a function body, with leading comments skipped. */
function firstBodyStatement(body: SyntaxNode): SyntaxNode | null {
  for (let node = body.firstChild?.nextSibling; node; node = node.nextSibling) if (node.name !== "Comment") return node;
  return null;
}

/** Whether an expression is a string literal (including parentheses and implicit concatenation). */
function stringExpression(node: SyntaxNode, text: Text): boolean {
  if (node.name === "String") {
    const prefix = /^[A-Za-z]*(?=["'])/.exec(text.sliceString(node.from, node.to))?.[0] ?? "";
    // Bytes and template strings are expressions, but not Python docstrings.
    return /^(?:r|u|ru|ur)?$/i.test(prefix);
  }
  const parts = node.getChildren("String");
  if (node.name === "ContinuedString") return parts.length > 0 && parts.every((part) => stringExpression(part, text));
  if (node.name === "ParenthesizedExpression") {
    const expressions = node.getChildren().filter((child) => child.name !== "(" && child.name !== ")");
    return expressions.length === 1 && stringExpression(expressions[0]!, text);
  }
  return false;
}

/** The function whose name contains the caret, unless its first statement is already a docstring. */
function functionAtCaret(view: EditorView): FunctionTarget | null {
  const state = view.state;
  const doc = docOf(view);
  const selection = state.selection.main;
  if (doc?.uiMode !== "Python" || doc.readOnly || state.readOnly || !selection.empty) return null;
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  for (let node: SyntaxNode | null = tree.resolveInner(selection.head, -1); node; node = node.parent) {
    if (node.name !== "FunctionDefinition") continue;
    const name = node.getChild("VariableName");
    const body = node.getChild("Body");
    if (!name || !body || selection.head < name.from || selection.head > name.to) return null;
    const firstStatement = firstBodyStatement(body);
    if (
      firstStatement?.name === "ExpressionStatement" &&
      firstStatement.firstChild &&
      stringExpression(firstStatement.firstChild, state.doc)
    )
      return null;
    return { owner: node, body, firstStatement };
  }
  return null;
}

/** Keep the body's existing indentation, or add one editor indent unit to the definition's own. */
function docstringIndent(view: EditorView, target: FunctionTarget): string {
  const state = view.state;
  const definitionLine = state.doc.lineAt(target.owner.from);
  const base = /^[ \t]*/.exec(definitionLine.text)![0];
  const first = target.firstStatement;
  if (first) {
    const line = state.doc.lineAt(first.from);
    if (line.number > state.doc.lineAt(target.body.from).number) {
      const existing = /^[ \t]*/.exec(line.text)![0];
      if (existing.length > base.length && existing.startsWith(base)) return existing;
    }
  }
  return base + (state.facet(indentUnit) || "    ");
}

function insertPythonDocstring(view: EditorView): void {
  // Re-resolve after the popup was opened: a stale action must not edit a different function.
  const target = functionAtCaret(view);
  if (!target) return;
  const state = view.state;
  const indent = docstringIndent(view, target);
  const lines = [
    indent + '"""',
    ...pythonDocstringLines(state.doc.toString(), target.owner, editorPrefs().docstringFormat, indent, '"""'),
  ];
  const stub = lines.join(state.lineBreak);
  const headerLine = state.doc.lineAt(target.body.from);
  const first = target.firstStatement;
  const inline = first && state.doc.lineAt(first.from).number === headerLine.number;
  const br = state.lineBreak;
  const from = inline ? headerLine.from + target.body.from - headerLine.from + 1 : headerLine.to;
  const tail = inline ? headerLine.text.slice(target.body.from - headerLine.from + 1).trimStart() : "";
  const insert = `${br}${stub}${inline ? `${br}${indent}${tail}` : ""}`;
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + br.length + indent.length },
    userEvent: "input",
    scrollIntoView: true,
  });
}

/** The local intention, available with the caret on a function name and no language server required. */
export function pythonDocstringIntentions(view: EditorView): ContributedIntention[] {
  if (!functionAtCaret(view)) return [];
  return [
    {
      id: "python.insertDocstring",
      label: tx`Insert a documentation string stub`,
      icon: "bulb",
      run: () => insertPythonDocstring(view),
    },
  ];
}
