import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { applySnippet, hasLinkedSnippetField } from "./linkedSnippet";

let view: EditorView;
afterEach(() => view.destroy());

function expand(snippet: string) {
  view = new EditorView({
    state: EditorState.create({ extensions: [EditorState.allowMultipleSelections.of(true)] }),
    parent: document.body,
  });
  applySnippet(view, [{ from: 0, to: 0, snippet }]);
}

const selected = () => view.state.selection.ranges.map(({ from, to }) => view.state.sliceDoc(from, to));
const doc = () => view.state.doc.toString();
const type = (text: string) => view.dispatch(view.state.replaceSelection(text));
const press = (key: string) => runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");

describe("linked snippets", () => {
  it("selects the first occurrence of each variable and mirrors edits within its group", () => {
    expand("${1:x}/${1:x} ${2:y}/${2:y}${0}");
    expect(selected()).toEqual(["x"]);
    expect(view.state.selection.main.from).toBe(0);
    type("name");
    expect(doc()).toBe("name/name y/y");
    expect(press("Tab")).toBe(true);
    expect(selected()).toEqual(["y"]);
    expect(view.state.selection.main.from).toBe("name/name ".length);
    type("label");
    expect(doc()).toBe("name/name label/label");
  });

  it("tracks adjacent empty occurrences and the next variable independently", () => {
    expand("${1}${1}${2:end}${0}");
    expect(selected()).toEqual([""]);
    type("x");
    type("y");
    expect(doc()).toBe("xyxyend");
    expect(press("Tab")).toBe(true);
    expect(selected()).toEqual(["end"]);
    type("!");
    expect(doc()).toBe("xyxy!");
  });

  it.each(["Escape", "Tab"])("ends mirroring on %s", (key) => {
    expand("${1:x}/${1:x}${0}");
    if (key === "Escape") {
      expect(press(key)).toBe(true);
      expect(hasLinkedSnippetField(view.state, 1)).toBe(true);
    }
    expect(press(key)).toBe(true);
    expect(hasLinkedSnippetField(view.state, 1)).toBe(false);
    const { head } = view.state.selection.main;
    expect(head).toBe(key === "Escape" ? 1 : doc().length);
    view.dispatch({ changes: { from: 0, to: 1, insert: "changed" } });
    expect(doc()).toBe("changed/x");
  });

  it("keeps a repeated last placeholder active until the end of the snippet", () => {
    expand("${1:one} ${2:two}/${2:two}");
    expect(press("Tab")).toBe(true);
    expect(selected()).toEqual(["two"]);
    type("new");
    expect(doc()).toBe("one new/new");
    expect(press("Tab")).toBe(true);
    expect(view.state.selection.main.head).toBe(doc().length);
  });

  it("keeps fields linked after a separate edit before the snippet", () => {
    expand("call(${1:arg}, ${1:arg})${0}");
    const prefix = "import call;\n";
    view.dispatch({ changes: { from: 0, insert: prefix }, userEvent: "input.complete" });
    expect(selected()).toEqual(["arg"]);
    type("value");
    expect(doc()).toBe(prefix + "call(value, value)");
    expect(press("Tab")).toBe(true);
    expect(view.state.selection.main.head).toBe(doc().length);
  });
});
