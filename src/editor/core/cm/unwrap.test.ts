import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { unwrapOptions, type ChainNode } from "./unwrap";

/** A chain node spanning the `nth` occurrence of `snippet` in `src`. */
function node(src: string, kind: string, snippet: string, field: string | null = null, nth = 0): ChainNode {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = src.indexOf(snippet, from + 1);
  if (from < 0) throw new Error(`no ${snippet}`);
  return { kind, from, to: from + snippet.length, field };
}

function apply(src: string, o: { from: number; to: number; insert: string }) {
  return src.slice(0, o.from) + o.insert + src.slice(o.to);
}

describe("unwrapOptions (Unwrap/Remove)", () => {
  it("unwraps a braced if, re-indenting its body", () => {
    const src = "void f() {\n    if (a) {\n        foo();\n        bar();\n    }\n}\n";
    const ifStmt = "if (a) {\n        foo();\n        bar();\n    }";
    const chain = [
      node(src, "expression_statement", "foo();"),
      node(src, "block", "{\n        foo();\n        bar();\n    }", "consequence"),
      node(src, "if_statement", ifStmt),
      node(src, "block", src.slice(9, -1), "body"),
    ];
    const opts = unwrapOptions(Text.of(src.split("\n")), chain);
    expect(opts.map((o) => o.label)).toEqual(["Unwrap 'if'"]);
    expect(apply(src, opts[0]!)).toBe("void f() {\n    foo();\n    bar();\n}\n");
    const retained = opts[0]!.retained!;
    expect(src.slice(retained.from, retained.to)).toBe("foo();\n        bar();");
  });

  it("keeps the else branch the caret is in", () => {
    const src = "if (a) {\n  x();\n} else {\n  y();\n}";
    const chain = [
      node(src, "expression_statement", "y();"),
      node(src, "block", "{\n  y();\n}", "alternative"),
      node(src, "if_statement", src),
    ];
    const [o] = unwrapOptions(Text.of(src.split("\n")), chain);
    expect(o!.label).toBe("Unwrap 'else'");
    expect(apply(src, o!)).toBe("y();");
  });

  it("offers every enclosing statement, innermost first (Python)", () => {
    const src = "for x in xs:\n    try:\n        go(x)\n    except E:\n        pass\n";
    const tryStmt = "try:\n        go(x)\n    except E:\n        pass";
    const chain = [
      node(src, "expression_statement", "go(x)"),
      node(src, "block", "go(x)", "body"),
      node(src, "try_statement", tryStmt),
      node(src, "block", tryStmt, "body"),
      node(src, "for_statement", src.trimEnd()),
    ];
    const doc = Text.of(src.split("\n"));
    const opts = unwrapOptions(doc, chain);
    expect(opts.map((o) => o.label)).toEqual(["Unwrap 'try'", "Unwrap 'for'"]);
    expect(apply(src, opts[0]!)).toBe("for x in xs:\n    go(x)\n");
    expect(apply(src, opts[1]!)).toBe("try:\n    go(x)\nexcept E:\n    pass\n");
  });

  it("unwraps an elif clause into its body", () => {
    const src = "if a:\n    p()\nelif b:\n    q()\n";
    const chain = [
      node(src, "expression_statement", "q()"),
      node(src, "block", "q()", "consequence"),
      node(src, "elif_clause", "elif b:\n    q()", "alternative"),
      node(src, "if_statement", src.trimEnd()),
    ];
    const [o] = unwrapOptions(Text.of(src.split("\n")), chain);
    expect(o!.label).toBe("Unwrap 'elif'");
    expect(apply(src, o!)).toBe("q()\n");
  });

  it("keeps braces for a mid-line else-if and ignores the condition", () => {
    const src = "if (a) {\n    p();\n} else if (b) {\n    q();\n}";
    const inner = "if (b) {\n    q();\n}";
    const chain = [
      node(src, "expression_statement", "q();"),
      node(src, "block", "{\n    q();\n}", "consequence"),
      node(src, "if_statement", inner, "alternative"),
      node(src, "if_statement", src),
    ];
    const opts = unwrapOptions(Text.of(src.split("\n")), chain);
    expect(opts.map((o) => o.label)).toEqual(["Unwrap 'if'", "Unwrap 'else'"]);
    expect(apply(src, opts[0]!)).toBe("if (a) {\n    p();\n} else {\n    q();\n}");
    expect(apply(src, opts[1]!)).toBe("if (b) {\n    q();\n}");
    const retained = opts[0]!.retained!;
    expect(src.slice(retained.from, retained.to)).toBe("{\n    q();\n}");

    const cond = [
      node(src, "identifier", "b"),
      node(src, "parenthesized_expression", "(b)", "condition"),
      node(src, "if_statement", inner, "alternative"),
    ];
    expect(unwrapOptions(Text.of(src.split("\n")), cond)).toEqual([]);
  });
});
