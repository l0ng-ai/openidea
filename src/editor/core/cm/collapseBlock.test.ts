import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldedRanges } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { enclosingCodeBlock, selectCodeBlockEnd, selectCodeBlockStart } from "./caretCommands";
import { collapseBlock, collapseBlockEffects } from "./folding";

const text = "fn a() {\n  if x { y(); }\n  z();\n}\n";
const at = (needle: string) => text.indexOf(needle);
const state = (pos: number) =>
  EditorState.create({ doc: text, selection: EditorSelection.cursor(pos), extensions: [codeFolding()] });

describe("enclosingCodeBlock", () => {
  it("is the inside of the innermost block", () => {
    expect(enclosingCodeBlock(state(0), at("y()"))).toEqual({ from: at("{ y") + 1, to: at("}\n  z") });
  });

  it("after a closing brace is the block it closes", () => {
    expect(enclosingCodeBlock(state(0), at("}\n  z") + 1)).toEqual({ from: at("{ y") + 1, to: at("}\n  z") });
  });

  it("is null outside any block", () => {
    expect(enclosingCodeBlock(state(0), 0)).toBeNull();
  });
});

describe("collapseBlockEffects", () => {
  it("folds the block around the caret, then the enclosing one", () => {
    const s = state(at("y()"));
    const first = collapseBlockEffects(s);
    expect(first.map((e) => e.value)).toEqual([{ from: at("{ y") + 1, to: at("}\n  z") }]);
    const folded = s.update({ effects: first }).state;
    expect(collapseBlockEffects(folded).map((e) => e.value)).toEqual([
      { from: at("{\n") + 1, to: text.lastIndexOf("}") },
    ]);
    expect(first.every((e) => e.is(foldEffect))).toBe(true);
  });
});

describe("code block with selection", () => {
  it("extends the selection to the block start and end", () => {
    const view = new EditorView({ state: state(at("z()")) });
    selectCodeBlockEnd(view);
    expect(view.state.selection.main).toMatchObject({ anchor: at("z()"), head: text.lastIndexOf("}") });
    view.dispatch({ selection: EditorSelection.cursor(at("z()")) });
    selectCodeBlockStart(view);
    expect(view.state.selection.main).toMatchObject({ anchor: at("z()"), head: at("{\n") + 1 });
    view.destroy();
  });
});

describe("collapseBlock", () => {
  it("keeps the fold by moving a caret inside it onto the fold", () => {
    const view = new EditorView({ state: state(at("y()")) });
    collapseBlock(view);
    // A later selection change would unfold a fold around the caret.
    view.dispatch({ selection: view.state.selection });
    expect(foldedRanges(view.state).size).toBe(1);
    expect(view.state.selection.main.head).toBe(at("{ y") + 1);
    view.destroy();
  });
});
