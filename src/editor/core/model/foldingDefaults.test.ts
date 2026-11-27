import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect, foldedRanges } from "@codemirror/language";
import type { FoldRange } from "@/platform/ipc";
import type { LanguageInfo } from "../backend";
import { backendFolds, foldingExtension, foldRegions, setBackendFolds } from "../cm/folding";
import { docCommentFolds, isFileHeaderFold } from "./document";

describe("isFileHeaderFold", () => {
  it("treats a comment block at the top of the file as the header", () => {
    // First code line is 3; header comment folds start at lines 1-2.
    expect(isFileHeaderFold(1, 3, "#!/usr/bin/env python", "#", null)).toBe(true);
    expect(isFileHeaderFold(2, 3, "# Copyright 2026", "#", null)).toBe(true);
    expect(isFileHeaderFold(1, 3, "   # license", "#", null)).toBe(true);
    expect(isFileHeaderFold(1, 3, "// license", "//", ["/*", "*/"])).toBe(true);
    expect(isFileHeaderFold(1, 2, "/* license */", "//", ["/*", "*/"])).toBe(true);
  });

  it("keeps documentation comments further down under documentation comments", () => {
    // The reviewer's regression: a doc comment above a function far down the
    // file starts with the line comment token but is NOT the file header.
    expect(isFileHeaderFold(20, 1, "// Returns the room", "//", ["/*", "*/"])).toBe(false);
    expect(isFileHeaderFold(8, 1, "# docs for f", "#", null)).toBe(false);
    expect(isFileHeaderFold(5, 1, "/** Javadoc */", "//", ["/*", "*/"])).toBe(false);
  });

  it("treats a Python docstring at the top of the file as documentation, not a header", () => {
    // Python: lineComment '#', no block comment; a docstring opens with quotes,
    // so even though it is line 1 it must not be classified as a file header.
    expect(isFileHeaderFold(1, 1, '"""Module docstring.', "#", null)).toBe(false);
    expect(isFileHeaderFold(1, 1, "'''Module docstring.", "#", null)).toBe(false);
  });

  it("does not classify ordinary code or a code-less file as a header", () => {
    expect(isFileHeaderFold(1, 2, "import os", "#", null)).toBe(false);
    // firstCodeLine === 0 means no real code line (only blanks / shebang).
    expect(isFileHeaderFold(1, 0, "# just a comment", "#", null)).toBe(false);
  });
});

describe("Collapse / Expand Doc Comments", () => {
  const java = { lineComment: "//", blockComment: ["/*", "*/"] } as LanguageInfo;
  const doc = [
    "// Copyright 2026", // 1: file header
    "// Licensed under MIT",
    "package demo;",
    "/**", // 4: doc comment
    " * Adds a user.",
    " */",
    "class A {", // 7: code
    "  /**", // 8: doc comment
    "   * Runs.",
    "   */",
    "  void run() {",
    "    x();",
    "  }",
    "}",
  ].join("\n");
  const ranges: FoldRange[] = [
    { start_line: 0, end_line: 1, kind: "comment" },
    { start_line: 3, end_line: 5, kind: "comment" },
    { start_line: 6, end_line: 13, kind: "region" },
    { start_line: 7, end_line: 9, kind: "comment" },
  ];
  const make = (caretLine = 3) => {
    const state = EditorState.create({ doc, extensions: [foldingExtension(false)] });
    const view = new EditorView({ state, parent: document.createElement("div") });
    view.dispatch({ effects: setBackendFolds.of(ranges), selection: { anchor: view.state.doc.line(caretLine).from } });
    return view;
  };
  const folded = (view: EditorView) => {
    const out: number[] = [];
    foldedRanges(view.state).between(
      0,
      view.state.doc.length,
      (from) => void out.push(view.state.doc.lineAt(from).number),
    );
    return out;
  };
  const docFolds = (view: EditorView) => docCommentFolds(view.state, java);

  it("takes the comment folds but the file header", () => {
    const view = make();
    expect(docFolds(view).map((r) => view.state.doc.lineAt(r.from).number)).toEqual([4, 8]);
    view.destroy();
  });

  it("collapses every doc comment and leaves the header and code alone", () => {
    const view = make();
    expect(foldRegions(view, docFolds(view), true)).toBe(true);
    expect(folded(view)).toEqual([4, 8]);
    // Already collapsed: nothing to do.
    expect(foldRegions(view, docFolds(view), true)).toBe(false);
    view.destroy();
  });

  it("moves a caret inside a doc comment to the fold so it stays collapsed", () => {
    const view = make(5);
    const [first] = docFolds(view);
    foldRegions(view, docFolds(view), true);
    expect(view.state.selection.main.head).toBe(first!.from);
    view.dispatch({ selection: { anchor: first!.from } });
    expect(folded(view)).toEqual([4, 8]);
    view.destroy();
  });

  it("expands only the doc comments", () => {
    const view = make();
    const [header, , code] = view.state.field(backendFolds);
    view.dispatch({ effects: [foldEffect.of(header!), foldEffect.of(code!)] });
    foldRegions(view, docFolds(view), true);
    expect(foldRegions(view, docFolds(view), false)).toBe(true);
    expect(folded(view)).toEqual([1, 7]);
    expect(foldRegions(view, docFolds(view), false)).toBe(false);
    view.destroy();
  });

  it("treats a Python module docstring as documentation", () => {
    const python = { lineComment: "#", blockComment: null } as LanguageInfo;
    const state = EditorState.create({
      doc: '"""Module docs.\nMore."""\nimport os\n',
      extensions: [foldingExtension(false)],
    }).update({ effects: setBackendFolds.of([{ start_line: 0, end_line: 1, kind: "comment" }]) }).state;
    expect(docCommentFolds(state, python)).toHaveLength(1);
  });
});
