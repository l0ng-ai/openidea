import { describe, expect, it } from "vitest";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";
import { findLanguageDescription, loadSupport } from "./languages";
import {
  commentAt,
  docComments,
  renderCacheSize,
  renderDocComments,
  renderedDocsExtension,
  renderedRanges,
  toggleRenderedView,
} from "./renderedDocs";

const defaultMode = new Compartment();

function state(doc: string, { reader = true, language = java(), at = 0 } = {}) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(at),
    extensions: [language, renderedDocsExtension, defaultMode.of(renderDocComments.of(reader))],
  });
}

/** The replaced ranges as 1-based `[firstLine, lastLine]` pairs. */
function replaced(s: EditorState): Array<[number, number]> {
  return renderedRanges(s).map(([from, to]) => [s.doc.lineAt(from).number, s.doc.lineAt(to).number]);
}

const JAVA = [
  "package p;", // 1
  "", // 2
  "/**", // 3
  " * Books a room.", // 4
  " *", // 5
  " * @param id the room", // 6
  " */", // 7
  "public class Rooms {", // 8
  "  /** Frees a room. */", // 9
  "  public void free() {}", // 10
  "}", // 11
].join("\n");

const BOOK = JAVA.indexOf("/**");
const FREE = JAVA.indexOf("/** Frees");

describe("docComments", () => {
  it("finds each Javadoc block and its exact range", () => {
    const s = state(JAVA);
    const found = docComments(s);
    expect(found.map((c) => [s.doc.lineAt(c.from).number, s.doc.lineAt(c.to).number])).toEqual([
      [3, 7],
      [9, 9],
    ]);
    expect(found[0]!.style).toBe("block");
  });

  it("ignores an ordinary block comment", () => {
    expect(docComments(state("/* not docs */\nclass A {}"))).toHaveLength(0);
  });

  it("ignores an empty block comment that only looks like one", () => {
    expect(docComments(state("/**/\nclass A {}"))).toHaveLength(0);
  });

  it("ignores a doc comment sharing its line with code", () => {
    expect(docComments(state("int a; /** docs */\n"))).toHaveLength(0);
  });

  it("joins a run of /// lines into one comment", () => {
    const found = docComments(state("/// One.\n/// Two.\nfunction f() {}", { language: javascript() }));
    expect(found).toHaveLength(1);
    expect(found[0]!.style).toBe("line");
    expect(found[0]!.text).toBe("/// One.\n/// Two.");
  });

  it("keeps two /// runs apart when a blank line separates them", () => {
    expect(docComments(state("/// One.\n\n/// Two.\nfunction f() {}", { language: javascript() }))).toHaveLength(2);
  });

  it("ignores a plain // comment", () => {
    expect(docComments(state("// just a note\nfunction f() {}", { language: javascript() }))).toHaveLength(0);
  });
});

describe("the file's default", () => {
  it("renders every doc comment when on", () => {
    expect(replaced(state(JAVA))).toEqual([
      [3, 7],
      [9, 9],
    ]);
  });

  it("renders none when off", () => {
    expect(replaced(state(JAVA, { reader: false }))).toEqual([]);
  });

  it("does not depend on the caret: one inside a comment leaves it rendered", () => {
    expect(replaced(state(JAVA, { at: JAVA.indexOf("Books") }))).toEqual([
      [3, 7],
      [9, 9],
    ]);
  });

  it("does not change as the caret moves, so nothing flickers", () => {
    const s = state(JAVA);
    const moved = s.update({ selection: EditorSelection.cursor(JAVA.indexOf("public class")) }).state;
    expect(replaced(moved)).toEqual(replaced(s));
  });

  it("leaves an empty doc comment as source, having nothing to show", () => {
    expect(replaced(state("/**\n *\n */\nclass A {}"))).toEqual([]);
  });

  it("renders no comment until the editor draws it, so opening a large file stays cheap", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `/** Lazy comment ${i} of a large file. */\nclass L${i} {}`).join(
      "\n",
    );
    const before = renderCacheSize();
    const s = state(doc);
    // Every comment is decided rendered: its source is replaced ...
    expect(replaced(s)).toHaveLength(40);
    // ... but none was rendered yet: no editor has drawn them.
    expect(renderCacheSize()).toBe(before);
  });
});

describe("per-comment toggle", () => {
  it("switches one comment to source and leaves the others rendered", () => {
    const s = state(JAVA).update({ effects: toggleRenderedView.of(BOOK) }).state;
    expect(replaced(s)).toEqual([[9, 9]]);
  });

  it("renders one comment while the file's default is source", () => {
    const s = state(JAVA, { reader: false }).update({ effects: toggleRenderedView.of(FREE) }).state;
    expect(replaced(s)).toEqual([[9, 9]]);
  });

  it("toggling twice restores the default", () => {
    const s = state(JAVA)
      .update({ effects: toggleRenderedView.of(BOOK) })
      .state.update({ effects: toggleRenderedView.of(BOOK) }).state;
    expect(replaced(s)).toEqual([
      [3, 7],
      [9, 9],
    ]);
  });

  it("follows its comment through an edit above it", () => {
    const s = state(JAVA)
      .update({ effects: toggleRenderedView.of(BOOK) })
      .state.update({ changes: { from: 0, insert: "// header\n" } }).state;
    expect(replaced(s)).toEqual([[10, 10]]);
  });

  it("is cleared when the whole file switches, so every comment ends up the same", () => {
    const flipped = state(JAVA).update({ effects: toggleRenderedView.of(BOOK) }).state;
    const off = flipped.update({ effects: defaultMode.reconfigure(renderDocComments.of(false)) }).state;
    expect(replaced(off)).toEqual([]);
    const on = off.update({ effects: defaultMode.reconfigure(renderDocComments.of(true)) }).state;
    expect(replaced(on)).toEqual([
      [3, 7],
      [9, 9],
    ]);
  });
});

describe("commentAt", () => {
  it("finds the comment around the caret", () => {
    const s = state(JAVA);
    expect(commentAt(s, JAVA.indexOf("Books"))?.from).toBe(BOOK);
  });

  it("finds the comment right above the caret's line", () => {
    const s = state(JAVA);
    expect(commentAt(s, JAVA.indexOf("public class"))?.from).toBe(BOOK);
    expect(commentAt(s, JAVA.indexOf("public void"))?.from).toBe(FREE);
  });

  it("finds nothing on a line no comment documents", () => {
    expect(commentAt(state(JAVA), 0)).toBeNull();
  });
});

describe("languages", () => {
  const BLOCK = "/**\n * Hello.\n * @param a the a\n */\n";
  const LINES = "/// Hello.\n/// World.\n";

  // Lezer grammars give a comment one node; the line-based modes (Kotlin, Scala, Groovy,
  // Dart, C#, Swift) give each of its lines one. Both must come out as one comment.
  it.each([
    ["Java", "A.java", BLOCK + "class A {}\n", [1, 4]],
    ["Kotlin", "A.kt", BLOCK + "class A\n", [1, 4]],
    ["Scala", "A.scala", BLOCK + "class A\n", [1, 4]],
    ["Groovy", "A.groovy", BLOCK + "class A {}\n", [1, 4]],
    ["Dart", "a.dart", BLOCK + "class A {}\n", [1, 4]],
    ["C#", "A.cs", LINES + "class A {}\n", [1, 2]],
    ["JavaScript", "a.js", BLOCK + "function a() {}\n", [1, 4]],
    ["TypeScript", "a.ts", BLOCK + "function a() {}\n", [1, 4]],
    ["PHP", "a.php", "<?php\n" + BLOCK + "function a() {}\n", [2, 5]],
    ["Rust", "a.rs", LINES + "fn a() {}\n", [1, 2]],
    ["C++", "a.cpp", BLOCK + "void a();\n", [1, 4]],
    ["Swift", "a.swift", LINES + "func a() {}\n", [1, 2]],
  ] as const)("finds a whole doc comment in %s", async (name, path, doc, [first, last]) => {
    const support = await loadSupport(findLanguageDescription(name, `/p/${path}`)!);
    const s = EditorState.create({ doc, extensions: support! });
    ensureSyntaxTree(s, s.doc.length, 5000);
    expect(docComments(s).map((c) => [s.doc.lineAt(c.from).number, s.doc.lineAt(c.to).number])).toEqual([
      [first, last],
    ]);
  });

  it("drops a line-based comment that is never closed", async () => {
    const support = await loadSupport(findLanguageDescription("Kotlin", "/p/A.kt")!);
    const s = EditorState.create({ doc: "/**\n * Hello.\nclass A\n", extensions: support! });
    ensureSyntaxTree(s, s.doc.length, 5000);
    expect(docComments(s)).toEqual([]);
  });
});
