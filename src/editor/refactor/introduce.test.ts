import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { ExpressionAt, NodeAt, Range, StructuralRanges, SyntaxNode } from "@/bindings";

// --- a hand-built syntax tree over the test document ----------------------------

interface FakeNode {
  kind: string;
  from: number;
  to: number;
  field: string | null;
  parent: FakeNode | null;
  error?: boolean;
}

let text = "";
let nodes: FakeNode[] = [];
let expressionAt: (range: Range) => ExpressionAt = () => {
  throw new Error("no expressionAt");
};
let errors: Range[] = [];
let structural: StructuralRanges | null = null;

const posOf = (off: number) => {
  const line = Text.of(text.split("\n")).lineAt(off);
  return { line: line.number - 1, col: off - line.from };
};
const offOf = (p: { line: number; col: number }) => Text.of(text.split("\n")).line(p.line + 1).from + p.col;
const rangeOf = (from: number, to: number): Range => ({ start: posOf(from), end: posOf(to) });

function toSyntax(n: FakeNode): SyntaxNode {
  return {
    kind: n.kind,
    range: rangeOf(n.from, n.to),
    field: n.field,
    named: true,
    error: !!n.error,
    missing: false,
    hasError: !!n.error,
  };
}

/**
 * Nodes outer → inner: `[kind, needle, nth?, field?]`; `needle` locates the
 * node's text (nth occurrence, default 0). Parents are the innermost earlier
 * node containing it.
 */
function tree(specs: Array<[string, string, number?, string?]>) {
  nodes = [];
  for (const [kind, needle, nth = 0, field = null] of specs) {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`no ${needle}`);
    const node: FakeNode = { kind, from: at, to: at + needle.length, field, parent: null };
    node.parent = [...nodes].reverse().find((n) => n.from <= node.from && n.to >= node.to) ?? null;
    nodes.push(node);
  }
}

const find = (kind: string, nth = 0) => nodes.filter((n) => n.kind === kind)[nth]!;
const syn = (kind: string, nth = 0) => toSyntax(find(kind, nth));

function nodeAt(range: Range): NodeAt | null {
  const from = offOf(range.start);
  const to = offOf(range.end);
  let best: FakeNode | null = null;
  for (const n of nodes) if (n.from <= from && n.to >= to && (!best || n.to - n.from <= best.to - best.from)) best = n;
  if (!best) return null;
  const ancestors: SyntaxNode[] = [];
  for (let p = best.parent; p; p = p.parent) ancestors.push(toSyntax(p));
  return { node: toSyntax(best), ancestors };
}

const structureMock = {
  support: vi.fn(async () => ({ tree: true, locals: false })),
  expressionAt: vi.fn(async (_doc: number, range: Range) => expressionAt(range)),
  syntaxErrors: vi.fn(async () => ({
    errors: errors.map((range) => ({ kind: "missing", range, expected: ";", message: "missing `;`" })),
    truncated: false,
  })),
  nodeAt: vi.fn(async (_doc: number, range: Range) => nodeAt(range)),
  identifiers: vi.fn(async (_doc: number, name: string) =>
    [...text.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))].map((m) => ({
      range: rangeOf(m.index!, m.index! + name.length),
      kind: "identifier",
      qualified: text[m.index! - 1] === ".",
    })),
  ),
  locals: vi.fn(async () => ({ status: "noIdentifier" as const })),
  structuralRanges: vi.fn(async () => structural!),
};

vi.mock("@/editor/structure", () => ({ structure: structureMock }));

const files: Record<string, string> = {};
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      fsReadText: async (path: string) =>
        path in files
          ? { status: "ok", data: files[path] }
          : { status: "error", error: { kind: "notFound", message: path } },
      lspHover: async () => ({ status: "error", error: { kind: "unavailable", message: "no server" } }),
    },
  };
});
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/p" } }) } }));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { introduceFallback } = await import("./introduce");
const { useLspPopup } = await import("@/editor/lsp/popupStore");
const { lspDoc } = await import("@/editor/lsp/lsp");
const { clearLevelCache } = await import("./projectLevel");

// --- editor ---------------------------------------------------------------------

let view: EditorView | null = null;

function editor(doc: string, language: string, path: string, sel: { anchor: number; head?: number }) {
  text = doc;
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: sel,
      extensions: [history(), lspDoc.of({ doc: 1, path, language, uiMode: null, readOnly: false })],
    }),
  });
  return view;
}

const popup = () => useLspPopup.getState().popup;

async function pick(id: string) {
  const p = popup();
  if (p?.kind !== "list") throw new Error(`no list popup: ${JSON.stringify(p)}`);
  useLspPopup.setState({ popup: null });
  await p.items.find((i) => i.id === id)!.run();
  await new Promise((r) => setTimeout(r, 0));
}

function submitName(name: string) {
  const p = popup();
  if (p?.kind !== "rename") throw new Error("no name popup");
  useLspPopup.setState({ popup: null });
  p.onSubmit(name);
}

beforeEach(() => {
  errors = [];
  structural = null;
  clearLevelCache();
  for (const k of Object.keys(files)) delete files[k];
});

afterEach(() => {
  view?.destroy();
  view = null;
  useLspPopup.setState({ popup: null });
  showHint.mockClear();
});

describe("Introduce Variable fallback", () => {
  const javaSrc = 'class A {\n  void f() {\n    new String("123")\n    g();\n  }\n}\n';

  function javaTree() {
    tree([
      ["program", javaSrc],
      ["class_declaration", javaSrc.trimEnd()],
      ["class_body", '{\n  void f() {\n    new String("123")\n    g();\n  }\n}', 0, "body"],
      ["method_declaration", 'void f() {\n    new String("123")\n    g();\n  }'],
      ["block", '{\n    new String("123")\n    g();\n  }', 0, "body"],
      ["expression_statement", 'new String("123")'],
      ["object_creation_expression", 'new String("123")'],
      ["string_literal", '"123"'],
    ]);
    const e = syn("object_creation_expression");
    expressionAt = () => ({
      expression: e,
      exact: true,
      candidates: [e],
      statement: syn("expression_statement"),
      block: syn("block"),
      functionBoundary: null,
      hasError: true,
    });
  }

  it("replaces a bare expression statement with the declaration (Java 10+: var) as one undo step", async () => {
    files["/p/pom.xml"] = "<properties><maven.compiler.release>17</maven.compiler.release></properties>";
    const from = javaSrc.indexOf("new String");
    const v = editor(javaSrc, "java", "/p/src/A.java", { anchor: from, head: from + 'new String("123")'.length });
    javaTree();
    expect(await introduceFallback(v, "variable", "notReady")).toBe(true);
    expect(v.state.doc.toString()).toBe(
      'class A {\n  void f() {\n    var string = new String("123");\n    g();\n  }\n}\n',
    );
    const p = popup();
    expect(p).toMatchObject({ kind: "rename", initial: "string", note: "Based on syntax (language server not ready)" });
    submitName("text");
    expect(v.state.doc.toString()).toContain('    var text = new String("123");\n');
    undo(v);
    expect(v.state.doc.toString()).toBe(javaSrc);
  });

  it("uses the constructed type below Java 10 and refuses when the type is unknown", async () => {
    files["/p/pom.xml"] = "<properties><maven.compiler.source>1.8</maven.compiler.source></properties>";
    const from = javaSrc.indexOf("new String");
    const v = editor(javaSrc, "java", "/p/src/A.java", { anchor: from, head: from + 'new String("123")'.length });
    javaTree();
    await introduceFallback(v, "variable", "notReady");
    expect(v.state.doc.toString()).toContain('    String string = new String("123");\n');

    const src = "class A {\n  void f() {\n    g(h());\n  }\n}\n";
    view!.destroy();
    const at = src.indexOf("h()");
    const w = editor(src, "java", "/p/src/A.java", { anchor: at, head: at + 3 });
    tree([
      ["program", src],
      ["block", "{\n    g(h());\n  }"],
      ["expression_statement", "g(h());"],
      ["method_invocation", "g(h())"],
      ["method_invocation", "h()"],
    ]);
    const e = syn("method_invocation", 1);
    expressionAt = () => ({
      expression: e,
      exact: true,
      candidates: [e],
      statement: syn("expression_statement"),
      block: syn("block"),
      functionBoundary: null,
      hasError: false,
    });
    expect(await introduceFallback(w, "variable", "notReady")).toBe(true);
    expect(w.state.doc.toString()).toBe(src);
    expect(showHint.mock.calls.at(-1)?.[1]).toMatch(/type of the expression is unknown/);
  });

  const tsSrc = "function f(o) {\n  const a = o.getUser().name;\n  log(o.getUser());\n}\n";

  function tsTree() {
    tree([
      ["program", tsSrc],
      ["function_declaration", tsSrc.trimEnd()],
      ["statement_block", "{\n  const a = o.getUser().name;\n  log(o.getUser());\n}", 0, "body"],
      ["lexical_declaration", "const a = o.getUser().name;"],
      ["member_expression", "o.getUser().name", 0, "value"],
      ["call_expression", "o.getUser()", 0, "object"],
      ["expression_statement", "log(o.getUser());"],
      ["call_expression", "log(o.getUser())"],
      ["arguments", "(o.getUser())", 0, "arguments"],
      ["call_expression", "o.getUser()", 1],
    ]);
    const call = syn("call_expression", 0);
    expressionAt = () => ({
      expression: call,
      exact: false,
      candidates: [call, syn("member_expression")],
      statement: syn("lexical_declaration"),
      block: syn("statement_block"),
      functionBoundary: null,
      hasError: false,
    });
  }

  it("offers expressions at the caret, then all occurrences, and names after the callee", async () => {
    const v = editor(tsSrc, "typescript", "/p/a.ts", { anchor: tsSrc.indexOf("getUser") + 2 });
    tsTree();
    expect(await introduceFallback(v, "variable", "notReady")).toBe(true);
    const chooser = popup();
    expect(chooser).toMatchObject({ kind: "list", title: "Expressions" });
    expect(chooser?.kind === "list" && chooser.items.map((i) => i.label)).toEqual(["o.getUser()", "o.getUser().name"]);
    await pick("0");
    expect(popup()).toMatchObject({ kind: "list", title: "Multiple occurrences found" });
    expect(
      popup()?.kind === "list" &&
        popup()!.kind === "list" &&
        (popup() as { items: { label: string }[] }).items.map((i) => i.label),
    ).toEqual(["Replace this occurrence only", "Replace all 2 occurrences"]);
    await pick("all");
    expect(v.state.doc.toString()).toBe(
      "function f(o) {\n  const user = o.getUser();\n  const a = user.name;\n  log(user);\n}\n",
    );
    expect(popup()).toMatchObject({ kind: "rename", initial: "user", suggestions: ["user", "value"] });
    // Escape keeps the default name.
    useLspPopup.setState({ popup: null });
    undo(v);
    expect(v.state.doc.toString()).toBe(tsSrc);
  });

  it("replaces only the selected occurrence on request", async () => {
    const v = editor(tsSrc, "typescript", "/p/a.ts", { anchor: tsSrc.indexOf("getUser") + 2 });
    tsTree();
    await introduceFallback(v, "variable", "notReady");
    await pick("0");
    await pick("one");
    expect(v.state.doc.toString()).toBe(
      "function f(o) {\n  const user = o.getUser();\n  const a = user.name;\n  log(o.getUser());\n}\n",
    );
  });

  it("respects an empty server answer unless the code there is broken", async () => {
    const at = tsSrc.indexOf("o.getUser()");
    const v = editor(tsSrc, "typescript", "/p/a.ts", { anchor: at, head: at + "o.getUser()".length });
    tsTree();
    const call = syn("call_expression", 0);
    expressionAt = () => ({
      expression: call,
      exact: true,
      candidates: [call],
      statement: syn("lexical_declaration"),
      block: syn("statement_block"),
      functionBoundary: null,
      hasError: false,
    });
    expect(await introduceFallback(v, "variable", "empty")).toBe(false);
    expect(v.state.doc.toString()).toBe(tsSrc);
    errors = [rangeOf(at + 5, at + 5)];
    expect(await introduceFallback(v, "variable", "empty")).toBe(true);
    await pick("one");
    expect(v.state.doc.toString()).toContain("const user = o.getUser();");
    expect(popup()).toMatchObject({ note: "Based on syntax (the code has errors)" });
  });

  it("refuses selections that are not an expression, lambda bodies and loop conditions", async () => {
    const src = "function f(xs) {\n  const ys = xs.map((x) => x * 2);\n  while (next(xs)) {}\n}\n";
    const v = editor(src, "typescript", "/p/a.ts", { anchor: src.indexOf("x * 2"), head: src.indexOf("x * 2") + 3 });
    tree([
      ["program", src],
      ["statement_block", src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1)],
      ["lexical_declaration", "const ys = xs.map((x) => x * 2);"],
      ["arrow_function", "(x) => x * 2"],
      ["binary_expression", "x * 2", 0, "body"],
      ["while_statement", "while (next(xs)) {}"],
      ["parenthesized_expression", "(next(xs))", 0, "condition"],
      ["call_expression", "next(xs)"],
    ]);
    expressionAt = () => ({
      expression: syn("binary_expression"),
      exact: false,
      candidates: [],
      statement: syn("lexical_declaration"),
      block: syn("statement_block"),
      functionBoundary: null,
      hasError: false,
    });
    await introduceFallback(v, "variable", "notReady");
    expect(showHint.mock.calls.at(-1)?.[1]).toBe(
      "Cannot perform refactoring: selected block should represent an expression",
    );

    const bin = syn("binary_expression");
    expressionAt = () => ({
      expression: bin,
      exact: true,
      candidates: [bin],
      statement: syn("lexical_declaration"),
      block: syn("statement_block"),
      functionBoundary: syn("arrow_function"),
      hasError: false,
    });
    await introduceFallback(v, "variable", "notReady");
    expect(showHint.mock.calls.at(-1)?.[1]).toMatch(/lambda with an expression body/);

    const call = syn("call_expression");
    expressionAt = () => ({
      expression: call,
      exact: true,
      candidates: [call],
      statement: syn("while_statement"),
      block: syn("statement_block"),
      functionBoundary: null,
      hasError: false,
    });
    await introduceFallback(v, "variable", "notReady");
    expect(showHint.mock.calls.at(-1)?.[1]).toMatch(/evaluated conditionally or repeatedly/);
    expect(v.state.doc.toString()).toBe(src);
  });

  it("matches occurrences through same-range wrappers and drops callee candidates (Kotlin)", async () => {
    const src = "fun f(o: O) {\n    val t = o.total() + 1\n    println(o.total())\n}\n";
    const v = editor(src, "kotlin", "/p/a.kt", { anchor: src.indexOf("total") + 1 });
    tree([
      ["source_file", src],
      ["block", src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1)],
      ["property_declaration", "val t = o.total() + 1"],
      ["binary_expression", "o.total() + 1"],
      ["call_expression", "o.total()"],
      ["navigation_expression", "o.total"],
      ["call_expression", "println(o.total())"],
      ["value_arguments", "(o.total())"],
      ["value_argument", "o.total()", 1],
      ["call_expression", "o.total()", 1],
    ]);
    const nav = syn("navigation_expression");
    const call = syn("call_expression");
    expressionAt = () => ({
      expression: nav,
      exact: false,
      candidates: [nav, call, syn("binary_expression")],
      statement: syn("property_declaration"),
      block: syn("block"),
      functionBoundary: null,
      hasError: false,
    });
    await introduceFallback(v, "variable", "notReady");
    const chooser = popup();
    expect(chooser?.kind === "list" && chooser.items.map((i) => i.label)).toEqual(["o.total()", "o.total() + 1"]);
    await pick("0");
    await pick("all");
    expect(v.state.doc.toString()).toBe(
      "fun f(o: O) {\n    val total = o.total()\n    val t = total + 1\n    println(total)\n}\n",
    );
  });

  it("replaces a bare statement whose missing `;` let the parser swallow the next line", async () => {
    files["/p/pom.xml"] = "<properties><java.version>21</java.version></properties>";
    const src = 'class A {\n  void f() {\n    new String("1")\n    System.out.println();\n  }\n}\n';
    const at = src.indexOf("new String");
    const v = editor(src, "java", "/p/A.java", { anchor: at, head: at + 'new String("1")'.length });
    tree([
      ["program", src],
      ["block", src.slice(src.indexOf("{\n    new"), src.lastIndexOf("}\n}") + 1)],
      ["expression_statement", 'new String("1")\n    System'],
      ["object_creation_expression", 'new String("1")'],
    ]);
    const e = syn("object_creation_expression");
    const stmt = { ...syn("expression_statement"), hasError: true };
    expressionAt = () => ({
      expression: e,
      exact: true,
      candidates: [e],
      statement: stmt,
      block: syn("block"),
      functionBoundary: null,
      hasError: true,
    });
    await introduceFallback(v, "variable", "empty");
    expect(v.state.doc.toString()).toBe(
      'class A {\n  void f() {\n    var string = new String("1");\n    System.out.println();\n  }\n}\n',
    );
  });

  it("inserts before a statement that does not start its line", async () => {
    const src = "def f(c, x):\n    if c: g(x + 1)\n";
    const at = src.indexOf("x + 1");
    const v = editor(src, "python", "/p/a.py", { anchor: at, head: at + 5 });
    tree([
      ["module", src],
      ["if_statement", "if c: g(x + 1)"],
      ["block", "g(x + 1)", 0, "consequence"],
      ["expression_statement", "g(x + 1)"],
      ["call", "g(x + 1)"],
      ["binary_operator", "x + 1"],
    ]);
    const e = syn("binary_operator");
    expressionAt = () => ({
      expression: e,
      exact: true,
      candidates: [e],
      statement: syn("expression_statement"),
      block: syn("block"),
      functionBoundary: null,
      hasError: false,
    });
    await introduceFallback(v, "variable", "notReady");
    expect(v.state.doc.toString()).toBe("def f(c, x):\n    if c: value = x + 1; g(value)\n");
  });
});

describe("Introduce Constant fallback", () => {
  it("adds a typed Java constant before the member, after its comments", async () => {
    const src = "class A {\n  // doc\n  void f() { h(42); k(42); }\n}\n";
    const at = src.indexOf("42");
    const v = editor(src, "java", "/p/A.java", { anchor: at, head: at + 2 });
    tree([
      ["program", src],
      ["class_declaration", src.trimEnd()],
      ["class_body", src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1), 0, "body"],
      ["method_declaration", "void f() { h(42); k(42); }"],
      ["block", "{ h(42); k(42); }", 0, "body"],
      ["expression_statement", "h(42);"],
      ["method_invocation", "h(42)"],
      ["decimal_integer_literal", "42"],
      ["expression_statement", "k(42);"],
      ["method_invocation", "k(42)"],
      ["decimal_integer_literal", "42", 1],
    ]);
    const lit = syn("decimal_integer_literal");
    expressionAt = () => ({
      expression: lit,
      exact: true,
      candidates: [lit],
      statement: syn("expression_statement"),
      block: syn("block"),
      functionBoundary: null,
      hasError: false,
    });
    structural = {
      selection: [],
      statement: null,
      prevStatement: null,
      nextStatement: null,
      block: null,
      declaration: syn("method_declaration"),
      prevDeclaration: null,
      nextDeclaration: null,
    };
    await introduceFallback(v, "constant", "error");
    await pick("all");
    expect(v.state.doc.toString()).toBe(
      "class A {\n  private static final int I = 42;\n\n  // doc\n  void f() { h(I); k(I); }\n}\n",
    );
    expect(popup()).toMatchObject({ kind: "rename", initial: "I", note: "Based on syntax (language server failed)" });
    submitName("ANSWER");
    expect(v.state.doc.toString()).toContain("private static final int ANSWER = 42;");
    expect(v.state.doc.toString()).toContain("h(ANSWER); k(ANSWER);");
  });

  it("adds a module-level Python constant and refuses non-literals", async () => {
    const src = 'import os\n\ndef f():\n    return g("max retries")\n';
    const at = src.indexOf('"max');
    const v = editor(src, "python", "/p/a.py", { anchor: at, head: at + '"max retries"'.length });
    tree([
      ["module", src],
      ["import_statement", "import os"],
      ["function_definition", src.slice(src.indexOf("def"))],
      ["block", 'return g("max retries")', 0, "body"],
      ["return_statement", 'return g("max retries")'],
      ["call", 'g("max retries")'],
      ["string", '"max retries"'],
    ]);
    const lit = syn("string");
    expressionAt = () => ({
      expression: lit,
      exact: true,
      candidates: [lit],
      statement: syn("return_statement"),
      block: syn("block"),
      functionBoundary: null,
      hasError: false,
    });
    await introduceFallback(v, "constant", "notReady");
    expect(v.state.doc.toString()).toBe(
      'import os\n\nMAX_RETRIES = "max retries"\n\ndef f():\n    return g(MAX_RETRIES)\n',
    );

    const call = syn("call");
    expressionAt = () => ({
      expression: call,
      exact: true,
      candidates: [call],
      statement: syn("return_statement"),
      block: syn("block"),
      functionBoundary: null,
      hasError: false,
    });
    view!.dispatch({
      changes: { from: 0, to: view!.state.doc.length, insert: src },
      selection: { anchor: src.indexOf("g("), head: src.indexOf("g(") + 'g("max retries")'.length },
    });
    await introduceFallback(view!, "constant", "notReady");
    expect(showHint.mock.calls.at(-1)?.[1]).toMatch(/only literal values/);
  });
});
