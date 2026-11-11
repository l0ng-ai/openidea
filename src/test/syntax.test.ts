import { expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { completedSyntaxState, completedSyntaxTree } from "./syntax";

const cases = [
  ["Python", "def f(self):\n    value = b'bytes'\n    self.run(whatever=1)\n"],
  ["ERB", "<div><%= user.name if user %></div>\n<% 42 %>"],
  ["CMake", "set(CMAKE_CXX_STANDARD 17)\nmessage(STATUS hello)"],
  ["Kotlin", 'val text = "${n + 1} tail"\nval after = 3'],
  ["Scala", 'val text = s"${n + 1} tail"\nval after = 3'],
  ["Dart", 'var text = "${n + 1} tail";\nvar after = 3;'],
  ["Groovy", 'def text = "${n + 1} tail"\ndef after = 3'],
  ["C#", 'var text = $"{n + 1} tail";\nvar after = 3;'],
  ["Shell", 'echo "$name $(echo $((n + 1)))"\necho 3'],
  ["JavaScript", 'function f() { return "("; } // TODO'],
  ["TypeScript", "function f(value: number) { return value + 1; }"],
  ["Java", "class Demo { int f() { return 1; } }"],
  ["Rust", "fn f() -> i32 { 1 }"],
  ["Go", "package main\nfunc f() int { return 1 }"],
  ["JSP", "<% if (ready) { %><p><%= value %></p><% } %>"],
  ["Angular Template", "@if (ready) {\n  <p>{{ value }}</p>\n}"],
  ["Django Template", "{% if ready %}\n  <p>{{ value|lower }}</p>\n{% endif %}"],
];

function highlights(state: EditorState) {
  const out: Array<[number, number, string]> = [];
  highlightTree(completedSyntaxTree(state), classHighlighter, (from, to, style) => out.push([from, to, style]));
  return out;
}

it.each(cases)(
  "%s completes an interrupted initial parse and publishes it for state consumers",
  async (mode, source) => {
    const doc = `${source}\n`.repeat(30);
    const support = await loadSupport(findLanguageDescription(mode!, "")!);
    expect(support).toBeTruthy();
    const create = () => EditorState.create({ doc, selection: EditorSelection.cursor(2), extensions: [support!] });
    const expected = highlights(create());
    expect(expected.length).toBeGreaterThan(0);
    let now = 0;
    // Force initial parsing to yield, then let completion run without clock pressure.
    const clock = vi.spyOn(Date, "now");
    const interrupted = () => {
      clock.mockImplementation(() => (now += 25));
      const state = create();
      clock.mockReturnValue(now);
      return state;
    };
    try {
      const initial = interrupted();
      expect(syntaxTree(initial).length).toBeLessThan(initial.doc.length);
      const tree = completedSyntaxTree(initial);
      expect(tree.length).toBe(initial.doc.length);
      expect(syntaxTree(initial).length).toBeLessThan(initial.doc.length);
      expect(highlights(initial)).toEqual(expected);

      const state = completedSyntaxState(interrupted());
      expect(syntaxTree(state).length).toBe(state.doc.length);
      expect(state.selection.main.head).toBe(2);
      expect(state.doc.toString()).toBe(doc);
      expect(highlights(state)).toEqual(expected);
      const edited = state.update({ changes: { from: 0, insert: "\n" } }).state;
      const fresh = EditorState.create({ doc: edited.doc, extensions: [support!] });
      expect(highlights(edited)).toEqual(highlights(fresh));
    } finally {
      clock.mockRestore();
    }
  },
);

it("preserves states without a language for lexical fallback tests", () => {
  const state = EditorState.create({ doc: "f(a[b])" });
  expect(completedSyntaxState(state)).toBe(state);
});

it("fails explicitly when a tree cannot be completed", () => {
  expect(() => completedSyntaxTree(EditorState.create())).toThrow("Test syntax parsing did not finish");
});
