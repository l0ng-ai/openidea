import { EditorSelection, EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { selectionCode } from "./selection";

const DOC = "def f():\n    for i in range(2):\n        print(i)\n    print('done')\n";
const at = (from: number, to = from) =>
  selectionCode(EditorState.create({ doc: DOC, selection: EditorSelection.single(from, to) }));

it("sends the caret's line when nothing is selected", () => {
  expect(at(DOC.indexOf("print(i)"))).toBe("        print(i)");
});

it("gives a selection that starts after the indentation its indentation back", () => {
  // Selected from `for` (as a double-click or Shift+Down from there selects) to the end.
  expect(at(DOC.indexOf("for"), DOC.length)).toBe("    for i in range(2):\n        print(i)\n    print('done')\n");
});

it("leaves a selection that starts mid-statement as it is", () => {
  expect(at(DOC.indexOf("range"), DOC.indexOf(":\n        print"))).toBe("range(2)");
});
