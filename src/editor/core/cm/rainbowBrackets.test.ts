import { describe, expect, it } from "vitest";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { completedSyntaxState } from "@/test/syntax";
import { languages } from "@codemirror/language-data";
import {
  BracketScanner,
  DEFAULT_RAINBOW_OPTIONS,
  LONG_LINE,
  bracketClass,
  bracketScanner,
  rainbowBrackets,
  type RainbowBracketOptions,
} from "./rainbowBrackets";
import { heavyExtension } from "./setup";
import { _resetLanguages, bracketSyntax, loadLanguageInfos } from "./languages";
import type { DocBackend, LanguageInfo } from "../backend";
import type { EditorSettings } from "@/platform/ipc";

const cStyle = EditorState.languageData.of(() => [
  { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
]);

/** `char@depth` of every coloured bracket (`!` for unmatched). */
function marks(doc: string, ext: Extension = [], from = 0, to = doc.length, scanner = new BracketScanner()) {
  const state = completedSyntaxState(EditorState.create({ doc, extensions: ext }));
  return scanner.marks(state, from, to).map((m) => `${doc[m.from]}${m.depth < 0 ? "!" : m.depth}`);
}

const load = (name: string) => languages.find((l) => l.name === name)!.load();
const javascript = () => load("JavaScript");

/** Classes of the coloured brackets an editor renders with `extensions`. */
function rendered(doc: string, extensions: Extension) {
  const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
  const classes = [...view.contentDOM.querySelectorAll("[class*=cm-rainbow-bracket]")].map(
    (e) => `${e.textContent}${e.className.replace("cm-rainbow-bracket-", "")}`,
  );
  view.destroy();
  return classes;
}

describe("rainbow brackets", () => {
  it("colours brackets by nesting depth, cycling through the palette", () => {
    expect(marks("f(a[b{c}d]e)")).toEqual(["(0", "[1", "{2", "}2", "]1", ")0"]);
    expect([0, 1, 2, 3, 4].map((depth) => bracketClass(depth))).toEqual([
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-3",
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
    ]);
  });

  it("marks unmatched and mismatched brackets", () => {
    expect(marks("a)b")).toEqual([")!"]);
    expect(marks("(]")).toEqual(["(!", "]!"]);
    expect(marks("x(y")).toEqual(["(!"]);
    expect(marks("((a)")).toEqual(["(!", "(1", ")1"]);
    expect(bracketClass(-1)).toBe("cm-rainbow-bracket-unmatched");
  });

  it("skips strings and comments lexically when there is no syntax tree", () => {
    const doc = "f(\"(\", '[', `{\n)`) // (\n/* ] */ g()";
    expect(marks(doc, cStyle)).toEqual(["(0", ")0", "(0", ")0"]);
    // Primes and lifetimes are not quotes.
    expect(marks("f x' = (x', y)", cStyle)).toEqual(["(0", ")0"]);
  });

  it("skips strings, comments and regexps with the syntax tree", async () => {
    const doc = 'f("(", /[(]/, `{`) // )\n/* ] */ g([1, {a: 2}])';
    expect(marks(doc, await javascript())).toEqual(["(0", ")0", "(0", "[1", "{2", "}2", "]1", ")0"]);
  });

  it.each(["JavaScript", "TypeScript"])("colours %s template expressions but skips literal text", async (name) => {
    const doc = 'f(`literal ([ ${g(["}", /[)]/]) /* ] */} tail ) ${h()}`)';
    expect(marks(doc, await load(name))).toEqual([
      "(0",
      "{1",
      "(2",
      "[3",
      "]3",
      ")2",
      "}1",
      "{1",
      "(2",
      ")2",
      "}1",
      ")0",
    ]);
  });

  it("handles nested templates and escaped interpolation delimiters", async () => {
    const doc = "f(`\\${literal(} ${g(`text ) ${h([1])}`)} tail [`); after()";
    expect(marks(doc, await javascript())).toEqual([
      "(0",
      "{1",
      "(2",
      "{3",
      "(4",
      "[5",
      "]5",
      ")4",
      "}3",
      ")2",
      "}1",
      ")0",
      "(0",
      ")0",
    ]);
  });

  it("colours Python replacements and nested format expressions but skips literal braces", async () => {
    const doc = "s = f\"literal ([ {{escaped}} {f([')']):)>{width()}} tail ]\"; g()";
    expect(marks(doc, await load("Python"))).toEqual([
      "{0",
      "(1",
      "[2",
      "]2",
      ")1",
      "{1",
      "(2",
      ")2",
      "}1",
      "}0",
      "(0",
      ")0",
    ]);
  });

  it("colours PHP interpolation without colouring its enclosing string", async () => {
    expect(marks('<?php $s = "literal ( {$a[0]} tail ]"; f();', await load("PHP"))).toEqual([
      "{0",
      "[1",
      "]1",
      "}0",
      "(0",
      ")0",
    ]);
  });

  it.each([
    ["JavaScript", 'f("(\\\"[", \'{\', `)`)'],
    ["Python", 'f("(", \']\', r"{", """multi\n)""")'],
    ["Rust", 'f(\'(\', "[", r#"}"#)'],
    ["Java", 'f(\'(\', "[", """\n}\n""")'],
  ])("keeps %s string and character contents uncoloured", async (name, doc) => {
    expect(marks(doc, await load(name))).toEqual(["(0", ")0"]);
  });

  it.each(["HTML", "JSX"])("skips %s attribute values and keeps embedded code", async (name) => {
    const doc =
      name === "HTML"
        ? '<div a="(" b=] c=\'{\'><!-- ) --><script>f("(", [1])</script></div>'
        : 'const x = <div a="(" b=\']\' c={f("}", [1])}>{g()}</div>';
    expect(marks(doc, await load(name))).toEqual(
      name === "HTML" ? ["(0", "[1", "]1", ")0"] : ["{0", "(1", "[2", "]2", ")1", "}0", "{0", "(1", ")1", "}0"],
    );
  });

  it("keeps interpolation depth across chunks, viewports and edits", async () => {
    // Newlines keep every line under `LONG_LINE`; the template still crosses chunk boundaries.
    const doc =
      "f(`" +
      ("literal ([ ".repeat(20) + "\n").repeat(30) +
      "${g([1])}" +
      (" tail ) ".repeat(20) + "\n").repeat(40) +
      "`); h()";
    const ext = await javascript();
    const scanner = new BracketScanner();
    const from = doc.indexOf("[1]");
    expect(marks(doc, ext, from, doc.length, scanner)).toEqual(["[3", "]3", ")2", "}1", ")0", "(0", ")0"]);
    expect(marks(doc, ext, from + 2, doc.length, scanner)).toEqual(["]3", ")2", "}1", ")0", "(0", ")0"]);
    let state = completedSyntaxState(EditorState.create({ doc, extensions: ext }));
    const edit = doc.indexOf("${");
    state = completedSyntaxState(state.update({ changes: { from: edit, insert: "\\" } }).state);
    scanner.invalidate(edit);
    expect(
      scanner.marks(state, from + 1, state.doc.length).map((m) => `${state.sliceDoc(m.from, m.from + 1)}${m.depth}`),
    ).toEqual([")0", "(0", ")0"]);
  });

  it("renders only interpolation code and leaves HTML attributes undecorated", async () => {
    expect(rendered('`text ( ${f("}", [1])} tail ]`', [await javascript(), rainbowBrackets()])).toEqual([
      "{1",
      "(2",
      "[3",
      "]3",
      ")2",
      "}1",
    ]);
    expect(rendered('<div title="("><script>f([1])</script></div>', [await load("HTML"), rainbowBrackets()])).toEqual([
      "(1",
      "[2",
      "]2",
      ")1",
    ]);
  });

  it("knows the depth at a viewport far into the document and after edits", () => {
    const body = "x(y)\n".repeat(5000);
    const doc = `{\n${body}[z]\n}`;
    const scanner = new BracketScanner();
    const at = doc.indexOf("[z]");
    expect(marks(doc, cStyle, at, doc.length, scanner)).toEqual(["[1", "]1", "}0"]);
    // Checkpoints make the rescan start near the viewport; an edit before it invalidates them.
    let state = EditorState.create({ doc, extensions: cStyle });
    const tr = state.update({ changes: { from: 100, insert: "(" } });
    scanner.invalidate(100);
    state = tr.state;
    const from = at + 1;
    expect(
      scanner
        .marks(state, from, state.doc.length)
        .map((m) => `${state.doc.sliceString(m.from, m.from + 1)}${m.depth < 0 ? "!" : m.depth}`),
    ).toEqual(["[2", "]2", "}!"]);
  });

  it("knows the innermost open bracket at given positions, also far into the document", async () => {
    const body = "x(y)\n".repeat(5000);
    const doc = `{\n${body}f([\n"(", g(\n`;
    const state = EditorState.create({ doc, extensions: cStyle });
    const scanner = new BracketScanner();
    const at = (...positions: number[]) =>
      scanner.openAt(state, positions).map((m) => m && `${doc[m.from]}${m.depth}@${m.from}`);
    const f = doc.indexOf("f([");
    const g = doc.indexOf("g(");
    expect(at(0, 1, f, f + 3, doc.length)).toEqual([null, "{0@0", "{0@0", `[2@${f + 2}`, `(3@${g + 1}`]);
    // The string's bracket is skipped; asking again (from checkpoints) gives the same answer.
    expect(at(g)).toEqual([`[2@${f + 2}`]);
    // With a syntax tree, a bracket in a template literal is skipped too.
    const js = completedSyntaxState(EditorState.create({ doc: "f(`(`, [\n", extensions: await javascript() }));
    expect(new BracketScanner().openAt(js, [js.doc.length]).map((m) => m?.depth)).toEqual([1]);
  });

  it("jumps over minified lines, keeping the nesting across them", async () => {
    // The long line starts inside a scan chunk; one of its brackets is never closed.
    const pad = "y()\n".repeat(1100);
    const long = `f(${"x({a:[1,2]});".repeat(Math.ceil(LONG_LINE / 13))}`;
    const doc = `{\n${pad}${long}\n[z]\n}`;
    const from = doc.indexOf(long);
    for (const ext of [cStyle, await javascript()]) expect(marks(doc, ext, from)).toEqual(["[1", "]1", "}0"]);
    // One character shorter, it is scanned like any other line.
    const short = "x({a:[1,2]});".repeat(Math.floor((LONG_LINE - 1) / 13));
    expect(marks(`{\n${short}\n[z]\n}`, cStyle).slice(0, 7)).toEqual(["{0", "(1", "{2", "[3", "]3", "}2", ")1"]);
    const state = EditorState.create({ doc, extensions: cStyle });
    expect(new BracketScanner().openAt(state, [doc.indexOf("[z]") + 1]).map((m) => m?.depth)).toEqual([1]);
  });

  it("drops a line's brackets once it grows past the limit and brings them back when it shrinks", () => {
    // Checkpoints fall inside the line while it is short; its open `f(` must not leak past it once long.
    const line = `f(${"x({a:[1,2]});".repeat(Math.floor((LONG_LINE - 100) / 13))}`;
    const doc = `${"y()\n".repeat(1100)}${line}\n[z]\n`;
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [cStyle, rainbowBrackets()] }),
      parent: document.body,
    });
    const depthOfZ = () => {
      const state = view.state;
      const at = state.doc.toString().indexOf("[z]");
      return bracketScanner(view)!
        .marks(state, at, state.doc.length)
        .map((m) => m.depth);
    };
    expect(depthOfZ()).toEqual([1, 1]);
    const end = doc.indexOf("\n[z]");
    view.dispatch({ changes: { from: end, insert: "x".repeat(200) } });
    expect(depthOfZ()).toEqual([0, 0]);
    view.dispatch({ changes: { from: end, to: end + 200 } });
    expect(depthOfZ()).toEqual([1, 1]);
    view.destroy();
  });

  it("is installed by the Rainbow brackets setting", () => {
    const render = (rainbowBrackets: boolean) => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "f(a[b])",
          extensions: [cStyle, heavyExtension(7, { rainbowBrackets } as unknown as EditorSettings)],
        }),
        parent: document.body,
      });
      const classes = [...view.contentDOM.querySelectorAll("[class*=cm-rainbow-bracket]")].map((e) => e.className);
      view.destroy();
      return classes;
    };
    expect(render(false)).toEqual([]);
    expect(render(true)).toEqual([
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-1",
    ]);
  });
});

/** The node names of the bundled language definitions (`languages/*.toml`, `[rainbow-brackets]`). */
const SYNTAX = {
  angle: [
    "TypeArgList",
    "TypeParamList",
    "TypeArguments",
    "TypeParameters",
    "TemplateArgumentList",
    "TemplateParameterList",
  ],
  tags: ["OpenTag", "CloseTag", "SelfClosingTag", "JSXOpenTag", "JSXCloseTag", "JSXSelfClosingTag", "JSXFragmentTag"],
};
const angleScanner = (options: Partial<RainbowBracketOptions> = {}) =>
  new BracketScanner({ ...DEFAULT_RAINBOW_OPTIONS, angle: true, syntax: SYNTAX, ...options });

describe("rainbow brackets: bracket kinds and palette", () => {
  it("leaves angle brackets alone by default, also with the language's syntax nodes known", async () => {
    const doc = "let m: Map<string, Array<T>> = f([1]);";
    const ext = await load("TypeScript");
    expect(marks(doc, ext, 0, doc.length, new BracketScanner({ ...DEFAULT_RAINBOW_OPTIONS, syntax: SYNTAX }))).toEqual([
      "(0",
      "[1",
      "]1",
      ")0",
    ]);
    expect(DEFAULT_RAINBOW_OPTIONS).toMatchObject({ round: true, square: true, curly: true, angle: false, colors: 3 });
  });

  it.each([
    ["TypeScript", "let m: Map<string, Array<T>> = f(a < b); if (x > 1) y = z >> 1; class A<T extends B<C>> {}"],
    ["Java", "Map<String, List<Integer>> m = new HashMap<>(); boolean b = a < c && d >> 2 > 1;"],
    ["Rust", "let v: Vec<Vec<u8>> = Vec::<u8>::new(); if a < b && c >> 1 > 0 {}"],
    ["C++", "std::vector<std::vector<int>> v; bool b = a < c; int s = x >> 1;"],
  ])("colours %s type argument delimiters, never comparisons or shifts", async (name, doc) => {
    const got = marks(doc, await load(name), 0, doc.length, angleScanner());
    const expected = {
      TypeScript: ["<0", "<1", ">1", ">0", "(0", ")0", "(0", ")0", "<0", "<1", ">1", ">0", "{0", "}0"],
      Java: ["<0", "<1", ">1", ">0", "<0", ">0", "(0", ")0"],
      Rust: ["<0", "<1", ">1", ">0", "<0", ">0", "(0", ")0", "{0", "}0"],
      "C++": ["<0", "<1", ">1", ">0"],
    }[name];
    expect(got).toEqual(expected);
  });

  it("nests the brackets inside type arguments one level deeper", async () => {
    const doc = "let f: Map<K, (x: V[]) => void> = g();";
    expect(marks(doc, await load("TypeScript"), 0, doc.length, angleScanner())).toEqual([
      "<0",
      "(1",
      "[2",
      "]2",
      ")1",
      ">0",
      "(0",
      ")0",
    ]);
  });

  it("skips angle brackets in strings and comments", async () => {
    const doc = 'List<String> a; // List<X>\nString s = "<a>"; /* Map<K, V> */';
    expect(marks(doc, await load("Java"), 0, doc.length, angleScanner())).toEqual(["<0", ">0"]);
  });

  it("colours markup tags by element depth, with void and self-closing elements on their own", async () => {
    const html = '<div class="("><br><p>x</p><img src=a /></div>';
    expect(marks(html, await load("HTML"), 0, html.length, angleScanner())).toEqual([
      "<0",
      ">0",
      "<1",
      ">1",
      "<1",
      ">1",
      "<1",
      ">1",
      "<1",
      ">1",
      "<0",
      ">0",
    ]);
    const xml = '<a x="1"><b/><c>t</c></a>';
    expect(marks(xml, await load("XML"), 0, xml.length, angleScanner())).toEqual([
      "<0",
      ">0",
      "<1",
      ">1",
      "<1",
      ">1",
      "<1",
      ">1",
      "<0",
      ">0",
    ]);
    // Implied end tags (`<li>`) leave the element on one level with its siblings.
    const list = "<ul><li>a<li>b</ul>";
    expect(marks(list, await load("HTML"), 0, list.length, angleScanner())).toEqual([
      "<0",
      ">0",
      "<1",
      ">1",
      "<1",
      ">1",
      "<0",
      ">0",
    ]);
  });

  it("colours JSX tags and fragments, with embedded code a level deeper, but not comparisons in it", async () => {
    const doc = "const x = <div a={f(b < c)}>{g()}<br/><>t</></div>;";
    expect(marks(doc, await load("JSX"), 0, doc.length, angleScanner())).toEqual([
      "<0",
      "{1",
      "(2",
      ")2",
      "}1",
      ">0",
      "{1",
      "(2",
      ")2",
      "}1",
      "<1",
      ">1",
      "<1",
      ">1",
      "<1",
      ">1",
      "<0",
      ">0",
    ]);
  });

  it("marks unterminated tags and type arguments as unmatched and keeps the depth after them", async () => {
    const html = "<div><span></div><p>x</p";
    expect(marks(html, await load("HTML"), 0, html.length, angleScanner())).toEqual([
      "<0",
      ">0",
      "<1",
      ">1",
      "<0",
      ">0",
      "<0",
      ">0",
      "<!",
    ]);
    const ts = "let x: Array<string = 1; f()";
    expect(marks(ts, await load("TypeScript"), 0, ts.length, angleScanner())).toEqual(["<!", "(0", ")0"]);
  });

  it("colours tags and type arguments of embedded code (TypeScript in Vue)", async () => {
    const doc = '<template><div :a="b < c"><Comp/></div></template><script lang="ts">let x: Array<T>;</script>';
    expect(marks(doc, await load("Vue"), 0, doc.length, angleScanner())).toEqual([
      "<0",
      ">0",
      "<1",
      ">1",
      "<2",
      ">2",
      "<1",
      ">1",
      "<0",
      ">0",
      "<0",
      ">0",
      "<1",
      ">1",
      "<0",
      ">0",
    ]);
  });

  it("keeps tag depth across chunks and in a viewport far into the document", async () => {
    const doc = `<main>\n${"<p>text (</p>\n".repeat(800)}<section><b>x</b></section>\n</main>`;
    const ext = await load("HTML");
    const from = doc.indexOf("<section>");
    expect(marks(doc, ext, from, doc.length, angleScanner())).toEqual([
      "<1",
      ">1",
      "<2",
      ">2",
      "<2",
      ">2",
      "<1",
      ">1",
      "<0",
      ">0",
    ]);
    const state = completedSyntaxState(EditorState.create({ doc, extensions: ext }));
    const open = angleScanner().openAt(state, [from + "<section>".length]);
    expect(open.map((m) => m && `${doc[m.from]}${m.depth}@${m.from}`)).toEqual([`<1@${from}`]);
  });

  it("leaves the depth of other brackets stable when a kind is switched off", () => {
    const scanner = new BracketScanner({ ...DEFAULT_RAINBOW_OPTIONS, round: false });
    expect(marks("f(a[b{c(d)}e])", [], 0, 14, scanner)).toEqual(["[1", "{2", "}2", "]1"]);
    expect(marks("x) [y]", [], 0, 6, new BracketScanner({ ...DEFAULT_RAINBOW_OPTIONS, round: false }))).toEqual([
      "[0",
      "]0",
    ]);
    // A block opened by an uncoloured kind gives indent guides no bracket colour.
    const state = EditorState.create({ doc: "f(\n  [x" });
    expect(scanner.openAt(state, [2, state.doc.length]).map((m) => m && m.depth)).toEqual([null, 1]);
  });

  it("cycles through the chosen number of colours", () => {
    expect([0, 1, 2, 3, 4, 5].map((d) => bracketClass(d, 5))).toEqual([
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-3",
      "cm-rainbow-bracket-4",
      "cm-rainbow-bracket-5",
      "cm-rainbow-bracket-1",
    ]);
    expect([0, 1, 2].map((d) => bracketClass(d, 2))).toEqual([
      "cm-rainbow-bracket-1",
      "cm-rainbow-bracket-2",
      "cm-rainbow-bracket-1",
    ]);
    // Out of range palette lengths are clamped to 2–5.
    expect(bracketClass(5, 9)).toBe("cm-rainbow-bracket-1");
    expect(bracketClass(1, 1)).toBe("cm-rainbow-bracket-2");
    expect(rendered("((((()))))", [cStyle, rainbowBrackets({ colors: 4 })])).toEqual([
      "(1",
      "(2",
      "(3",
      "(4",
      "(1",
      ")1",
      ")4",
      ")3",
      ")2",
      ")1",
    ]);
  });

  it("updates an open editor when the options change", async () => {
    const options = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: "let a: Array<number[]> = [];",
        extensions: [await load("TypeScript"), options.of(rainbowBrackets())],
      }),
      parent: document.body,
    });
    const classes = () =>
      [...view.contentDOM.querySelectorAll("[class*=cm-rainbow-bracket]")].map(
        (e) => `${e.textContent}${e.className.replace("cm-rainbow-bracket-", "")}`,
      );
    expect(classes()).toEqual(["[1", "]1", "[1", "]1"]);
    view.dispatch({
      effects: options.reconfigure(rainbowBrackets({ angle: true, square: false, colors: 2, syntax: SYNTAX })),
    });
    expect(classes()).toEqual(["<1", ">1"]);
    view.destroy();
  });

  it("is configured by the bracket kind and colour settings", () => {
    const render = (editor: Record<string, unknown>) => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "f(a[b{c}])",
          extensions: [cStyle, heavyExtension(10, { rainbowBrackets: true, ...editor } as unknown as EditorSettings)],
        }),
        parent: document.body,
      });
      const classes = [...view.contentDOM.querySelectorAll("[class*=cm-rainbow-bracket]")].map(
        (e) => `${e.textContent}${e.className.replace("cm-rainbow-bracket-", "")}`,
      );
      view.destroy();
      return classes;
    };
    expect(render({})).toEqual(["(1", "[2", "{3", "}3", "]2", ")1"]);
    expect(
      render({ rainbowBracketKinds: { round: false, square: true, curly: true }, rainbowBracketColors: 2 }),
    ).toEqual(["[2", "{1", "}1", "]2"]);
  });

  it("takes the angle syntax of every language definition", async () => {
    _resetLanguages();
    const info = (id: string, rainbowBrackets?: LanguageInfo["rainbowBrackets"]) =>
      ({
        id,
        name: id,
        extensions: [],
        uiMode: null,
        lineComment: null,
        blockComment: null,
        indent: null,
        rainbowBrackets,
      }) as LanguageInfo;
    await loadLanguageInfos({
      languages: async () => [
        info("typescript", { angle: ["TypeArgList", "TypeParamList"], tags: [] }),
        info("typescriptreact", { angle: ["TypeArgList"], tags: ["JSXOpenTag"] }),
        info("html", { angle: [], tags: ["OpenTag"] }),
        info("python"),
      ],
    } as unknown as DocBackend);
    expect(bracketSyntax()).toEqual({ angle: ["TypeArgList", "TypeParamList"], tags: ["JSXOpenTag", "OpenTag"] });
    expect(bracketSyntax()).toBe(bracketSyntax());
    _resetLanguages();
  });
});
