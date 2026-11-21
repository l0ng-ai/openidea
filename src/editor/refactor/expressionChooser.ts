import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@/bindings";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { rangeToOffsets } from "@/editor/lsp/positions";
import { clearTemporaryHighlight, highlightRanges } from "@/editor/lsp/tempHighlight";
import { tx } from "@/platform/i18n";

function expressionLabel(text: string): string {
  const source = text.trim();
  const firstLine = (source.match(/^.{0,100}/u)?.[0] ?? "").trimEnd();
  return firstLine.length === source.length ? firstLine : `${firstLine}…`;
}

export function showExpressionChooser(
  view: EditorView,
  doc: Text,
  head: number,
  candidates: readonly SyntaxNode[],
  select: (candidate: SyntaxNode) => void | Promise<void>,
) {
  const clearPreview = () => clearTemporaryHighlight(view);
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, head),
    title: tx("Expressions"),
    compact: true,
    items: candidates.map((candidate, index) => {
      const range = rangeToOffsets(doc, candidate.range);
      return {
        id: String(index),
        label: expressionLabel(doc.sliceString(range.from, range.to)),
        onActive: () => {
          if (view.state.doc !== doc) return;
          highlightRanges(view, [range]);
          return clearPreview;
        },
        run: () => select(candidate),
      };
    }),
    onClose: clearPreview,
  });
}
