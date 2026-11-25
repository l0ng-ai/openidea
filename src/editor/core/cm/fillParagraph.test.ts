import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { java } from "@codemirror/lang-java";
import { languages } from "@codemirror/language-data";
import { fillParagraph } from "./fillParagraph";
import { loadSupport } from "./languages";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks the caret. */
function make(text: string, extensions: Extension = []) {
  const at = text.indexOf("|");
  const view = new EditorView({
    state: EditorState.create({
      doc: text.replace("|", ""),
      selection: EditorSelection.cursor(at),
      extensions,
    }),
    parent: document.body,
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  views.push(view);
  return view;
}

function show(v: EditorView) {
  const doc = v.state.doc.toString();
  const head = v.state.selection.main.head;
  return doc.slice(0, head) + "|" + doc.slice(head);
}

describe("fill paragraph", () => {
  it("re-wraps a run of line comments to the hard wrap column", () => {
    const text = "class A {\n  // one two three\n  // four| five six\n  // seven\n  int a;\n}";
    const v = make(text, java());
    expect(fillParagraph(v, 20)).toBe(true);
    expect(show(v)).toBe(text);
    expect(fillParagraph(v, 40)).toBe(true);
    expect(show(v)).toBe("class A {\n  // one two three four| five six seven\n  int a;\n}");
  });

  it("breaks before the word that would cross the column and keeps a long word on its own line", () => {
    const v = make("// aaa bbb ccc ddd| eee\n// supercalifragilistic x", java());
    fillParagraph(v, 10);
    expect(show(v)).toBe("// aaa bbb\n// ccc ddd|\n// eee\n// supercalifragilistic\n// x");
  });

  it("stops at a blank comment line and at code", () => {
    const v = make("int a; // trailing\n// a\n// b|\n//\n// c\nint b;", java());
    fillParagraph(v, 80);
    expect(show(v)).toBe("int a; // trailing\n// a b|\n//\n// c\nint b;");
  });

  it("re-wraps the ` * ` lines of a documentation comment, up to a tag", () => {
    const v = make("/**\n * Returns the\n * sum| of a\n * and b.\n *\n * @param a first\n */\nint f;", java());
    fillParagraph(v, 80);
    expect(show(v)).toBe("/**\n * Returns the sum| of a and b.\n *\n * @param a first\n */\nint f;");
  });

  it("keeps a tag's lines together and the next tag apart", () => {
    const v = make("/**\n * @param a the| first\n *   operand\n * @param b second\n */", java());
    fillParagraph(v, 80);
    expect(show(v)).toBe("/**\n * @param a the| first operand\n * @param b second\n */");
  });

  it("uses the language's line comment token", async () => {
    const python = (await loadSupport(languages.find((l) => l.name === "Python")!))!;
    const v = make("def f():\n    # one\n    # two|\n    return 1\n", python);
    fillParagraph(v, 80);
    expect(show(v)).toBe("def f():\n    # one two|\n    return 1\n");
  });

  it("does not mix comments with a different marker", () => {
    const v = make("/// doc a\n// b|\n// c", java());
    fillParagraph(v, 80);
    expect(show(v)).toBe("/// doc a\n// b| c");
  });

  it("keeps a marker with punctuation (`//!`) apart and the space after the marker as it is", async () => {
    const rust = (await loadSupport(languages.find((l) => l.name === "Rust")!))!;
    const v = make("//! crate\n//! doc|\n// plain\n//tight\n", rust);
    fillParagraph(v, 80);
    expect(show(v)).toBe("//! crate doc|\n// plain\n//tight\n");
    const tight = make("//a\n//b|", java());
    fillParagraph(tight, 80);
    expect(show(tight)).toBe("//a b|");
  });

  it("leaves a shebang alone", async () => {
    const python = (await loadSupport(languages.find((l) => l.name === "Python")!))!;
    const v = make("#!/usr/bin/env| python\n# hello\n", python);
    expect(fillParagraph(v, 10)).toBe(false);
    const next = make("#!/usr/bin/env python\n# a\n# b|\n", python);
    fillParagraph(next, 80);
    expect(show(next)).toBe("#!/usr/bin/env python\n# a b|\n");
  });

  it("starts a paragraph at <p> and keeps <pre> apart in a documentation comment", () => {
    const v = make("/**\n * one\n * two|\n * <p>three\n * <pre>\n *   x();\n * </pre>\n */", java());
    fillParagraph(v, 80);
    expect(show(v)).toBe("/**\n * one two|\n * <p>three\n * <pre>\n *   x();\n * </pre>\n */");
  });

  it("keeps the other carets", () => {
    const v = make("// a\n// b|\nint x;", [java(), EditorState.allowMultipleSelections.of(true)]);
    v.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(16), EditorSelection.cursor(9)], 1),
    });
    fillParagraph(v, 80);
    expect(v.state.doc.toString()).toBe("// a b\nint x;");
    expect(v.state.selection.ranges.map((r) => r.head)).toEqual([6, 13]);
    expect(v.state.selection.main.head).toBe(6);
  });

  it("treats `@` as text in a plain text file", () => {
    const v = make("hello\n@world|\nfoo");
    fillParagraph(v, 80);
    expect(show(v)).toBe("hello @world| foo");
  });

  it("re-wraps a plain text paragraph between blank lines", () => {
    const v = make("Title\n\nalpha beta\ngamma| delta\nepsilon\n\nnext");
    fillParagraph(v, 12);
    expect(show(v)).toBe("Title\n\nalpha beta\ngamma| delta\nepsilon\n\nnext");
    fillParagraph(v, 80);
    expect(show(v)).toBe("Title\n\nalpha beta gamma| delta epsilon\n\nnext");
  });

  it("does nothing in code, in a string or on a blank line", () => {
    for (const text of ["int| a = 1;\nint b = 2;", 'String s = "// not| a comment";\nint b;', "// a\n|\n// b"]) {
      const v = make(text, java());
      expect(fillParagraph(v, 80)).toBe(false);
      expect(show(v)).toBe(text);
    }
  });

  it("does nothing in a read-only editor", () => {
    const v = make("// a\n// b|", [java(), EditorState.readOnly.of(true)]);
    expect(fillParagraph(v, 80)).toBe(false);
    expect(show(v)).toBe("// a\n// b|");
  });
});
