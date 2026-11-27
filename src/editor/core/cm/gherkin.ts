/**
 * Gherkin (`.feature`): the legacy-mode highlighting (keywords in every Gherkin
 * language, tags, tables, doc strings, `<placeholders>`) plus folding of each
 * section, step argument and doc string by indentation, as Cucumber's outline does.
 */
import { LanguageSupport, StreamLanguage, foldService } from "@codemirror/language";
import { gherkin } from "@codemirror/legacy-modes/mode/gherkin";
import type { EditorState } from "@codemirror/state";

export const gherkinLanguage = StreamLanguage.define(gherkin);

const indentOf = (text: string) => /^\s*/.exec(text)![0].replace(/\t/g, "  ").length;

/**
 * A header line — `Feature:`, `Scenario:`, a step ending in `:` before its table, an
 * opening `"""` — folds the more indented lines below it, up to the last of them.
 */
export function gherkinFold(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const doc = state.doc;
  const header = doc.lineAt(lineStart);
  const text = header.text.trim();
  if (!text || text.startsWith("#") || text.startsWith("|") || text.startsWith("@")) return null;
  const docString = /^("""|```)/.exec(text);
  if (docString) {
    // The matching closing fence, at any indentation.
    for (let n = header.number + 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (line.text.trim().startsWith(docString[1]!))
        return n > header.number + 1 ? { from: lineEnd, to: line.to } : null;
    }
    return null;
  }
  if (!text.endsWith(":") && !/^[^\s:]+(\s[^\s:]+)*:\s/.test(text)) return null;
  const own = indentOf(header.text);
  let last = header.number;
  for (let n = header.number + 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.trim()) continue;
    if (indentOf(line.text) <= own && !line.text.trim().startsWith("#")) break;
    last = n;
  }
  return last > header.number ? { from: lineEnd, to: doc.line(last).to } : null;
}

export function gherkinSupport(): LanguageSupport {
  return new LanguageSupport(gherkinLanguage, [foldService.of(gherkinFold)]);
}
