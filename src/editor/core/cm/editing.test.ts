import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { indentService, indentUnit, ensureSyntaxTree } from "@codemirror/language";
import {
  addCaretsToLineEnds,
  commentLine,
  completeStatement,
  joinLines,
  startNewLine,
  startNewLineBefore,
  toggleCase,
  unselectOccurrence,
} from "./editing";
import { batchLanguage, commentTokens, findLanguageDescription } from "./languages";
import { toggleCaret } from "./multiCaret";
import { enterInLineComment, lineCommentStyle } from "./comments";
import { languages } from "@codemirror/language-data";

/** Brace languages in miniature: one unit deeper after a line ending in `{`. */
const javascript = () =>
  indentService.of((cx, pos) => {
    const line = cx.lineAt(pos, -1);
    const base = /^ */.exec(line.text)![0].length;
    const before = line.text.slice(0, pos - line.from).trimEnd();
    return before.endsWith("{") ? base + 2 : base;
  });

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extensions: Extension = []) {
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = [];
  let doc = "";
  let anchor = -1;
  for (const ch of text) {
    if (ch === "|") ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === "[") anchor = doc.length;
    else if (ch === "]") ranges.push(EditorSelection.range(anchor, doc.length));
    else doc += ch;
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
      extensions: [EditorState.allowMultipleSelections.of(true), extensions, indentUnit.of("  ")],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const { doc, selection } = view.state;
  let out = doc.toString();
  for (const r of [...selection.ranges].sort((a, b) => b.from - a.from))
    out = r.empty
      ? out.slice(0, r.head) + "|" + out.slice(r.head)
      : out.slice(0, r.from) + "[" + out.slice(r.from, r.to) + "]" + out.slice(r.to);
  return out;
}

describe("start new line", () => {
  it("opens an indented line below, wherever the caret is", () => {
    const v = make("function f() {\n  let a| = 1;\n}", javascript());
    startNewLine(v);
    expect(show(v)).toBe("function f() {\n  let a = 1;\n  |\n}");
  });

  it("indents after a block opener", () => {
    const v = make("if (x) {|", javascript());
    startNewLine(v);
    expect(show(v)).toBe("if (x) {\n  |");
  });

  it("opens a line above, keeping the indent", () => {
    const v = make("a\n  b|c\n");
    startNewLineBefore(v);
    expect(show(v)).toBe("a\n  |\n  bc\n");
  });

  it("opens a line above the first line", () => {
    const v = make("  x|y");
    startNewLineBefore(v);
    expect(show(v)).toBe("  |\n  xy");
  });
});

describe("join lines", () => {
  it("joins the next line with one space, dropping its indent", () => {
    const v = make("let a =| \n    1;\n");
    joinLines(v);
    expect(show(v)).toBe("let a =| 1;\n");
  });

  it("joins every selected line", () => {
    const v = make("[a\n  b\n  c]\nd");
    joinLines(v);
    expect(v.state.doc.toString()).toBe("a b c\nd");
  });

  it("merges consecutive line comments and keeps brackets tight", () => {
    expect(
      (() => {
        const v = make("// one|\n// two");
        joinLines(v);
        return v.state.doc.toString();
      })(),
    ).toBe("// one two");
    expect(
      (() => {
        const v = make("f(|\n  x\n)");
        joinLines(v);
        joinLines(v);
        return v.state.doc.toString();
      })(),
    ).toBe("f(x)");
  });

  it("does nothing on the last line", () => {
    const v = make("a|");
    joinLines(v);
    expect(show(v)).toBe("a|");
  });
});

describe("toggle case", () => {
  it("lower-cases text with any upper-case letter, upper-cases the rest", () => {
    const v = make("[fooBar]");
    toggleCase(v);
    expect(v.state.doc.toString()).toBe("foobar");
    toggleCase(v);
    expect(v.state.doc.toString()).toBe("FOOBAR");
  });

  it("selects the word at the caret without a selection", () => {
    const v = make("one tw|o three");
    toggleCase(v);
    expect(show(v)).toBe("one [TWO] three");
  });

  it("decides once for all carets", () => {
    const v = make("[abc] [Def]");
    toggleCase(v);
    expect(v.state.doc.toString()).toBe("abc def");
  });
});

describe("multiple carets", () => {
  it("adds carets at the ends of the selected lines", () => {
    const v = make("[ab\ncd\nef]\ngh");
    addCaretsToLineEnds(v);
    expect(show(v)).toBe("ab|\ncd|\nef|\ngh");
  });

  it("ignores the line the selection ends at column 0 of", () => {
    const v = make("[ab\ncd\n]ef");
    addCaretsToLineEnds(v);
    expect(show(v)).toBe("ab|\ncd|\nef");
  });

  it("unselects the most recent occurrence", () => {
    const v = make("[a] [a] [a]");
    v.dispatch({ selection: EditorSelection.create(v.state.selection.ranges, 2) });
    unselectOccurrence(v);
    expect(show(v)).toBe("[a] [a] a");
    expect(v.state.selection.mainIndex).toBe(1);
    unselectOccurrence(v);
    // A single selection collapses to its caret.
    expect(show(v)).toBe("[a] a a");
    expect(unselectOccurrence(v)).toBe(true);
    expect(show(v)).toBe("a| a a");
    expect(unselectOccurrence(v)).toBe(false);
  });

  it("⌥⇧click toggles a caret", () => {
    const start = EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]);
    expect(toggleCaret(start, 3, 3).ranges.map((r) => r.head)).toEqual([1, 3, 5]);
    expect(toggleCaret(start, 5, 5).ranges.map((r) => r.head)).toEqual([1]);
    expect(toggleCaret(EditorSelection.single(2), 2, 2).ranges.map((r) => r.head)).toEqual([2]);
    expect(toggleCaret(EditorSelection.single(0), 2, 4).ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 0],
      [2, 4],
    ]);
  });
});

describe("comment with line comment", () => {
  const comments = EditorState.languageData.of(() => [{ commentTokens: { line: "//" } }]);
  const indented = [comments, lineCommentStyle.of({ atFirstColumn: false, addSpace: true })];

  it("comments at the first column without a space and moves the caret down", () => {
    const v = make("  a|b\n  cd\n", comments);
    commentLine(v);
    expect(show(v)).toBe("//  ab\n  cd|\n");
  });

  it("moves every caret down", () => {
    const v = make("a|\nb\nc|\nd\n", comments);
    commentLine(v);
    expect(show(v)).toBe("//a\nb|\n//c\nd|\n");
  });

  it("moves the caret down to the same visible column past CJK text", () => {
    const v = make("张三|x\nabcdefgh\n", comments);
    commentLine(v);
    // "//张三" is six columns wide.
    expect(show(v)).toBe("//张三x\nabcdef|gh\n");
  });

  it("keeps the caret after the prefix on an empty line", () => {
    const v = make("f {\n  |\n  b", indented);
    commentLine(v);
    expect(show(v)).toBe("f {\n  // |\n  b");
    const w = make("a\n|\nb", comments);
    commentLine(w);
    expect(show(w)).toBe("a\n//|\nb");
  });

  it("uncomments with or without the space", () => {
    const v = make("[//a\n  // b\n]c", comments);
    commentLine(v);
    expect(v.state.doc.toString()).toBe("a\n   b\nc");
    const w = make("[//a\n  // b\n]c", indented);
    commentLine(w);
    expect(w.state.doc.toString()).toBe("a\n  b\nc");
  });

  it("comments at the smallest indent of the lines when not at the first column", () => {
    const v = make("[  a\n    b\n\n  c]", indented);
    commentLine(v);
    expect(v.state.doc.toString()).toBe("  // a\n  //   b\n  //\n  // c");
  });

  it("restores a whole-line selection from its first line's start", () => {
    const v = make("x\n[ab\ncd\n]", comments);
    commentLine(v);
    expect(show(v)).toBe("x\n[//ab\n//cd\n]");
  });
});

describe("enter in a line comment", async () => {
  const ext = await languages.find((l) => l.name === "JavaScript")!.load();

  it("continues the comment with its own spacing", () => {
    const v = make("  //  one |two", ext);
    expect(enterInLineComment(v)).toBe(true);
    expect(show(v)).toBe("  //  one \n  //  |two");
  });

  it("splits a trailing comment onto a commented line", () => {
    const v = make("f(); // one |two", ext);
    enterInLineComment(v);
    expect(show(v)).toBe("f(); // one \n|// two");
  });

  it("does nothing at the end of the comment or outside one", () => {
    expect(enterInLineComment(make("// one|", ext))).toBe(false);
    expect(enterInLineComment(make("f(|x)", ext))).toBe(false);
  });
});

describe("fallback indentation for GDScript", () => {
  const gd = [
    EditorState.tabSize.of(4),
    indentUnit.of("\t"),
    commentTokens({
      id: "gdscript",
      name: "GDScript",
      extensions: ["gd"],
      uiMode: null,
      lineComment: "#",
      blockComment: null,
      indent: { tabSize: 4, insertSpaces: false },
    }),
  ];

  it("indents with a tab after a function header ending in a colon", () => {
    const v = make("func test() -> void:|", gd);
    insertNewlineAndIndent(v);
    expect(show(v)).toBe("func test() -> void:\n\t|");
  });

  it("indents nested blocks and ignores trailing comments", () => {
    const v = make("func test() -> void:\n\tif x > 0: # check|", gd);
    insertNewlineAndIndent(v);
    expect(show(v)).toBe("func test() -> void:\n\tif x > 0: # check\n\t\t|");
  });

  it("does not indent after a comment ending in a colon", () => {
    const v = make("\t# note:|", gd);
    insertNewlineAndIndent(v);
    expect(show(v)).toBe("\t# note:\n\t|");
  });

  it("dedents after pass, return, break, and continue", () => {
    const v = make("func test() -> void:\n\tpass|", gd);
    insertNewlineAndIndent(v);
    expect(show(v)).toBe("func test() -> void:\n\tpass\n|");

    const w = make("func test() -> int:\n\tif ready:\n\t\treturn 1|", gd);
    insertNewlineAndIndent(w);
    expect(show(w)).toBe("func test() -> int:\n\tif ready:\n\t\treturn 1\n\t|");
  });

  it("completes a GDScript function header with a colon and indents the next line", () => {
    const v = make("func test() -> void|", gd);
    completeStatement("gdscript")(v);
    expect(show(v)).toBe("func test() -> void:\n\t|");
  });
});

describe("fallback indentation boundaries", () => {
  const fallback = (id: string, lineComment = "#") =>
    commentTokens({
      id,
      name: id,
      extensions: [],
      uiMode: null,
      lineComment,
      blockComment: null,
      indent: null,
    });
  it.each([
    ["gdscript", "var items = {|}", "var items = {\n  |\n}"],
    ["gdscript", 'var text = "unfinished:|', 'var text = "unfinished:\n|'],
    ["gdscript", 'var text = "unfinished {|', 'var text = "unfinished {\n|'],
    ["gdscript", 'var text = "#" # comment:|', 'var text = "#" # comment:\n|'],
    ["gdscript", "if ready: # note|", "if ready: # note\n  |"],
    ["elixir", "if ready, do: value|", "if ready, do: value\n|"],
    ["lua", "if ready then work() end|", "if ready then work() end\n|"],
  ])("handles %s: %s", (id, input, expected) => {
    const v = make(input, fallback(id));
    insertNewlineAndIndent(v);
    expect(show(v)).toBe(expected);
  });
});

describe("Batch language mode and @REM comment toggle", () => {
  it("resolves Batch by uiMode and .bat / .cmd extensions and toggles @REM comments", () => {
    expect(findLanguageDescription("Batch", "build.bat")?.name).toBe("Batch");
    expect(findLanguageDescription(null, "deploy.cmd")?.name).toBe("Batch");
    const v = make("echo| hello\n", batchLanguage);
    commentLine(v);
    expect(v.state.doc.toString()).toBe("@REM echo hello\n");
    v.dispatch({ selection: EditorSelection.cursor(0) });
    commentLine(v);
    expect(v.state.doc.toString()).toBe("echo hello\n");
  });

  it("highlights keywords, labels, variables, strings and :: / REM comments", () => {
    const src = [
      ":: header comment",
      "@REM line comment",
      "@echo off",
      "setlocal",
      'set "APP=demo"',
      "for %%i in (a b) do if exist %APP% call :sub !COUNT!",
      ":sub",
      "rem note",
      "exit /b 0",
      "endlocal",
    ].join("\n");
    const state = EditorState.create({ doc: src, extensions: batchLanguage });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const tokens: Array<[string, string]> = [];
    tree.iterate({
      enter: (n) => {
        if (n.name !== "Document" && n.from < n.to) tokens.push([n.name, state.sliceDoc(n.from, n.to)]);
      },
    });
    const has = (tag: string, text: string) => tokens.some(([n, s]) => n.includes(tag) && s === text);
    expect(has("comment", ":: header comment")).toBe(true);
    expect(has("comment", "@REM line comment")).toBe(true);
    expect(has("comment", "rem note")).toBe(true);
    for (const kw of ["echo", "setlocal", "set", "for", "in", "do", "if", "exist", "call", "exit", "endlocal"]) {
      expect(has("keyword", kw)).toBe(true);
    }
    expect(has("string", '"APP=demo"')).toBe(true);
    expect(has("variableName", "%%i")).toBe(true);
    expect(has("variableName", "%APP%")).toBe(true);
    expect(has("variableName", "!COUNT!")).toBe(true);
    expect(has("labelName", ":sub")).toBe(true);
  });
});
