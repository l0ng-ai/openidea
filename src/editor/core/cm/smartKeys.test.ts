import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentService, indentUnit, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { closeBrackets, insertBracket } from "@codemirror/autocomplete";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { languages as cmLanguages } from "@codemirror/language-data";
import { kotlin, csharp } from "@codemirror/legacy-modes/mode/clike";
import { validateEditorExtras } from "@/platform/editorSettings";
import {
  autoIndentBackspace,
  insertTab,
  smartBackspace,
  smartBackspaceApplies,
  tabOut,
  tabOutOfScope,
} from "./smartKeys";
import { prefsExtension } from "./prefs";
import { interpolationParser } from "./interpolation";

/** One unit (2) deeper after a (non-blank) line ending in `{`, one less on a line starting with `}`. */
const braces = indentService.of((cx, pos) => {
  let prev = cx.lineAt(pos, -1);
  do {
    if (prev.from === 0) return 0;
    prev = cx.lineAt(prev.from - 1, -1);
  } while (!prev.text.trim());
  const base = /^ */.exec(prev.text)![0].length;
  const own = cx.state.doc.lineAt(pos).text;
  return Math.max(0, base + (prev.text.trimEnd().endsWith("{") ? 2 : 0) - (/^\s*}/.test(own) ? 2 : 0));
});

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extensions: Extension = [], unit = "  ") {
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
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(4),
        indentUnit.of(unit),
        extensions,
      ],
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

describe("tab", () => {
  it("inserts whitespace up to the next indent stop at each caret", () => {
    const v = make("ab|c\n|x");
    insertTab(v);
    expect(show(v)).toBe("ab  |c\n  |x");
  });

  it("counts wide characters as two columns towards the indent stop", () => {
    const v = make("a张|x\n张|y");
    insertTab(v);
    expect(show(v)).toBe("a张 |x\n张  |y");
  });

  it("inserts a tab character when the code style uses tabs", () => {
    const v = make("a|b", [], "\t");
    insertTab(v);
    expect(show(v)).toBe("a\t|b");
  });

  it("indents the lines of a selection", () => {
    const v = make("[a\nb]");
    insertTab(v);
    expect(v.state.doc.toString()).toBe("  a\n  b");
  });

  it("replaces a whitespace-only selection like a caret", () => {
    const v = make("a[  ]b");
    insertTab(v);
    expect(show(v)).toBe("a |b");
  });
});

describe("smart backspace", () => {
  it("applies in 'proper indent' mode except in indentation-based languages", () => {
    expect(smartBackspaceApplies("autoindent", "java")).toBe(true);
    expect(smartBackspaceApplies("autoindent", "python")).toBe(false);
    expect(smartBackspaceApplies("autoindent", "gdscript")).toBe(false);
    expect(smartBackspaceApplies("nearest", "java")).toBe(false);
  });

  it("goes back to the proper indent from deeper whitespace", () => {
    const v = make("f {\n        |x\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  |x\n}");
  });

  it("joins with the line above at the proper indent", () => {
    const v = make("f {\n  a\n  |b\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  a |b\n}");
  });

  it("moves text up over a blank line at its proper indent", () => {
    const v = make("f {\n  a\n\n  |b\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  a\n  |b\n}");
  });

  it("joins an empty line without leaving a space", () => {
    const v = make("f {\n  a\n  |\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  a|\n}");
  });

  it("leaves Backspace after text to the default", () => {
    const v = make("f {\n  a|b\n}", braces);
    expect(autoIndentBackspace(v.state, v.state.selection.main.head)).toBeNull();
    expect(smartBackspace(v)).toBe(false);
  });
});

describe("tab out of pairs", () => {
  const ext = [closeBrackets(), tabOut];
  const type = (v: EditorView, ch: string) => {
    const tr = insertBracket(v.state, ch);
    if (tr) v.dispatch(tr);
    else v.dispatch(v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" }));
  };

  it("steps over a closing bracket the editor inserted", () => {
    const v = make("f|", ext);
    type(v, "(");
    type(v, "x");
    expect(show(v)).toBe("f(x|)");
    expect(insertTab(v)).toBe(true);
    expect(show(v)).toBe("f(x)|");
    // Once out, Tab inserts whitespace again.
    insertTab(v);
    expect(show(v)).toBe("f(x)  |");
  });

  it("ignores closers the user typed", () => {
    const v = make("f(x|)", ext);
    expect(tabOutOfScope(v)).toBe(false);
  });

  it("keeps the pair through edits elsewhere while the caret is inside, else forgets it", () => {
    const v = make("a f|", ext);
    type(v, "(");
    v.dispatch({ changes: { from: 0, to: 1, insert: "bb" } });
    expect(show(v)).toBe("bb f(|)");
    v.dispatch({ selection: { anchor: 0 } });
    v.dispatch({ changes: { from: 0, insert: "c" }, selection: { anchor: 6 } });
    expect(tabOutOfScope(v)).toBe(false);
  });
});

describe("smart angle brackets", () => {
  /** The real wiring: prefsExtension attaches the `<` handler for the document's language. */
  const prefs = (language: string | undefined, smartKeys: Record<string, unknown> = {}) =>
    [
      closeBrackets(),
      prefsExtension({
        prefs: validateEditorExtras({ smartKeys }),
        path: "",
        softWrap: false,
        showWhitespace: false,
        hardWrapAt: 120,
        readOnly: false,
        language,
      }),
    ] satisfies Extension[];

  /** Type through the real input handlers, falling back to a plain insert. */
  const type = (v: EditorView, ch: string) => {
    const r = v.state.selection.main;
    const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
    if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, r.from, r.to, ch, insert)))
      v.dispatch(v.state.replaceSelection(ch), { userEvent: "input.type" });
  };

  /** Types `<` at the caret (marked `|`) in `language` (whose parser is attached) and checks the doc. */
  const pair = (language: string | undefined, support: Extension, text: string, expected: string) => {
    const v = make(text, [support, prefs(language, {})]);
    type(v, "<");
    expect(show(v)).toBe(expected);
  };

  const JAVA = java();
  const TS = javascript({ typescript: true });
  const TSX = javascript({ jsx: true, typescript: true });
  const JS = javascript();
  const KOTLIN = StreamLanguage.define(interpolationParser(kotlin, "Kotlin"));
  const CSHARP = StreamLanguage.define(interpolationParser(csharp, "C#"));
  let RUST: LanguageSupport;
  beforeAll(async () => {
    RUST = (await cmLanguages.find((l) => l.name === "Rust")!.load()) as LanguageSupport;
  });

  it("pairs after a type name in Java: fields, type arguments and class declarations", () => {
    pair("java", JAVA, "class Box|", "class Box<|>");
    pair("java", JAVA, "class A {\n  java.util.List|\n}", "class A {\n  java.util.List<|>\n}");
    pair("java", JAVA, "class A {\n  java.util.Map<String, |\n}", "class A {\n  java.util.Map<String, <|>\n}");
    pair("java", JAVA, "class A extends Comparable|", "class A extends Comparable<|>");
  });

  it("does not pair comparisons or shifts in Java", () => {
    pair("java", JAVA, "class A {\n  void f() {\n    a |\n  }\n}", "class A {\n  void f() {\n    a <|\n  }\n}");
    pair("java", JAVA, "class A {\n  void f() {\n    i |\n  }\n}", "class A {\n  void f() {\n    i <|\n  }\n}");
    pair("java", JAVA, "class A {\n  void f() {\n    x |\n  }\n}", "class A {\n  void f() {\n    x <|\n  }\n}");
  });

  it("does not pair inside Java strings or comments", () => {
    pair("java", JAVA, 'class A {\n  String s = "abc|";\n}', 'class A {\n  String s = "abc<|";\n}');
    pair("java", JAVA, "class A {\n  void f() {\n    // abc|\n  }\n}", "class A {\n  void f() {\n    // abc<|\n  }\n}");
  });

  it("pairs type positions in TypeScript but not expressions", () => {
    pair("typescript", TS, "const a: Array|", "const a: Array<|>");
    pair("typescript", TS, "const a = new Array|", "const a = new Array<|>");
    pair("typescript", TS, "const a: Map<string, |", "const a: Map<string, <|>");
    pair("typescript", TS, "function f|", "function f<|>");
    pair("typescript", TS, "if (a |", "if (a <|");
    pair("typescript", TS, "const y = x |", "const y = x <|");
    pair("typescript", TS, 'const s = "abc|"', 'const s = "abc<|"');
  });

  it("never pairs JSX / HTML tags in TSX", () => {
    pair("typescriptreact", TSX, "const x = |", "const x = <|");
    pair("typescriptreact", TSX, "return |", "return <|");
    // Type syntax still pairs there.
    pair("typescriptreact", TSX, "const a: Array|", "const a: Array<|>");
  });

  it("pairs Rust type identifiers, fn names and turbofish", () => {
    pair("rust", RUST, "let v: Vec|", "let v: Vec<|>");
    pair("rust", RUST, "let v: Vec<Vec|", "let v: Vec<Vec<|>");
    pair("rust", RUST, "fn f|", "fn f<|>");
    pair("rust", RUST, "let v: Vec<_> = x.iter().collect::|", "let v: Vec<_> = x.iter().collect::<|>");
  });

  it("does not pair comparisons or shifts in Rust", () => {
    pair("rust", RUST, "fn f() {\n    let c = a |\n}", "fn f() {\n    let c = a <|\n}");
    pair("rust", RUST, "fn f() {\n    while i |\n}", "fn f() {\n    while i <|\n}");
    pair("rust", RUST, "fn f() {\n    let c = x |\n}", "fn f() {\n    let c = x <|\n}");
  });

  it("pairs capitalized type positions in Kotlin (stream parser)", () => {
    pair("kotlin", KOTLIN, "class A {\n  val x: List|\n}", "class A {\n  val x: List<|>\n}");
    pair("kotlin", KOTLIN, "class Box|", "class Box<|>");
    pair("kotlin", KOTLIN, "class Box  |", "class Box  <|>");
    pair("kotlin", KOTLIN, "val box = Bo|x", "val box = Bo<|x");
    // Kotlin puts a function's type parameters right after `fun`.
    pair("kotlin", KOTLIN, "fun |", "fun <|>");
    // Lowercase values are comparisons, not types.
    pair("kotlin", KOTLIN, "fun f() {\n  val c = a |\n}", "fun f() {\n  val c = a <|\n}");
  });

  it("pairs capitalized type positions in C# (stream parser)", () => {
    pair("csharp", CSHARP, "class A {\n  List|\n}", "class A {\n  List<|>\n}");
    pair("csharp", CSHARP, "class Box|", "class Box<|>");
    pair(
      "csharp",
      CSHARP,
      "class A {\n  void F() {\n    var c = a |\n  }\n}",
      "class A {\n  void F() {\n    var c = a <|\n  }\n}",
    );
  });

  it("languages without a rule never pair, even outside type syntax", () => {
    pair("javascript", JS, "let y = a|", "let y = a<|");
    pair(undefined, JS, "let y = List|", "let y = List<|");
  });

  it("needs the Insert pair bracket option on", () => {
    const v = make("class A {\n  java.util.List|\n}", [JAVA, prefs("java", { pairBrackets: false })]);
    type(v, "<");
    expect(show(v)).toBe("class A {\n  java.util.List<|\n}");
  });

  it("typing > steps over the inserted one, including out of nested pairs", () => {
    const v = make("class A {\n  java.util.Map|\n}", [JAVA, prefs("java", {})]);
    type(v, "<");
    expect(show(v)).toBe("class A {\n  java.util.Map<|>\n}");
    type(v, "String, java.util.List");
    expect(show(v)).toBe("class A {\n  java.util.Map<String, java.util.List|>\n}");
    type(v, "<");
    expect(show(v)).toBe("class A {\n  java.util.Map<String, java.util.List<|>>\n}");
    type(v, ">");
    expect(show(v)).toBe("class A {\n  java.util.Map<String, java.util.List<>|>\n}");
    type(v, ">");
    expect(show(v)).toBe("class A {\n  java.util.Map<String, java.util.List<>>|\n}");
    // A third > has no pair left to step over and inserts.
    type(v, ">");
    expect(show(v)).toBe("class A {\n  java.util.Map<String, java.util.List<>>>|\n}");
  });

  it("a > typed ahead of an existing, not-inserted > is kept as-is", () => {
    const v = make("class A {\n  java.util.List<String|>\n}", [JAVA, prefs("java", {})]);
    type(v, ">");
    expect(show(v)).toBe("class A {\n  java.util.List<String>|>\n}");
  });

  it("pairs step out with Tab via the PAIRS table", () => {
    const v = make("class A {\n  java.util.List|\n}", [JAVA, prefs("java", {})]);
    type(v, "<");
    expect(insertTab(v)).toBe(true);
    expect(show(v)).toBe("class A {\n  java.util.List<>|\n}");
    // Once out, Tab inserts whitespace again.
    insertTab(v);
    expect(show(v)).toBe("class A {\n  java.util.List<>  |\n}");
  });
});
