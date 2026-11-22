import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { StructuralRanges, SyntaxError, SyntaxErrors, SyntaxNode } from "@/bindings";
import { offsetToPos } from "@/editor/lsp/positions";
import {
  cachedStructureQueries,
  completeStatementStructural,
  hasLezerTree,
  moveStatementStructural,
  planCompleteStatement,
  planMoveStatement,
  unclosedBrackets,
  unterminated,
  type StructureQueries,
} from "./structural";
import { codeEnd, completeStatementSpec } from "./editing";

const comments = (line: string, block?: [string, string]): Extension =>
  EditorState.languageData.of(() => [{ commentTokens: { line, block: block && { open: block[0], close: block[1] } } }]);

/** `|` marks the caret. */
function state(text: string, extensions: Extension = []): EditorState {
  const at = text.indexOf("|");
  const doc = text.replace("|", "");
  return EditorState.create({ doc, selection: EditorSelection.cursor(Math.max(0, at)), extensions });
}

/** A node spanning the first occurrence of `snippet` (after `after`, if given). */
function node(
  s: EditorState,
  snippet: string,
  opts: { kind?: string; hasError?: boolean; after?: number } = {},
): SyntaxNode {
  const text = s.doc.toString();
  const from = text.indexOf(snippet, opts.after ?? 0);
  if (from < 0) throw new Error(`no ${snippet}`);
  return {
    kind: opts.kind ?? "statement",
    range: { start: offsetToPos(s.doc, from), end: offsetToPos(s.doc, from + snippet.length) },
    field: null,
    named: true,
    error: false,
    missing: false,
    hasError: opts.hasError ?? false,
  };
}

const ranges = (r: Partial<StructuralRanges>): StructuralRanges => ({
  selection: [],
  statement: null,
  prevStatement: null,
  nextStatement: null,
  block: null,
  declaration: null,
  prevDeclaration: null,
  nextDeclaration: null,
  ...r,
});

function missing(s: EditorState, offset: number, expected: string): SyntaxError {
  const p = offsetToPos(s.doc, offset);
  return { kind: "missing", range: { start: p, end: p }, expected, message: `missing \`${expected}\`` };
}

function unexpected(s: EditorState, from: number, to: number): SyntaxError {
  return {
    kind: "unexpected",
    range: { start: offsetToPos(s.doc, from), end: offsetToPos(s.doc, to) },
    expected: null,
    message: "unexpected",
  };
}

const errs = (...errors: SyntaxError[]): SyntaxErrors => ({ errors, truncated: false });

function apply(s: EditorState, spec: TransactionSpec | null): { text: string; caret: number } {
  if (!spec) throw new Error("no spec");
  const next = s.update(spec).state;
  return { text: next.doc.toString(), caret: next.selection.main.head };
}

/** Result text with `|` at the caret. */
function withCaret(s: EditorState, spec: TransactionSpec | null): string {
  const { text, caret } = apply(s, spec);
  return text.slice(0, caret) + "|" + text.slice(caret);
}

describe("hasLezerTree", () => {
  it("is false for stream modes and documents without a language", () => {
    const stream = StreamLanguage.define({ token: (st) => (st.next(), null) });
    expect(hasLezerTree(EditorState.create({ doc: "x", extensions: stream }))).toBe(false);
    expect(hasLezerTree(EditorState.create({ doc: "x" }))).toBe(false);
  });

  it("is true for a Lezer grammar", async () => {
    const java = await languages.find((l) => l.name === "Java")!.load();
    expect(hasLezerTree(EditorState.create({ doc: "class A {}", extensions: java }))).toBe(true);
  });
});

describe("cachedStructureQueries", () => {
  it("asks the backend once per position and document version", async () => {
    let stamp = 1;
    const fetchRanges = vi.fn(async () => ranges({}));
    const fetchErrors = vi.fn(async () => errs());
    const synced = vi.fn(async () => {});
    const q = cachedStructureQueries({ stamp: () => stamp, synced, fetchRanges, fetchErrors });
    await q.ranges({ line: 1, col: 0 });
    await q.ranges({ line: 1, col: 0 });
    await q.errors();
    await q.errors();
    expect(fetchRanges).toHaveBeenCalledTimes(1);
    expect(fetchErrors).toHaveBeenCalledTimes(1);
    await q.ranges({ line: 2, col: 0 });
    expect(fetchRanges).toHaveBeenCalledTimes(2);
    stamp = 2;
    await q.ranges({ line: 1, col: 0 });
    await q.errors();
    expect(fetchRanges).toHaveBeenCalledTimes(3);
    expect(fetchErrors).toHaveBeenCalledTimes(2);
    expect(synced).toHaveBeenCalledTimes(7);
  });

  it("answers null when the service fails", async () => {
    const q = cachedStructureQueries({
      stamp: () => 0,
      synced: async () => {},
      fetchRanges: () => Promise.reject(new Error("unavailable")),
      fetchErrors: () => Promise.reject(new Error("unavailable")),
    });
    expect(await q.ranges({ line: 0, col: 0 })).toBeNull();
    expect(await q.errors()).toBeNull();
  });
});

// Kotlin, as the tree-sitter service describes it.
const KOTLIN = `class Greeter {
    fun greet() {
        val a = 1
        val b = listOf(1)
            .map { it }
        if (a > 0) {
            println("hi")
        }
    }

    // Says bye.
    fun bye() {
    }
}
`;

describe("planMoveStatement", () => {
  const kt = (caretAfter: string) => {
    const s = state(KOTLIN.replace(caretAfter, caretAfter + "|"), comments("//", ["/*", "*/"]));
    return s;
  };

  it("swaps a statement with the next one, whole lines, caret following it", () => {
    const s = kt("val a");
    const r = ranges({
      statement: node(s, "val a = 1"),
      nextStatement: node(s, "val b = listOf(1)\n            .map { it }"),
      declaration: node(s, KOTLIN.slice(KOTLIN.indexOf("fun greet"), KOTLIN.indexOf("    }\n\n") + 5)),
    });
    const plan = planMoveStatement(s, r, false);
    expect(plan.kind).toBe("move");
    expect(withCaret(s, plan.kind === "move" ? plan.spec : null)).toContain(
      "        val b = listOf(1)\n            .map { it }\n        val a| = 1\n        if",
    );
  });

  it("swaps whole Go switch branches whose range runs to the next line's start", () => {
    const GO = 'func f(x int) {\n\tswitch x {\n\tcase 1:\n\t\tprintln("one")\n\tcase 2:\n\t\tprintln("two")\n\t}\n}\n';
    const s = state(GO.replace("case 1", "case| 1"), comments("//"));
    const one = node(s, 'case 1:\n\t\tprintln("one")\n');
    const two = node(s, 'case 2:\n\t\tprintln("two")\n');
    const plan = planMoveStatement(s, ranges({ statement: one, nextStatement: two }), false);
    expect(withCaret(s, plan.kind === "move" ? plan.spec : null)).toBe(
      'func f(x int) {\n\tswitch x {\n\tcase 2:\n\t\tprintln("two")\n\tcase| 1:\n\t\tprintln("one")\n\t}\n}\n',
    );
  });

  it("moves a multi-line statement up over its previous sibling", () => {
    const s = kt("if (a");
    const r = ranges({
      statement: node(s, 'if (a > 0) {\n            println("hi")\n        }'),
      prevStatement: node(s, "val b = listOf(1)\n            .map { it }"),
    });
    const plan = planMoveStatement(s, r, true);
    const out = withCaret(s, plan.kind === "move" ? plan.spec : null);
    expect(out).toContain(
      'val a = 1\n        if (a| > 0) {\n            println("hi")\n        }\n        val b = listOf(1)\n            .map { it }\n    }',
    );
  });

  it("uses the member when the enclosing statement is the whole class, and moves its comment along", () => {
    const s = kt("fun greet");
    const cls = node(s, KOTLIN.trimEnd(), { kind: "class_declaration" });
    const greet = node(s, KOTLIN.slice(KOTLIN.indexOf("fun greet"), KOTLIN.indexOf("    }\n\n") + 5));
    const bye = node(s, "fun bye() {\n    }");
    const plan = planMoveStatement(s, ranges({ statement: cls, declaration: greet, nextDeclaration: bye }), false);
    const out = withCaret(s, plan.kind === "move" ? plan.spec : null);
    expect(out.startsWith("class Greeter {\n    // Says bye.\n    fun bye() {\n    }\n\n    fun greet|() {")).toBe(
      true,
    );
  });

  it("does nothing at the first / last statement of a block", () => {
    const s = kt("println");
    const r = ranges({ statement: node(s, 'println("hi")') });
    expect(planMoveStatement(s, r, true)).toEqual({ kind: "noop" });
    expect(planMoveStatement(s, r, false)).toEqual({ kind: "noop" });
  });

  it("moves a member whose syntax errors are inside it, not one broken at its edges", () => {
    const s = kt("fun greet");
    const greetText = KOTLIN.slice(KOTLIN.indexOf("fun greet"), KOTLIN.indexOf("    }\n\n") + 5);
    const greet = node(s, greetText, { hasError: true });
    const bye = node(s, "fun bye() {\n    }");
    const r = ranges({ declaration: greet, nextDeclaration: bye });
    const inner = KOTLIN.indexOf("val a");
    expect(planMoveStatement(s, r, false, errs(unexpected(s, inner, inner + 3))).kind).toBe("move");
    const header = KOTLIN.indexOf("greet()");
    expect(planMoveStatement(s, r, false, errs(unexpected(s, header, header + 5))).kind).toBe("fallback");
    expect(planMoveStatement(s, r, false, null).kind).toBe("fallback");
  });

  it("does nothing when the sibling shares its lines with other code", () => {
    const s = state("  let a = 1\n      b = a|\n  in b\n", comments("--"));
    const r = ranges({ statement: node(s, "b = a"), prevStatement: node(s, "a = 1") });
    expect(planMoveStatement(s, r, true)).toEqual({ kind: "noop" });
  });

  it("falls back to moving the line for broken or shared lines", () => {
    const s = kt("val a");
    const next = node(s, "val b = listOf(1)\n            .map { it }");
    expect(planMoveStatement(s, null, false)).toEqual({ kind: "fallback" });
    expect(
      planMoveStatement(s, ranges({ statement: node(s, "val a = 1", { hasError: true }), nextStatement: next }), false),
    ).toEqual({
      kind: "fallback",
    });
    expect(planMoveStatement(s, ranges({ statement: node(s, "a = 1"), nextStatement: next }), false)).toEqual({
      kind: "fallback",
    });
  });
});

describe("completeStatementSpec (text rules)", () => {
  it("puts the `;` before a trailing comment", () => {
    const s = state("int a = 1| // one", comments("//"));
    expect(withCaret(s, completeStatementSpec(s, "java"))).toBe("int a = 1; // one\n|");
    expect(codeEnd('s = "//x" // c', "//")).toBe(9);
  });

  it("never adds braces in keyword-block languages nor `;` in Scala", () => {
    const rb = state("if x > 0|");
    expect(withCaret(rb, completeStatementSpec(rb, "ruby"))).toBe("if x > 0\n  |");
    const scala = state("val a = 1|");
    expect(withCaret(scala, completeStatementSpec(scala, "scala"))).toBe("val a = 1\n|");
  });

  it("keeps a header's trailing comment on the header line", () => {
    const s = state("if (x)| // c", [comments("//"), indentUnit.of("    ")]);
    expect(withCaret(s, completeStatementSpec(s, "kotlin"))).toBe("if (x) { // c\n    |\n}");
  });
});

describe("completeStatementSpec: foreach and elseif", () => {
  const ext = [comments("//"), indentUnit.of("    ")];
  it("gives a PHP or C# foreach a body instead of ending it with `;`", () => {
    for (const [head, language] of [
      ["foreach ($xs as $x)", "php"],
      ["foreach ($map as $k => $v)", "php"],
      ["elseif ($x)", "php"],
      ["foreach (var x in xs)", "csharp"],
    ] as const) {
      const s = state(`${head}|`, ext);
      expect(withCaret(s, completeStatementSpec(s, language))).toBe(`${head} {\n    |\n}`);
    }
    const bare = state("foreach|", ext);
    expect(withCaret(bare, completeStatementSpec(bare, "php"))).toBe("foreach (|) {\n}");
  });
});

describe("completeStatementSpec: C and C++ type definitions", () => {
  const ext = [comments("//"), indentUnit.of("    ")];
  it("ends a struct, class, union or enum with `};`", () => {
    for (const [head, language] of [
      ["struct S", "c"],
      ["typedef struct Node", "c"],
      ["union U", "c"],
      ["enum Color", "c"],
      ["class A", "cpp"],
      ["class B : public A", "cpp"],
      ["enum class E : int", "cpp"],
      ["template <typename T> class Box", "cpp"],
    ] as const) {
      const s = state(`${head}|`, ext);
      expect(withCaret(s, completeStatementSpec(s, language))).toBe(`${head} {\n    |\n};`);
    }
  });

  it("keeps a plain `}` for namespaces and control flow", () => {
    for (const head of ["if (x)", "namespace n"]) {
      const s = state(`${head}|`, ext);
      expect(withCaret(s, completeStatementSpec(s, "cpp"))).toBe(`${head} {\n    |\n}`);
    }
  });
});

describe("completeStatementSpec: TypeScript and Python", () => {
  const ts = [comments("//", ["/*", "*/"]), indentUnit.of("  ")];
  const py = [comments("#"), indentUnit.of("    ")];
  const complete = (text: string, language: string, ext: Extension) => {
    const s = state(text, ext);
    return withCaret(s, completeStatementSpec(s, language));
  };

  it("gives an unfinished arrow function a block body", () => {
    expect(complete("const f = (x: number) =>|", "typescript", ts)).toBe("const f = (x: number) => {\n  |\n};");
    expect(complete("  items.map((x) =>|", "typescript", ts)).toBe("  items.map((x) => {\n    |\n  });");
  });

  it("closes an unfinished object or call before the `;`", () => {
    expect(complete('const obj = { name: "Ada"|', "typescript", ts)).toBe('const obj = { name: "Ada" };\n|');
    expect(complete("foo(a, bar(2|", "typescript", ts)).toBe("foo(a, bar(2));\n|");
    expect(complete("call(a,|", "typescript", ts)).toBe("call(a,\n|");
  });

  it("finishes every Python compound statement header with `:`", () => {
    for (const head of [
      "async def fetch(url)",
      "with open(path) as f",
      "except ValueError",
      "case 1",
      "match command",
      "try",
      "async for x in xs",
    ])
      expect(complete(`${head}|`, "python", py)).toBe(`${head}:\n    |`);
    expect(complete("def f(x|", "python", py)).toBe("def f(x):\n    |");
    expect(complete("match = 5|", "python", py)).toBe("match = 5\n|");
  });
});

describe("completeStatementSpec: function names without a parameter list", () => {
  const ext = [comments("//"), indentUnit.of("    ")];
  it("adds the parameter list before the body", () => {
    for (const [head, language] of [
      ["func f", "go"],
      ["fn f", "rust"],
      ["pub async fn load<T>", "rust"],
      ["fun f", "kotlin"],
      ["private suspend fun load", "kotlin"],
      ["function f", "javascript"],
    ] as const) {
      const s = state(`${head}|`, ext);
      expect(withCaret(s, completeStatementSpec(s, language))).toBe(`${head}() {\n    |\n}`);
    }
    const done = state("func f(x int)|", ext);
    expect(withCaret(done, completeStatementSpec(done, "go"))).toBe("func f(x int) {\n    |\n}");
  });
});

describe("planCompleteStatement", () => {
  const java = [comments("//", ["/*", "*/"]), indentUnit.of("    ")];

  it("inserts the `)` tree-sitter reports missing, then completes the block head", () => {
    const s = state("    if (a > 0|\n    b();\n", java);
    const at = s.doc.line(1).to;
    const out = withCaret(s, planCompleteStatement(s, "java", null, errs(missing(s, at, ")"))));
    expect(out).toBe("    if (a > 0) {\n        |\n    }\n    b();\n");
  });

  it("closes brackets a broken line left open, before the `;`", () => {
    const s = state("    Foo(a, bar(2|\n    var b = 2;\n", java);
    const out = withCaret(s, planCompleteStatement(s, "csharp", null, errs(unexpected(s, 4, 7))));
    expect(out).toBe("    Foo(a, bar(2));\n    |\n    var b = 2;\n");
  });

  it("closes an initializer brace with its `;` and ignores tokens 'missing' after a finished statement", () => {
    const arr = state("    int[] x = {1, 2|\n    foo();\n", java);
    expect(withCaret(arr, planCompleteStatement(arr, "java", null, errs(unexpected(arr, 18, 19))))).toBe(
      "    int[] x = {1, 2};\n    |\n    foo();\n",
    );
    const done = state("    var b = 2;|\n}\n", java);
    const out = withCaret(done, planCompleteStatement(done, "csharp", null, errs(missing(done, 14, ")"))));
    expect(out).toBe("    var b = 2;\n    |\n}\n");
  });

  it("indents the body after a complete keyword-block head", () => {
    const s = state("def f(x)|\n  x\nend\n", indentUnit.of("  "));
    expect(withCaret(s, planCompleteStatement(s, "ruby", null, errs()))).toBe("def f(x)\n  |\n  x\nend\n");
  });

  it("gives a Java block head a body even when tree-sitter asks for a `;`", () => {
    const plan = (text: string) => {
      const s = state(text, java);
      const at = s.doc.line(1).to;
      return withCaret(s, planCompleteStatement(s, "java", null, errs(missing(s, at, ";"))));
    };
    expect(plan("    if (true)|\n")).toBe("    if (true) {\n        |\n    }\n");
    expect(plan("public class App|\n")).toBe("public class App {\n    |\n}\n");
    expect(plan("    public void run()|\n")).toBe("    public void run() {\n        |\n    }\n");
    expect(plan("    private static <T> List<T> of(T a, int b) throws IOException|\n")).toBe(
      "    private static <T> List<T> of(T a, int b) throws IOException {\n        |\n    }\n",
    );
    expect(plan("    public App()|\n")).toBe("    public App() {\n        |\n    }\n");
    expect(plan("    abstract void run()|\n")).toBe("    abstract void run();\n    |\n");
  });

  it("starts a loop or condition header for a bare keyword", () => {
    const s = state("    for|\n", java);
    expect(withCaret(s, planCompleteStatement(s, "java", null, errs()))).toBe("    for (|) {\n    }\n");
    const w = state("    } else if|\n", java);
    expect(withCaret(w, completeStatementSpec(w, "java"))).toBe("    } else if (|) {\n    }\n");
  });

  it("closes an unterminated string before the `;`", () => {
    const s = state('    String m = "hello|\n', java);
    const at = s.doc.line(1).to;
    expect(withCaret(s, planCompleteStatement(s, "java", null, errs(missing(s, at, ";"))))).toBe(
      '    String m = "hello";\n    |\n',
    );
    const done = state('    f("a\\"b", \'"\')|\n', java);
    expect(withCaret(done, completeStatementSpec(done, "java"))).toBe('    f("a\\"b", \'"\');\n    |\n');
  });

  it("takes a Rust lifetime for no quote", () => {
    const s = state("    let s: &'a str = x|\n", java);
    expect(withCaret(s, completeStatementSpec(s, "rust"))).toBe("    let s: &'a str = x;\n    |\n");
  });

  it("leaves calls and statements to the `;`", () => {
    for (const line of ["    foo(a, b)", "    System.out.println(x)", "    return foo(x)", "    throw new Error(m)"]) {
      const s = state(`${line}|\n`, java);
      expect(withCaret(s, completeStatementSpec(s, "java"))).toBe(`${line};\n    |\n`);
    }
  });

  it("places a missing `;` before a trailing comment", () => {
    const s = state("int a = 1| // one\nfoo();\n", java);
    const out = withCaret(s, planCompleteStatement(s, "java", null, errs(missing(s, 9, ";"))));
    expect(out).toBe("int a = 1; // one\n|\nfoo();\n");
  });

  it("continues below a complete multi-line statement", () => {
    const s = state("val b = listOf(1)|\n    .map { it }\nreturn b\n");
    const r = ranges({ statement: node(s, "val b = listOf(1)\n    .map { it }") });
    expect(withCaret(s, planCompleteStatement(s, "kotlin", r, errs()))).toBe(
      "val b = listOf(1)\n    .map { it }\n|\nreturn b\n",
    );
  });

  it("opens an Allman block on the next line", () => {
    const s = state("    public void Greet()|\n    {\n    }\n", java);
    expect(withCaret(s, planCompleteStatement(s, "csharp", null, errs()))).toBe(
      "    public void Greet()\n    {\n        |\n    }\n",
    );
  });

  it("adds `end` to an unterminated Ruby head (and only then)", () => {
    const text = "  def f(x)\n    if x > 0|\n    puts x\n  end\n";
    const s = state(text, indentUnit.of("  "));
    const broken = errs(unexpected(s, 0, s.doc.length));
    expect(withCaret(s, planCompleteStatement(s, "ruby", null, broken))).toBe(
      "  def f(x)\n    if x > 0\n      |\n    end\n    puts x\n  end\n",
    );
    // The `def` has its `end`: plain new line.
    const def = state(text.replace("|", "").replace("def f(x)", "def f(x)|"), indentUnit.of("  "));
    expect(withCaret(def, planCompleteStatement(def, "ruby", null, broken))).toBe(
      "  def f(x)\n    |\n    if x > 0\n    puts x\n  end\n",
    );
    // No syntax error: never guess an `end`.
    expect(withCaret(s, planCompleteStatement(s, "ruby", null, errs()))).toBe(
      "  def f(x)\n    if x > 0\n      |\n    puts x\n  end\n",
    );
  });

  it("adds Lua's `then` and Elixir's `do` with the `end`", () => {
    const lua = state("  if x > 0|\n  print(a)\nend\n", indentUnit.of("  "));
    expect(withCaret(lua, planCompleteStatement(lua, "lua", null, errs(unexpected(lua, 2, 20))))).toBe(
      "  if x > 0 then\n    |\n  end\n  print(a)\nend\n",
    );
    const ex = state("    if x > 0|\n    IO.puts(a)\n  end\n", indentUnit.of("  "));
    expect(withCaret(ex, planCompleteStatement(ex, "elixir", null, errs()))).toBe(
      "    if x > 0 do\n      |\n    end\n    IO.puts(a)\n  end\n",
    );
  });

  it("helpers: unclosed brackets and unterminated heads", () => {
    expect(unclosedBrackets('foo(a, "(", [1')).toEqual(["(", "["]);
    expect(unclosedBrackets("a) + (b")).toEqual([]);
    const s = EditorState.create({ doc: "if a\n  b\nelse\n  c\nend\n" });
    expect(unterminated(s, 1)).toBe(false);
    expect(unterminated(EditorState.create({ doc: "  if a\n  b\nend\n" }), 1)).toBe(true);
  });
});

describe("structural commands", () => {
  const views: EditorView[] = [];
  afterEach(() => views.splice(0).forEach((v) => v.destroy()));

  function view(text: string) {
    const v = new EditorView({ state: state(text, comments("//")) });
    views.push(v);
    return v;
  }

  const queries = (
    r: (v: EditorView) => StructuralRanges | null,
    e: SyntaxErrors | null = errs(),
  ): StructureQueries => ({
    ranges: vi.fn(async () => r(views[0]!)),
    errors: vi.fn(async () => e),
  });

  it("moves the statement and asks at the caret line start", async () => {
    const v = view("a()\nb|()\n");
    const q = queries((v) => ranges({ statement: node(v.state, "b()"), prevStatement: node(v.state, "a()") }));
    expect(await moveStatementStructural(v, true, q)).toBe("done");
    expect(v.state.doc.toString()).toBe("b()\na()\n");
    expect(q.ranges).toHaveBeenCalledWith({ line: 1, col: 0 });
  });

  it("drops the edit when the document changed meanwhile, and reports fallback without ranges", async () => {
    const v = view("a()\nb|()\n");
    const q: StructureQueries = {
      ranges: async () => {
        v.dispatch({ changes: { from: 0, insert: "x" } });
        return ranges({ statement: node(v.state, "b()"), prevStatement: node(v.state, "xa()") });
      },
      errors: async () => errs(),
    };
    expect(await moveStatementStructural(v, true, q)).toBe("stale");
    expect(v.state.doc.toString()).toBe("xa()\nb()\n");
    expect(
      await moveStatementStructural(
        view("a|\n"),
        true,
        queries(() => null),
      ),
    ).toBe("fallback");
  });

  it("completes with the structure service and falls back without it", async () => {
    const v = view("foo(1|\n");
    expect(
      await completeStatementStructural(
        v,
        "java",
        queries(() => null, errs(unexpected(v.state, 0, 5))),
      ),
    ).toBe("done");
    expect(v.state.doc.toString()).toBe("foo(1);\n\n");
    const w = view("x|\n");
    expect(await completeStatementStructural(w, "java", { ranges: async () => null, errors: async () => null })).toBe(
      "fallback",
    );
  });
});
