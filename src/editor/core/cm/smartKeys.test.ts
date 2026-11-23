import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentService, indentUnit, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { closeBrackets, insertBracket } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { languages as cmLanguages } from "@codemirror/language-data";
import { kotlin, csharp } from "@codemirror/legacy-modes/mode/clike";
import { python } from "@codemirror/legacy-modes/mode/python";
import { validateEditorExtras } from "@/platform/editorSettings";
import {
  autoIndentBackspace,
  skipClosingBracket,
  enterInStringLiteral,
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

describe("Enter in a string literal", () => {
  const enter = (text: string, language: string, ext: Extension) => {
    const v = make(text, ext, "    ");
    const handled = enterInStringLiteral(language)(v);
    return handled ? show(v) : null;
  };

  it("splits a Java string into two joined with +, keeping the value", () => {
    expect(enter('class A {\n    String t = "hello|world";\n}', "java", java())).toBe(
      'class A {\n    String t = "hello" +\n            "|world";\n}',
    );
  });

  it("uses the literal's own quote in JavaScript", () => {
    expect(enter("const t = 'ab|cd';", "javascript", javascript())).toBe("const t = 'ab' +\n    '|cd';");
  });

  it("leaves text blocks, escapes, other languages and positions outside the literal alone", () => {
    expect(enter('String t = """\n  a|b\n  """;', "java", java())).toBeNull();
    expect(enter('String t = "a\\|nb";', "java", java())).toBeNull();
    expect(enter('String t = |"ab";', "java", java())).toBeNull();
    expect(enter('t = "a|b"', "python", [])).toBeNull();
    expect(enter("char c = 'a|';", "java", java())).toBeNull();
  });

  it("splits a string of a language without a Lezer string node, and not a multi-line one", () => {
    const kt = StreamLanguage.define(interpolationParser(kotlin, "Kotlin"));
    expect(enter('fun f() {\n    val t = "hello|world"\n}', "kotlin", kt)).toBe(
      'fun f() {\n    val t = "hello" +\n            "|world"\n}',
    );
    expect(enter('val t = """\n  a|b\n  """', "kotlin", kt)).toBeNull();
  });

  it("splits after an escaped backslash", () => {
    expect(enter('String t = "a\\\\|b";', "java", java())).toBe('String t = "a\\\\" +\n        "|b";');
  });
});

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

describe("quote pairs per language", () => {
  const typed = (language: string, support: Extension, text: string, chars: string) => {
    const v = make(text, [
      support,
      closeBrackets(),
      prefsExtension({
        prefs: validateEditorExtras({}),
        path: "",
        softWrap: false,
        showWhitespace: false,
        hardWrapAt: 120,
        readOnly: false,
        language,
      }),
    ]);
    for (const ch of chars) {
      const tr = insertBracket(v.state, ch);
      if (tr) v.dispatch(tr);
      else v.dispatch(v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" }));
    }
    return show(v);
  };

  it("pairs template literal backticks in TypeScript", () => {
    expect(typed("typescript", javascript({ typescript: true }), "const g = |", "`")).toBe("const g = `|`");
  });

  it("pairs Python's prefixed and triple-quoted strings", () => {
    const py = StreamLanguage.define(python);
    expect(typed("python", py, "label = f|", '"')).toBe('label = f"|"');
    expect(typed("python", py, "p = rb|", "'")).toBe("p = rb'|'");
    expect(typed("python", py, "    |", '"""')).toBe('    """|"""');
  });

  it("keeps plain quotes for other languages and respects the options", () => {
    expect(typed("java", java(), "String s = |", '"')).toBe('String s = "|"');
    expect(typed("java", java(), "String s = |", "`")).toBe("String s = `|");
  });
});

describe("typing over a closing bracket", () => {
  const typed = (support: Extension, text: string, ch: string) => {
    const v = make(text, [support, skipClosingBracket]);
    const r = v.state.selection.main;
    const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
    if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, r.from, r.to, ch, insert))) v.dispatch(insert());
    return show(v);
  };
  const py = StreamLanguage.define(python);

  it("steps over a bracket that already closes a pair, typed or not", () => {
    expect(typed(java(), "int v = (1 + 2|);", ")")).toBe("int v = (1 + 2)|;");
    expect(typed(java(), "var a = new int() {1, 2|};", "}")).toBe("var a = new int() {1, 2}|;");
    expect(typed(py, "value = f(1, 2|)", ")")).toBe("value = f(1, 2)|");
    expect(typed(java(), "foo(\n  a\n|);", ")")).toBe("foo(\n  a\n)|;");
  });

  it("inserts the bracket where the line still lacks one", () => {
    expect(typed(java(), "f(g(x|);", ")")).toBe("f(g(x)|);");
    expect(typed(java(), "x = |)", ")")).toBe("x = )|)");
  });
});

describe("Rust lifetimes", () => {
  const typed = (text: string, chars: string) => {
    const v = make(text, [
      closeBrackets(),
      prefsExtension({
        prefs: validateEditorExtras({}),
        path: "",
        softWrap: false,
        showWhitespace: false,
        hardWrapAt: 120,
        readOnly: false,
        language: "rust",
      }),
    ]);
    for (const ch of chars) {
      const r = v.state.selection.main;
      const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
      if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, r.from, r.to, ch, insert))) {
        const tr = insertBracket(v.state, ch);
        v.dispatch(tr ?? insert());
      }
    }
    return show(v);
  };

  it("keeps a lifetime's apostrophe single", () => {
    expect(typed("fn borrow<|>() {}", "'a")).toBe("fn borrow<'a|>() {}");
    expect(typed("fn f(x: &|str) {}", "'a ")).toBe("fn f(x: &'a |str) {}");
    expect(typed("struct S<'a, |> {}", "'b")).toBe("struct S<'a, 'b|> {}");
    expect(typed("fn f<T: |>() {}", "'static")).toBe("fn f<T: 'static|>() {}");
  });

  it("still pairs a char literal", () => {
    expect(typed("let c = |;", "'")).toBe("let c = '|';");
    expect(typed("f('a', |)", "'")).toBe("f('a', '|')");
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
  let CPP: LanguageSupport;
  beforeAll(async () => {
    RUST = (await cmLanguages.find((l) => l.name === "Rust")!.load()) as LanguageSupport;
    CPP = (await cmLanguages.find((l) => l.name === "C++")!.load()) as LanguageSupport;
  });

  it("pairs include brackets in C and C++, and template arguments in C++", () => {
    pair("c", CPP, "#include |", "#include <|>");
    pair("cpp", CPP, "#include |", "#include <|>");
    pair("cpp", CPP, "std::vector|", "std::vector<|>");
    pair("cpp", CPP, "auto p = std::make_unique|", "auto p = std::make_unique<|>");
    pair("cpp", CPP, "auto n = static_cast|", "auto n = static_cast<|>");
    pair("cpp", CPP, "template |", "template <|>");
    pair("cpp", CPP, "Box|", "Box<|>");
  });

  it("does not pair comparisons, shifts or macros in C and C++", () => {
    pair("c", CPP, "int f() { return a |", "int f() { return a <|");
    pair("cpp", CPP, "for (int i = 0; i|", "for (int i = 0; i<|");
    pair("cpp", CPP, "std::cout |", "std::cout <|");
    pair("cpp", CPP, "if (x < MAX|", "if (x < MAX<|");
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
    pair("kotlin", KOTLIN, "fun f() {\n  val c = count|\n}", "fun f() {\n  val c = count<|\n}");
    // …but a generic factory call written against its `<` takes type arguments.
    pair("kotlin", KOTLIN, "fun f() {\n  val v = mutableListOf|\n}", "fun f() {\n  val v = mutableListOf<|>\n}");
    pair("kotlin", KOTLIN, "fun f() {\n  val m = emptyMap|\n}", "fun f() {\n  val m = emptyMap<|>\n}");
    pair("kotlin", KOTLIN, "fun f() {\n  val ok = listOf |\n}", "fun f() {\n  val ok = listOf <|\n}");
  });

  it("pairs a string template's braces", () => {
    const v = make('fun f() {\n  val s = "$|"\n}', [KOTLIN, prefs("kotlin", {})]);
    type(v, "{");
    expect(show(v)).toBe('fun f() {\n  val s = "${|}"\n}');
    const outside = make("fun f() {\n  val s = $|x\n}", [KOTLIN, prefs("kotlin", {})]);
    type(outside, "{");
    expect(show(outside)).toBe("fun f() {\n  val s = ${|x\n}");
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

describe("semicolon at statement end", () => {
  const prefs = (language: string | undefined, smartKeys: Record<string, unknown> = {}) =>
    prefsExtension({
      prefs: validateEditorExtras({ smartKeys }),
      path: "",
      softWrap: false,
      showWhitespace: false,
      hardWrapAt: 120,
      readOnly: false,
      language,
    });

  const type = (v: EditorView, ch: string) => {
    const r = v.state.selection.main;
    const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
    if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, r.from, r.to, ch, insert)))
      v.dispatch(v.state.replaceSelection(ch), { userEvent: "input.type" });
  };

  const JAVA = java();
  const JS = javascript();
  const CSHARP = StreamLanguage.define(interpolationParser(csharp, "C#"));
  /** A Java statement inside a method body. */
  const inJava = (body: string) => `class A {\n  void f() {\n    ${body}\n  }\n}`;

  const semi = (language: string | undefined, support: Extension, text: string, expected: string, keys = {}) => {
    const v = make(text, [support, prefs(language, keys)]);
    type(v, ";");
    expect(show(v)).toBe(expected);
  };
  const stmt = (body: string, expected: string) => semi("java", JAVA, inJava(body), inJava(expected));

  it("moves ; typed before the closing parenthesis to the end of the statement", () => {
    stmt('System.out.println("hello world"|)', 'System.out.println("hello world");|');
    stmt("foo(|)", "foo();|");
    stmt("int n = size(list|)", "int n = size(list);|");
    stmt("return compute(a, b|)", "return compute(a, b);|");
  });

  it("steps over every closing parenthesis of nested calls", () => {
    stmt("foo(bar(baz|))", "foo(bar(baz));|");
    stmt("foo(bar(baz)|)", "foo(bar(baz));|");
    stmt("list.forEach(x -> use(x|))", "list.forEach(x -> use(x));|");
  });

  it("puts ; right after the parenthesis, before trailing whitespace", () => {
    stmt("foo(x|)   ", "foo(x);|   ");
  });

  it("completes a call whose arguments span lines", () => {
    stmt("foo(a,\n        b|)", "foo(a,\n        b);|");
  });

  it("completes a do-while condition", () => {
    stmt("do {\n    } while (more(|))", "do {\n    } while (more());|");
  });

  it("works in JavaScript and TypeScript", () => {
    semi("javascript", JS, "console.log(x|)", "console.log(x);|");
    semi("typescript", javascript({ typescript: true }), "const n: number = f(a|)", "const n: number = f(a);|");
  });

  it("works with stream parsers and without a syntax tree", () => {
    semi("csharp", CSHARP, "Console.WriteLine(x|)", "Console.WriteLine(x);|");
    semi("c", [], 'printf("%d", n|)', 'printf("%d", n);|');
  });

  it("types a plain ; in comments, literals and directives without a Lezer tree", () => {
    const lineComments = EditorState.languageData.of(() => [{ commentTokens: { line: "//" } }]);
    semi("c", lineComments, "f(); // call(x|)", "f(); // call(x;|)");
    semi("c", [], "#define CALL(x|)", "#define CALL(x;|)");
    semi("c", [], " * call(x|)", " * call(x;|)");
    semi("java", [], "@Deprecated(x|)", "@Deprecated(x;|)");
    semi("csharp", CSHARP, 'var s = @"call(x|)\n";', 'var s = @"call(x;|)\n";');
  });

  it("types a plain ; at the end of the line or before other code", () => {
    stmt("foo(x)|", "foo(x);|");
    stmt("foo(x|);", "foo(x;|);");
    stmt("foo(a|, b)", "foo(a;|, b)");
    stmt("foo(x|) + 1", "foo(x;|) + 1");
    stmt("foo(x|) // note", "foo(x;|) // note");
  });

  it("types a plain ; in strings and comments", () => {
    stmt("// call(x|)", "// call(x;|)");
    semi("java", JAVA, "class A {\n  /**\n   * call(x|)\n   */\n}", "class A {\n  /**\n   * call(x;|)\n   */\n}");
    semi("javascript", JS, "const s = `call(x|)\n`", "const s = `call(x;|)\n`");
  });

  it("types a plain ; in for headers, try-with-resources and other control statements", () => {
    stmt("for (int i = 0|)", "for (int i = 0;|)");
    stmt("for (int i = size(a|))", "for (int i = size(a;|))");
    stmt("try (var r = open(path|))", "try (var r = open(path;|))");
    stmt("if (ready(x|))", "if (ready(x;|))");
    stmt("} else if (ready(x|))", "} else if (ready(x;|))");
    stmt("while (next(|))", "while (next(;|))");
    stmt("switch (kind(x|))", "switch (kind(x;|))");
    stmt("synchronized (lock(|))", "synchronized (lock(;|))");
  });

  it("types a plain ; in declarations and annotations", () => {
    semi("java", JAVA, "class A {\n  void run(int a|)\n  {\n  }\n}", "class A {\n  void run(int a;|)\n  {\n  }\n}");
    semi(
      "java",
      JAVA,
      "class A {\n  @SuppressWarnings(x|)\n  void f() {}\n}",
      "class A {\n  @SuppressWarnings(x;|)\n  void f() {}\n}",
    );
    semi("javascript", JS, "function f(a|)", "function f(a;|)");
  });

  it("types a plain ; when the statement continues on the next line", () => {
    stmt("builder.add(x|)\n        .build();", "builder.add(x;|)\n        .build();");
    stmt("boolean ok = check(a|)\n        && check(b);", "boolean ok = check(a;|)\n        && check(b);");
  });

  it("only applies to languages that end statements with ;", () => {
    semi("python", [], "print(x|)", "print(x;|)");
  });

  it("is off when the Smart Keys option is cleared", () => {
    semi("java", JAVA, inJava("foo(x|)"), inJava("foo(x;|)"), { semicolonAtStatementEnd: false });
  });

  it("moves ; for every caret", () => {
    const v = make(inJava("foo(a|)\n    bar(b|)"), [JAVA, prefs("java")]);
    type(v, ";");
    expect(show(v)).toBe(inJava("foo(a);|\n    bar(b);|"));
  });

  it("is one undoable step", () => {
    const v = make(inJava("foo(x|)"), [JAVA, prefs("java"), history()]);
    type(v, ";");
    undo(v);
    expect(show(v)).toBe(inJava("foo(x|)"));
  });
});
