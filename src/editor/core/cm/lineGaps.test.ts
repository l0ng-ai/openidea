import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Guards our `@codemirror/view` patch (patches/@codemirror__view.patch): line gaps hide the parts of
// long unwrapped lines outside the viewport, and while a scroll target is set every long line renders
// the part at the target's x.
const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

const LINE = Array.from({ length: 2_000 }, (_, i) => `(${i},'row ${i}')`).join(",");

function editor(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({ state: EditorState.create({ doc }), parent });
  views.push(v);
  return v;
}

/** Selects `range` with `scrollIntoView` and runs the measure pass (jsdom has no frames to run it). */
function scrollTo(v: EditorView, range: SelectionRange) {
  v.dispatch({ selection: EditorSelection.create([range]), scrollIntoView: true });
  (v as unknown as { measure(): void }).measure();
}

const lineTexts = (v: EditorView) => [...v.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent!);

describe("line gaps", () => {
  it("keeps the long lines' starts while Shift+Down extends the selection", () => {
    const v = editor(Array.from({ length: 5 }, (_, i) => `${i}${LINE}`).join("\n"));
    for (let n = 2; n <= 5; n++) {
      // The head is at the start of line n: every line renders its start.
      scrollTo(v, EditorSelection.range(0, v.state.doc.line(n).from));
      expect(lineTexts(v).map((t) => t.slice(0, 1))).toEqual(["0", "1", "2", "3", "4"]);
    }
  });

  it("renders the long lines' ends when the caret jumps to the end of the last one", () => {
    const v = editor(Array.from({ length: 5 }, (_, i) => `${i}${LINE}END${i}`).join("\n"));
    // Ctrl+End: the target is the end of the last line, so every line of that length shows its end.
    scrollTo(v, EditorSelection.cursor(v.state.doc.length));
    expect(lineTexts(v).map((t, i) => t.endsWith(`END${i}`))).toEqual([true, true, true, true, true]);
  });
});
