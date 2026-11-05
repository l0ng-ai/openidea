import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { selectionMarks } from "./selectionMarks";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function view(doc: string, selection: EditorSelection, extensions: Extension) {
  extensions = [EditorState.allowMultipleSelections.of(true), extensions];
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({ state: EditorState.create({ doc, selection, extensions }), parent });
  views.push(v);
  return v;
}

/** A background mark as features add it (lint range, find match, usage, semantic bg…). */
const backgroundMark = (cls: string, from: number, to: number, prec: (e: Extension) => Extension = (e) => e) =>
  prec(EditorView.decorations.of(Decoration.set(Decoration.mark({ class: cls }).range(from, to))));

const DOC = "return request.app.state.credits";

describe("selectionMarks", () => {
  it.each([
    ["default", (e: Extension) => e],
    ["high (Lezer highlighter)", Prec.high],
    ["lowest", Prec.lowest],
  ])("paints selected text inside a %s-precedence background mark", (_, prec) => {
    // The reporter's case: a light-scheme warning background over `request.app.state.credits`.
    const v = view(DOC, EditorSelection.single(7, DOC.length), [
      backgroundMark("cm-lintRange-warning", 7, DOC.length, prec),
      selectionMarks,
    ]);
    const selected = [...v.contentDOM.querySelectorAll(".cm-openidea-selected")];
    expect(selected.map((e) => e.textContent).join("")).toBe(DOC.slice(7));
    for (const el of selected) expect(el.closest(".cm-lintRange-warning")).not.toBeNull();
  });

  it("covers every range of a multi-selection, partially overlapping marks too", () => {
    const v = view(DOC, EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(10, 20)], 1), [
      backgroundMark("cm-openidea-findMatch", 15, 24),
      selectionMarks,
    ]);
    const text = [...v.contentDOM.querySelectorAll(".cm-openidea-selected")].map((e) => e.textContent).join("|");
    expect(text.replace(/\|/g, "")).toBe(DOC.slice(0, 3) + DOC.slice(10, 20));
    const inMatch = [...v.contentDOM.querySelectorAll(".cm-openidea-findMatch .cm-openidea-selected")];
    expect(inMatch.map((e) => e.textContent).join("")).toBe(DOC.slice(15, 20));
  });

  it("adds nothing for an empty selection and clears when the selection collapses", () => {
    const v = view(DOC, EditorSelection.single(0, 6), [selectionMarks]);
    expect(v.contentDOM.querySelector(".cm-openidea-selected")).not.toBeNull();
    v.dispatch({ selection: EditorSelection.cursor(3) });
    expect(v.contentDOM.querySelector(".cm-openidea-selected")).toBeNull();
  });
});
