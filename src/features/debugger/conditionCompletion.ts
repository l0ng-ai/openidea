/**
 * Completion for a breakpoint's condition and logged expressions without a debug session: the
 * language server completes the expression spliced in on its own line before the breakpoint's
 * line, in a snapshot of the file, so locals in scope, fields and members after `.` resolve
 * there. The open document is not changed.
 */
import type { CompletionItem } from "@/bindings";
import { attachDocument } from "@/editor/api";
import { lspSnippetToPlainWithCaret } from "@/editor/lsp/snippet";
import { call, commands, nextRequestId } from "@/platform/ipc";
import type { CompletionSource, ExpressionCompletionItem } from "./ui/ExpressionCompletion";

/** `text` with `expression` on a new line before 0-based `line`, indented like it, and the position after it. */
export function spliceExpression(
  text: string,
  line: number,
  expression: string,
): { text: string; pos: { line: number; col: number } } {
  const lines = text.split("\n");
  const at = Math.max(0, Math.min(line, lines.length));
  const indent = /^[ \t]*/.exec(lines[at] ?? "")![0];
  lines.splice(at, 0, indent + expression);
  return { text: lines.join("\n"), pos: { line: at, col: indent.length + expression.length } };
}

/** A language server item as the expression popup shows it: plain text, the caret at its first tab stop, empty. */
export function expressionItem(item: CompletionItem): ExpressionCompletionItem {
  const insert = item.isSnippet
    ? lspSnippetToPlainWithCaret(item.insertText.replace(/\$\{(\d+):[^{}]*\}/g, "$$$1"))
    : { text: item.insertText, caret: item.insertText.length };
  return {
    label: item.label + (item.labelDetail ?? ""),
    text: insert.text,
    caret: insert.caret,
    kind: item.kind,
    detail: item.labelDescription ?? item.detail,
    sortText: item.sortText,
  };
}

/** Completions at the breakpoint on 0-based `line` of `path`, for the expression typed so far. */
export function breakpointCompletionSource(path: string, line: number): CompletionSource {
  return async (before) => {
    const doc = await attachDocument(path);
    let text: string;
    try {
      text = doc.text();
    } finally {
      doc.release();
    }
    const snapshot = spliceExpression(text, line, before);
    const items = await call(commands.lspSnapshotCompletion(path, snapshot.text, snapshot.pos, nextRequestId()));
    return items.map(expressionItem);
  };
}
