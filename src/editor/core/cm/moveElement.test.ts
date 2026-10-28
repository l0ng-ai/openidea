import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { moveElementLeft, moveElementRight } from "./moveElement";

/** `|` marks the caret; returns the text (with caret) after running `cmd`. */
function run(text: string, cmd: typeof moveElementLeft): string {
  const pos = text.indexOf("|");
  const view = new EditorView({
    state: EditorState.create({ doc: text.replace("|", ""), selection: EditorSelection.cursor(pos) }),
  });
  cmd(view);
  const head = view.state.selection.main.head;
  const doc = view.state.doc.toString();
  view.destroy();
  return doc.slice(0, head) + "|" + doc.slice(head);
}

describe("Move Element Left / Right", () => {
  it("swaps call arguments, keeping the caret in the moved one", () => {
    expect(run("f(a|lpha, b)", moveElementRight)).toBe("f(b, a|lpha)");
    expect(run("f(alpha, b|eta)", moveElementLeft)).toBe("f(b|eta, alpha)");
  });

  it("moves a nested call within the enclosing list", () => {
    expect(run("f(g(|x), y)", moveElementRight)).toBe("f(y, g(|x))");
  });

  it("ignores commas in strings and nested brackets", () => {
    expect(run('f("a, b", [1, 2], |c)', moveElementLeft)).toBe('f("a, b", |c, [1, 2])');
  });

  it("does nothing at the end of the list", () => {
    expect(run("f(a, |b)", moveElementRight)).toBe("f(a, |b)");
  });

  it("works across lines", () => {
    expect(run("[\n  one,\n  |two,\n]", moveElementLeft)).toBe("[\n  |two,\n  one,\n]");
  });
});
