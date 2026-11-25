import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  convertIndentsToSpaces,
  convertIndentsToSpacesSpec,
  convertIndentsToTabs,
  convertIndentsToTabsSpec,
  reverseLinesSpec,
  sortLinesSpec,
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
