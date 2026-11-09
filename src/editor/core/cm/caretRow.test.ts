import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { caretRowHighlight } from "./caretRow";

const rows = (selection: EditorSelection) => {
  const view = new EditorView({
    state: EditorState.create({
      doc: "one\ntwo\nthree\nfour",
      selection,
      extensions: [caretRowHighlight, EditorState.allowMultipleSelections.of(true)],
    }),
    parent: document.body,
  });
  const out = [...view.dom.querySelectorAll(".cm-activeLine")].map((l) => l.textContent);
  view.destroy();
  return out;
};

describe("caret row", () => {
  it("highlights the caret's row", () => {
    expect(rows(EditorSelection.single(5))).toEqual(["two"]);
  });

  it("keeps the row highlighted under a selected word, as IDEA", () => {
    expect(rows(EditorSelection.single(4, 7))).toEqual(["two"]);
  });

  it("highlights the row of the caret (the head) under a selection over several lines", () => {
    expect(rows(EditorSelection.single(0, 10))).toEqual(["three"]);
    expect(rows(EditorSelection.single(10, 0))).toEqual(["one"]);
  });

  it("highlights each caret's row once", () => {
    expect(
      rows(EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(2, 3), EditorSelection.cursor(9)])),
    ).toEqual(["one", "three"]);
  });
});
