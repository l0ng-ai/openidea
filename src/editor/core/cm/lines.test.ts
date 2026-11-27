import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import {
  convertIndentsToSpaces,
  convertIndentsToSpacesSpec,
  convertIndentsToTabs,
  convertIndentsToTabsSpec,
  reverseLinesSpec,
  sortLinesSpec,
  uniqueLines,
  uniqueLinesSpec,
} from "./lines";
import { formatIndentFacet } from "./setup";

function apply(doc: string, sel: EditorSelection | undefined, fn: typeof sortLinesSpec, tabSize = 4) {
  const state = EditorState.create({
    doc,
    selection: sel,
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.tabSize.of(tabSize)],
  });
  const spec = fn(state);
  return spec ? state.update(spec).state.doc.toString() : null;
}

describe("Sort Lines / Reverse Lines", () => {
  it("sorts the whole file without a selection", () => {
    expect(apply("c\na\nb", undefined, sortLinesSpec)).toBe("a\nb\nc");
    expect(apply("c\na\nb", undefined, reverseLinesSpec)).toBe("b\na\nc");
    expect(apply("c\nb\na\n", undefined, sortLinesSpec)).toBe("a\nb\nc\n");
    expect(apply("c\nb\na\n", undefined, reverseLinesSpec)).toBe("a\nb\nc\n");
  });

  it("sorts only the selected lines (a selection ending at a line start excludes that line)", () => {
    const doc = "z\nc\nb\na\ny";
    const sel = EditorSelection.single(2, 8); // "c\nb\na\n"
    expect(apply(doc, sel, sortLinesSpec)).toBe("z\na\nb\nc\ny");
  });

  it("handles several selections independently", () => {
    const doc = "b\na\n--\nd\nc";
    const sel = EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(7, 10)]);
    expect(apply(doc, sel, sortLinesSpec)).toBe("a\nb\n--\nc\nd");
  });

  it("sorts by code unit, uppercase before lowercase, as IDEA does", () => {
    const doc = '"github:opentofu/tofu-ls" = "0.5"\n"github:PowerShell/PowerShellEditorServices" = "4.7"';
    expect(apply(doc, undefined, sortLinesSpec)).toBe(
      '"github:PowerShell/PowerShellEditorServices" = "4.7"\n"github:opentofu/tofu-ls" = "0.5"',
    );
    expect(apply("b\nB\na\nA\n_\n1", undefined, sortLinesSpec)).toBe("1\nA\nB\n_\na\nb");
  });

  it("does nothing for a single line or an already sorted block", () => {
    expect(apply("only", undefined, sortLinesSpec)).toBeNull();
    expect(apply("a\nb", undefined, sortLinesSpec)).toBeNull();
  });
});

describe("Delete Duplicate Lines", () => {
  it("keeps the first of each repeated line in the whole file without a selection", () => {
    expect(apply("b\na\nb\nc\na", undefined, uniqueLinesSpec)).toBe("b\na\nc");
    expect(apply("a\na\na\n", undefined, uniqueLinesSpec)).toBe("a\n");
  });

  it("compares the exact text, whitespace and case included", () => {
    expect(apply("a\na \n a\nA\na", undefined, uniqueLinesSpec)).toBe("a\na \n a\nA");
  });

  it("removes repeated blank lines too, but keeps the empty line after a final newline", () => {
    expect(apply("a\n\nb\n\nc\n", undefined, uniqueLinesSpec)).toBe("a\n\nb\nc\n");
  });

  it("dedupes only the selected lines (a selection ending at a line start excludes that line)", () => {
    const doc = "x\na\nx\na\nx";
    const sel = EditorSelection.single(2, 8); // "a\nx\na\n"
    expect(apply(doc, sel, uniqueLinesSpec)).toBe("x\na\nx\nx");
  });

  it("treats Select All like no selection, keeping the empty line after a final newline", () => {
    const doc = "a\nb\na\n";
    expect(apply(doc, EditorSelection.single(0, doc.length), uniqueLinesSpec)).toBe("a\nb\n");
  });

  it("handles several selections independently", () => {
    const doc = "a\na\n--\na\na";
    const sel = EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(7, 10)]);
    expect(apply(doc, sel, uniqueLinesSpec)).toBe("a\n--\na");
  });

  it("keeps the caret on its line when that line stays", () => {
    const state = EditorState.create({ doc: "a\nb\na\nc", selection: EditorSelection.cursor(6) }); // before "c"
    const next = state.update(uniqueLinesSpec(state)!).state;
    expect(next.doc.toString()).toBe("a\nb\nc");
    expect(next.selection.main.head).toBe(4);
  });

  it("moves a caret on a deleted line to the end of the line before it", () => {
    const state = EditorState.create({ doc: "a\nb\na\nc", selection: EditorSelection.cursor(5) }); // in the second "a"
    expect(state.update(uniqueLinesSpec(state)!).state.selection.main.head).toBe(3);
  });

  it("is its own undo step, not merged into a deletion typed just before", () => {
    let state = EditorState.create({ doc: "a\nbx\na", extensions: [history()] });
    state = state.update({ changes: { from: 3, to: 4 }, userEvent: "delete.backward" }).state; // "a\nb\na"
    state = state.update(uniqueLinesSpec(state)!).state;
    expect(state.doc.toString()).toBe("a\nb");
    const view = { state, dispatch: (tr: Transaction) => void (view.state = tr.state) };
    undo(view);
    expect(view.state.doc.toString()).toBe("a\nb\na");
  });

  it("does nothing for a single line or lines without repeats", () => {
    expect(apply("only", undefined, uniqueLinesSpec)).toBeNull();
    expect(apply("a\nb\n", undefined, uniqueLinesSpec)).toBeNull();
    expect(apply("a\nb\na", EditorSelection.single(0, 1), uniqueLinesSpec)).toBeNull();
  });

  it("does not edit a read-only editor", () => {
    let dispatched = 0;
    const state = EditorState.create({ doc: "a\na", extensions: [EditorState.readOnly.of(true)] });
    expect(uniqueLines({ state, dispatch: () => dispatched++ })).toBe(false);
    expect(dispatched).toBe(0);
  });
});

describe("Convert Indents", () => {
  const toSpaces = convertIndentsToSpacesSpec;
  const toTabs = convertIndentsToTabsSpec;

  it("converts the indentation of the whole file without a selection", () => {
    expect(apply("\tif (a) {\n\t\tb();\n\t}\n", undefined, toSpaces)).toBe("    if (a) {\n        b();\n    }\n");
    expect(apply("    if (a) {\n        b();\n    }\n", undefined, toTabs)).toBe("\tif (a) {\n\t\tb();\n\t}\n");
  });

  it("measures tabs to the next tab stop with the editor's tab size", () => {
    expect(apply("  \tx", undefined, toSpaces)).toBe("    x");
    expect(apply("\t  \tx", undefined, toSpaces, 2)).toBe("      x");
    expect(apply("\tx", undefined, toSpaces, 8)).toBe("        x");
    expect(apply("        x", undefined, toTabs, 8)).toBe("\tx");
  });

  it("measures with the Code Style tab size when a detected indent narrowed the editor's (#5702)", () => {
    const state = EditorState.create({
      doc: "  a\n    b\n\tc",
      extensions: [EditorState.tabSize.of(2), formatIndentFacet.of({ tabSize: 4, insertSpaces: true })],
    });
    expect(state.update(toTabs(state)!).state.doc.toString()).toBe("  a\n\tb\n\tc");
    expect(state.update(toSpaces(state)!).state.doc.toString()).toBe("  a\n    b\n    c");
  });

  it("keeps the columns past the last tab stop as spaces when converting to tabs", () => {
    expect(apply("      x", undefined, toTabs)).toBe("\t  x");
    expect(apply("   x\n", undefined, toTabs)).toBeNull();
    expect(apply(" \t x", undefined, toTabs)).toBe("\t x");
  });

  it("leaves whitespace after the first non-blank character alone and converts blank lines whole", () => {
    expect(apply("\ta\tb  c", undefined, toSpaces)).toBe("    a\tb  c");
    expect(apply("a\n\t\nb", undefined, toSpaces)).toBe("a\n    \nb");
    expect(apply("a\n    \nb", undefined, toTabs)).toBe("a\n\t\nb");
  });

  it("converts only the lines the selections touch (a selection ending at a line start excludes that line)", () => {
    const doc = "\ta\n\tb\n\tc\n\td";
    expect(apply(doc, EditorSelection.single(4, 6), toSpaces)).toBe("\ta\n    b\n\tc\n\td");
    expect(apply(doc, EditorSelection.single(3, 9), toSpaces)).toBe("\ta\n    b\n    c\n\td");
    const two = EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(10, 11)]);
    expect(apply(doc, two, toSpaces)).toBe("    a\n\tb\n\tc\n    d");
    const sameLine = EditorSelection.create([EditorSelection.range(3, 4), EditorSelection.range(5, 6)]);
    expect(apply(doc, sameLine, toSpaces)).toBe("\ta\n    b\n\tc\n\td");
  });

  it("keeps a selection over the converted lines", () => {
    const state = EditorState.create({ doc: "\ta\n\tb\nc", selection: EditorSelection.single(0, 5) });
    const next = state.update(toSpaces(state)!).state;
    expect(next.doc.toString()).toBe("    a\n    b\nc");
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe("    a\n    b");
  });

  it("does nothing when the indentation is already converted", () => {
    expect(apply("    a\nb\n", undefined, toSpaces)).toBeNull();
    expect(apply("\ta\n\t  b", undefined, toTabs)).toBeNull();
    expect(apply("", undefined, toTabs)).toBeNull();
  });

  it("does nothing in a read-only editor", () => {
    let dispatched = false;
    const state = EditorState.create({ doc: "\ta", extensions: EditorState.readOnly.of(true) });
    expect(convertIndentsToSpaces({ state, dispatch: () => (dispatched = true) })).toBe(false);
    expect(convertIndentsToTabs({ state, dispatch: () => (dispatched = true) })).toBe(false);
    expect(dispatched).toBe(false);
  });
});
