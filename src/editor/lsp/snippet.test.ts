import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { snippet } from "@codemirror/autocomplete";
import { lspSnippetToCm, lspSnippetToPlain, snippetVariables } from "./snippet";

/** Instantiates a CM template to check the produced text and field positions. */
function expand(template: string) {
  let state = EditorState.create({ doc: "" });
  snippet(template)({ state, dispatch: (tr) => (state = tr.state) }, null, 0, 0);
  return { text: state.doc.toString(), sel: state.selection.main };
}

describe("lspSnippetToCm", () => {
  it("converts tab stops, placeholders and the final position", () => {
    expect(lspSnippetToCm("foo($1, ${2:bar})$0")).toBe("foo(${1}, ${2:bar})${0}");
    expect(lspSnippetToCm("${1}")).toBe("${1}");
  });

  it("escapes literal braces for CodeMirror", () => {
    const t = lspSnippetToCm("fn main() {\n\t$0\n}");
    expect(t).toBe("fn main() \\{\n\t${0}\n\\}");
    expect(expand(t).text).toBe("fn main() {\n  \n}");
  });

  it("handles LSP escapes", () => {
    expect(lspSnippetToCm("cost \\$5 \\} \\\\")).toBe("cost $5 \\} \\" + "${0}");
    expect(expand(lspSnippetToCm("a \\${1}")).text).toBe("a ${1}");
  });

  it("flattens nested placeholders into the outer field", () => {
    expect(lspSnippetToCm("${1:foo(${2:bar})}")).toBe("${1:foo(bar)}");
  });

  it("uses the first choice", () => {
    expect(lspSnippetToCm("${1|public,private|} x")).toBe("${1:public} x");
  });

  it("resolves variables, defaults and unknown names", () => {
    const vars = snippetVariables("/p/src/Main.kt");
    expect(lspSnippetToCm("class $TM_FILENAME_BASE", vars)).toBe("class Main${0}");
    expect(lspSnippetToCm("${NOPE:dflt}", vars)).toBe("dflt${0}");
    expect(lspSnippetToCm("$NOPE", vars)).toBe("${NOPE}");
  });

  it("ignores transforms", () => {
    expect(lspSnippetToCm("${1/(.*)/${1:/upcase}/}x")).toBe("${1}x");
  });

  it("keeps placeholder text whose braces CodeMirror can't name", () => {
    expect(lspSnippetToCm("${1:{}}")).toBe("${1}\\{\\}");
  });

  it("treats a lone dollar as text", () => {
    expect(lspSnippetToCm("$ x $")).toBe("$ x $${0}");
  });

  it("selects the first field when instantiated", () => {
    const { text, sel } = expand(lspSnippetToCm("call(${1:arg}, $2)$0"));
    expect(text).toBe("call(arg, )");
    expect([sel.from, sel.to]).toEqual([5, 8]);
  });

  it.each([
    ["val", {}, "val"],
    ["$TM_FILENAME_BASE", { TM_FILENAME_BASE: "Main" }, "Main"],
    ["${MISSING:val}", {}, "val"],
    ["\\${1}", {}, "${1}"],
    ["cost \\$5", {}, "cost $5"],
    ["first\n\tlast", {}, "first\n  last"],
    ["/* 😀 */ val", {}, "/* 😀 */ val"],
  ])("places the caret at the end of a fieldless snippet (%s)", (source, vars, expected) => {
    const { text, sel } = expand(lspSnippetToCm(source, vars));
    expect(text).toBe(expected);
    expect([sel.from, sel.to]).toEqual([expected.length, expected.length]);
  });

  it.each([
    ["before$0after", "beforeafter", 6, 6],
    ["${1:arg}after", "argafter", 0, 3],
    ["${1|val,other|}after", "valafter", 0, 3],
    ["$UNKNOWN after", "UNKNOWN after", 0, 7],
  ])("preserves the selected field in %s", (source, expected, from, to) => {
    const { text, sel } = expand(lspSnippetToCm(source));
    expect(text).toBe(expected);
    expect([sel.from, sel.to]).toEqual([from, to]);
  });

  it("produces plain text previews", () => {
    expect(lspSnippetToPlain("foo(${1:a}, ${2|x,y|})$0")).toBe("foo(a, x)");
  });
});
