import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { BracketScanner, bracketClass } from "./rainbowBrackets";
import { heavyExtension } from "./setup";
import type { EditorSettings } from "@/platform/ipc";

const cStyle = EditorState.languageData.of(() => [
  { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
]);

/** `char@depth` of every coloured bracket (`!` for unmatched). */
function marks(doc: string, ext: Extension = [], from = 0, to = doc.length, scanner = new BracketScanner()) {
  const state = EditorState.create({ doc, extensions: ext });
  ensureSyntaxTree(state, doc.length, 5000);
  return scanner.marks(state, from, to).map((m) => `${doc[m.from]}${m.depth < 0 ? "!" : m.depth}`);
}

const javascript = () => languages.find((l) => l.name === "JavaScript")!.load();

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
