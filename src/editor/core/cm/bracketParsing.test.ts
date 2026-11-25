import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, matchBrackets, syntaxTree } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { heavyExtension } from "./setup";

it("refreshes the closing brace highlight when parsing reaches a stationary caret", () => {
  const doc = "function scope() {\n" + "  const value = 42;\n".repeat(240) + "}";
  const state = EditorState.create({ doc, extensions: [javascript(), heavyExtension(doc.length)] });
  const view = new EditorView({ state, parent: document.body });
  try {
    view.dispatch({ selection: { anchor: doc.length } });
    expect(syntaxTree(view.state).length).toBeLessThan(doc.length);
    expect(forceParsing(view, doc.length, Infinity)).toBe(true);
    expect(matchBrackets(view.state, doc.length, -1)?.matched).toBe(true);
    expect([...view.contentDOM.querySelectorAll(".cm-matchingBracket")].map((mark) => mark.textContent)).toEqual([
      "{",
      "}",
    ]);
    expect(view.contentDOM.querySelector(".cm-nonmatchingBracket")).toBeNull();
  } finally {
    view.destroy();
  }
});
