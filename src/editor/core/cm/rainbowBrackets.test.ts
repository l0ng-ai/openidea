import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { completedSyntaxState } from "@/test/syntax";
import { languages } from "@codemirror/language-data";
import { BracketScanner, bracketClass, rainbowBrackets } from "./rainbowBrackets";
import { heavyExtension } from "./setup";
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
    expect([0, 1, 2, 3, 4].map(bracketClass)).toEqual([
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
    const doc = "f(`" + "literal ([ ".repeat(500) + "${g([1])}" + " tail ) ".repeat(700) + "`); h()";
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
