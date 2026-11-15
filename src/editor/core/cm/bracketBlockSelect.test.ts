import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { braceBlock, braceNextTo } from "./bracketBlockSelect";

const DOC = "int f(Object raw) {\n    if (a) {\n        g(b[0]);\n    }\n}";
const state = EditorState.create({ doc: DOC });

describe("double-clicking a curly brace", () => {
  it("selects the block from the opening brace to its match, both included (IDEA)", () => {
    const open = DOC.indexOf("{");
    expect(braceBlock(state, open)).toEqual({ from: open, to: DOC.length });
  });

  it("selects the same block from the closing brace", () => {
    const inner = DOC.indexOf("{", DOC.indexOf("if"));
    const close = DOC.indexOf("}");
    expect(braceBlock(state, close)).toEqual({ from: inner, to: close + 1 });
  });

  it("takes the brace next to the caret the click gives, past the end of the line too", () => {
    const open = DOC.indexOf("{");
    const lineEnd = state.doc.line(1).to;
    expect(braceNextTo(state, lineEnd, false)).toBe(open);
    expect(braceNextTo(state, open, false)).toBe(open);
    const close = DOC.lastIndexOf("}");
    expect(braceNextTo(state, close, false)).toBe(close);
    // On a word, or away from braces, the double-click selects the word.
    expect(braceNextTo(state, open, true)).toBeNull();
    expect(braceNextTo(state, DOC.indexOf("raw"), false)).toBeNull();
  });

  it("leaves parentheses, brackets, other characters and unmatched braces to the word selection", () => {
    expect(braceBlock(state, DOC.indexOf("("))).toBeNull();
    expect(braceBlock(state, DOC.indexOf("["))).toBeNull();
    expect(braceBlock(state, DOC.indexOf("raw"))).toBeNull();
    expect(braceBlock(EditorState.create({ doc: "f {" }), 2)).toBeNull();
  });
});
