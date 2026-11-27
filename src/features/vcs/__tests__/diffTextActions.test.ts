import { javascript } from "@codemirror/lang-javascript";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerEditorActions } from "@/editor/core/actions";
import { viewerBase } from "../cm";

let dispose: () => void;
const views: EditorView[] = [];

beforeAll(() => {
  dispose = registerEditorActions();
});
afterAll(() => dispose());
afterEach(() => {
  setContext("diffEditorFocus", false);
  for (const view of views.splice(0)) view.destroy();
});

/** A focused diff pane, as the diff editor's viewer builds it. */
function pane(doc: string, readOnly: boolean, anchor = 0, head = anchor): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [javascript(), viewerBase({ readOnly, findBar: true })],
    }),
  });
  views.push(view);
  view.contentDOM.focus();
  setContext("diffEditorFocus", true);
  return view;
}

describe("text actions in a diff", () => {
  it("edit the focused editable side", async () => {
    const view = pane("let a = 1;\nlet b = 2;", false);
    expect(await executeAction("code.commentLine")).toBe(true);
    expect(view.state.doc.line(1).text).toBe("//let a = 1;");
    await executeAction("code.duplicateLine");
    expect(view.state.doc.lines).toBe(3);
  });

  it("add a selection for the next occurrence on either side", async () => {
    const view = pane("foo bar foo baz foo", true, 0, 3);
    await executeAction("code.addCaretNextOccurrence");
    await executeAction("code.addCaretNextOccurrence");
    expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 3],
      [8, 11],
      [16, 19],
    ]);
  });

  it("search again from the top once no next occurrence is left", async () => {
    const view = pane("foo bar foo", false, 8, 11);
    await executeAction("code.addCaretNextOccurrence");
    expect(view.state.selection.ranges).toHaveLength(1);
    await executeAction("code.addCaretNextOccurrence");
    expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("leave a side that can't be edited as it is", async () => {
    const view = pane("let a = 1;", true);
    await executeAction("code.commentLine");
    await executeAction("code.duplicateLine");
    expect(view.state.doc.toString()).toBe("let a = 1;");
  });
});
