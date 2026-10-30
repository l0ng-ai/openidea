import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

function highlighted(state: EditorState) {
  ensureSyntaxTree(state, state.doc.length, 1000);
  const result: { text: string; style: string }[] = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, style) => {
    result.push({ text: state.doc.sliceString(from, to), style });
  });
  return result;
}

it.each([
  ["Kotlin", 'val text = """${call({ n ->\n  n + 1\n})} tail"""\nval after = 3'],
  ["Scala", 'val text = s"""${call({ n =>\n  n + 1\n})} tail"""\nval after = 3'],
  ["Dart", 'var text = """${call(() {\n  return 1;\n})} tail""";\nvar after = 3;'],
  ["Groovy", 'def text = """${call({ n ->\n  n + 1\n})} tail"""\ndef after = 3'],
  ["C#", 'var text = $@"{call(() => {\n  return 1;\n})} tail";\nvar after = 3;'],
  ["Shell", 'echo "$(echo\n  $((n + 1))\n) tail"\necho 3'],
])("%s incremental highlighting agrees with a fresh parse", async (mode, doc) => {
  const support = await loadSupport(findLanguageDescription(mode, "")!);
  expect(support).toBeTruthy();
  let state = EditorState.create({ doc, extensions: [support!] });
  const original = highlighted(state);
  const position = doc.indexOf("1");
  state = state.update({ changes: { from: position, to: position + 1, insert: "2 + 4" } }).state;
  expect(highlighted(state)).toEqual(highlighted(EditorState.create({ doc: state.doc, extensions: [support!] })));
  expect(highlighted(state)).toContainEqual({ text: "4", style: "tok-number" });
  state = state.update({ changes: { from: position, to: position + 5, insert: "1" } }).state;
  expect(highlighted(state)).toEqual(original);
});

it("loads shell interpolation through the editor's language registry", async () => {
  const support = await loadSupport(findLanguageDescription("Shell", "example.sh")!);
  const out = highlighted(EditorState.create({ doc: 'echo "$name $(echo $((n + 1)))"', extensions: [support!] }));
  expect(out).toContainEqual({ text: "name", style: "tok-variableName" });
  expect(out).toContainEqual({ text: "1", style: "tok-number" });
  expect(out).toContainEqual({ text: "+", style: "tok-operator" });
  expect(out.some((token) => token.text === "$(" && !token.style.includes("string"))).toBe(true);
});
