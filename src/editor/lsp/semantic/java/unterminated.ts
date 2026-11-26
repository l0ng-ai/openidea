import type { Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import type { SemanticRange } from "../languages";

/**
 * Unterminated string and char literals: `@lezer/java` has no token for them and leaves the quote
 * as an error node. IntelliJ's lexer runs such a literal up to the closing quote or the end of the
 * line, so colour that span as a string. (An unterminated text block already runs to the end of file.)
 */
export function javaUnterminatedLiteralRanges(tree: Tree, doc: Text): SemanticRange[] {
  // ponytail: walks the whole tree (~15 ms on a 20,000-line file); cache per TreeBuffer if that shows up.
  const out: SemanticRange[] = [];
  let end = 0;
  tree.iterate({
    enter(node) {
      if (!node.type.isError || node.from >= node.to || node.from < end) return;
      const quote = doc.sliceString(node.from, node.from + 1);
      if (quote !== '"' && quote !== "'") return;
      const line = doc.lineAt(node.from);
      const text = line.text;
      let i = node.from - line.from + 1;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      end = line.from + Math.min(i + 1, text.length);
      out.push({ from: node.from, to: end, className: "cm-sem-java-unterminated-string", source: "syntax" });
    },
  });
  return out;
}
