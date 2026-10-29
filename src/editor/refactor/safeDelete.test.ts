import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { MessageRequest } from "@/workbench/messages";
import type { LocalSymbol, Location, Locals, OutlineItem, Range, StructuralRanges, SyntaxNode } from "@/bindings";

// --- backend fakes ---------------------------------------------------------

type Answer<T> = () => { status: "ok"; data: T } | { status: "error"; error: { kind: string; message: string } };
const ok =
  <T>(data: T) =>
  () => ({ status: "ok" as const, data });
const unavailable = () => ({ status: "error" as const, error: { kind: "unavailable", message: "no server" } });

let goto: Answer<Location[]> = ok([]);
let outline: Answer<OutlineItem[]> = ok([]);
let references: Answer<Location[]> = ok([]);
const lspGoto = vi.fn(async () => goto());
const docOutline = vi.fn(async () => outline());
const lspReferences = vi.fn(async () => {
  const r = references();
  return r.status === "ok" ? { status: "ok" as const, data: { locations: r.data, incomplete: null } } : r;
});
const lspCodeActions = vi.fn(async () => ({ status: "ok", data: [] }));
const lspApplyCodeAction = vi.fn(async () => ({ status: "ok", data: null }));
const docOpen = vi.fn(async (path: string) => ({ status: "ok", data: { id: 99, path } }));
const docClose = vi.fn(async () => ({ status: "ok", data: null }));
const languages = vi.fn(async () => [
  { id: "rust", name: "Rust", lineComment: "//", blockComment: ["/*", "*/"] },
  { id: "python", name: "Python", lineComment: "#", blockComment: null },
]);

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      lspGoto,
      docOutline,
      lspReferences,
      lspCodeActions,
      lspApplyCodeAction,
      docOpen,
      docClose,
      languages,
    },
  };
});

let locals: Locals = { status: "noIdentifier" };
let statement: SyntaxNode | null = null;
let identifiers: { range: Range; qualified: boolean }[] = [];
vi.mock("@/editor/structure", () => ({
  structure: {
    locals: vi.fn(async () => locals),
    structuralRanges: vi.fn(async (): Promise<Partial<StructuralRanges>> => ({ statement })),
    identifiers: vi.fn(async () => identifiers),
  },
}));
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));
const executeAction = vi.fn();
vi.mock("@/platform/actions", () => ({ executeAction }));
let answer = "cancel";
const ask = vi.fn(async (_request: MessageRequest) => ({ button: answer, checked: false }));
let confirmAnswer: { checked: boolean } | null = { checked: false };
const confirmChecked = vi.fn(
  async (_opts: { title: string; message: string; checkbox?: string; checked?: boolean }) => confirmAnswer,
);
vi.mock("@/workbench/messages", () => ({ ask, confirmChecked }));

const { deletionRange, localDeclaration, outlineItemAt, safeDelete, fileUsages, usagesMessage, textOccurrences } =
  await import("./safeDelete");
const { closePopup, useLspPopup } = await import("@/editor/lsp/popupStore");
const { lspDoc } = await import("@/editor/lsp/lsp");

// --- helpers ----------------------------------------------------------------

const doc = (s: string) => Text.of(s.split("\n"));
const posOf = (text: string, off: number) => {
  const line = doc(text).lineAt(off);
  return { line: line.number - 1, col: off - line.from };
};
const rangeOf = (text: string, from: number, to: number): Range => ({ start: posOf(text, from), end: posOf(text, to) });
/** Removes `deletionRange` of the `needle` span from `text`. */
function cut(text: string, needle: string, comments?: { line: string | null; block: [string, string] | null }) {
  const from = text.indexOf(needle);
  const r = deletionRange(doc(text), from, from + needle.length, comments);
  return r && text.slice(0, r.from) + text.slice(r.to);
}

let view: EditorView | null = null;
function editor(text: string, caretNeedle: string, language = "rust") {
  view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.indexOf(caretNeedle) + 1 },
      extensions: [history(), lspDoc.of({ doc: 1, path: "/p/a.rs", language, uiMode: null, readOnly: false })],
    }),
  });
  return view;
}

function item(text: string, name: string, decl: string, kind: OutlineItem["kind"] = "function"): OutlineItem {
  const from = text.indexOf(decl);
  const at = text.indexOf(name, from);
  return {
    name,
    detail: null,
    kind,
    range: rangeOf(text, from, from + decl.length),
    selection_range: rangeOf(text, at, at + name.length),
    children: [],
  };
}

beforeEach(() => {
  goto = ok([]);
  outline = ok([]);
  references = ok([]);
  locals = { status: "noIdentifier" };
  statement = null;
  identifiers = [];
  confirmAnswer = { checked: false };
});

afterEach(() => {
  view?.destroy();
  view = null;
  closePopup();
  vi.clearAllMocks();
});

// --- tests --------------------------------------------------------------------

describe("deletionRange", () => {
  it("removes whole lines plus the trailing blank line", () => {
    expect(cut("fn a() {}\n\nfn unused() {}\n\nfn b() {}\n", "fn unused() {}")).toBe("fn a() {}\n\nfn b() {}\n");
  });

  it("takes the doc comment and annotations directly above", () => {
    const text = "fn a() {}\n\n/**\n * Docs.\n */\n#[inline]\nfn unused() {}\n\nfn b() {}\n";
    expect(cut(text, "fn unused() {}")).toBe("fn a() {}\n\nfn b() {}\n");
    const java = "class A {\n  // keep\n\n  /// doc\n  @Deprecated\n  void unused() {}\n\n  void b() {}\n}\n";
    expect(cut(java, "void unused() {}")).toBe("class A {\n  // keep\n\n  void b() {}\n}\n");
  });

  it("takes the blank line above when the declaration ends its block", () => {
    expect(cut("fn f() {\n    a();\n\n    let x = 1;\n}\n", "let x = 1;")).toBe("fn f() {\n    a();\n}\n");
  });

  it("handles the last line of the document", () => {
    expect(cut("fn a() {}\n\nfn unused() {}", "fn unused() {}")).toBe("fn a() {}");
    expect(cut("fn a() {}\nfn unused() {}", "fn unused() {}")).toBe("fn a() {}");
  });

  it("uses the language's comment syntax (Python comments and decorators)", () => {
    const py = "import x\n\n# helper\n@cache\ndef unused():\n    pass\n\ndef b():\n    pass\n";
    expect(cut(py, "def unused():\n    pass", { line: "#", block: null })).toBe("import x\n\ndef b():\n    pass\n");
  });

  it("accepts a trailing separator or comment but refuses shared lines", () => {
    expect(cut("let a = 1;\nlet b = 2; // note\nlet c = 3;\n", "let b = 2")).toBe("let a = 1;\nlet c = 3;\n");
    expect(cut("struct S {\n    a: i32,\n    b: i32,\n}\n", "a: i32")).toBe("struct S {\n    b: i32,\n}\n");
    expect(cut("let a = 1; let b = 2;\n", "let b = 2;")).toBeNull();
    expect(cut("f(a, b);\n", "a")).toBeNull();
  });
});

describe("outlineItemAt", () => {
  it("finds the innermost item whose name contains the position", () => {
    const text = "impl S {\n    fn m() {}\n}\n";
    const m = item(text, "m", "fn m() {}", "method");
    const s = { ...item(text, "S", "impl S {\n    fn m() {}\n}", "struct"), children: [m] };
    expect(outlineItemAt([s], posOf(text, text.indexOf("m()")))).toBe(m);
    expect(outlineItemAt([s], posOf(text, text.indexOf("S")))).toBe(s);
    expect(outlineItemAt([s], posOf(text, text.indexOf("{}")))).toBeNull();
  });
});

describe("localDeclaration", () => {
  const text =
    "fn f(p: i32) {\n    let x = 1;\n    let (a, b) = t;\n    let m: HashMap<K, V> = m();\n    for i in v {}\n}\n";
  const sym = (name: string, kind: LocalSymbol["kind"] = "var", after = "{"): LocalSymbol => {
    const at = text.indexOf(` ${name}`, text.indexOf(after)) + 1;
    return {
      name,
      kind,
      definition: rangeOf(text, at, at + name.length),
      scope: rangeOf(text, 0, text.length),
      references: [],
      certain: true,
      conflicts: [],
    };
  };
  const stmt = (kind: string, needle: string): SyntaxNode => {
    const at = text.indexOf(needle);
    return {
      kind,
      range: rangeOf(text, at, at + needle.length),
      field: null,
      named: true,
      error: false,
      missing: false,
      hasError: false,
    };
  };

  it("returns the declaring statement of a single local", () => {
    expect(localDeclaration(doc(text), sym("x"), stmt("let_declaration", "let x = 1;"))).toEqual(
      stmt("let_declaration", "let x = 1;").range,
    );
    expect(
      localDeclaration(doc(text), sym("m"), stmt("let_declaration", "let m: HashMap<K, V> = m();")),
    ).not.toBeTypeOf("string");
  });

  it("refuses parameters, destructuring, loop variables and ambiguous locals", () => {
    expect(localDeclaration(doc(text), sym("p", "parameter", "f"), null)).toMatch(/Change Signature/);
    expect(localDeclaration(doc(text), sym("b"), stmt("let_declaration", "let (a, b) = t;"))).toMatch(/other names/);
    expect(localDeclaration(doc(text), sym("i"), stmt("for_expression", "for i in v {}"))).toMatch(
      /separate statement/,
    );
    expect(localDeclaration(doc(text), { ...sym("x"), certain: false }, stmt("let_declaration", "let x = 1;"))).toMatch(
      /more than once/,
    );
  });
});

describe("textOccurrences", () => {
  it("checks Unicode identifier boundaries without shifting UTF-16 offsets", () => {
    const text = "𐐀foo αfoo $foo _foo foo 𐐀 foo foo𐐀";
    const hits = textOccurrences(text, "foo", [], { from: -1, to: -1 });
    expect(hits).toEqual([21, 28].map((from) => ({ from, to: from + 3 })));
  });

  it("finds whole-word mentions that are not identifier tokens, outside the declaration", () => {
    const text = 'foo(); // foo and food\nlet s = "foo";\nfn foo() {}';
    const ids = [0, text.lastIndexOf("foo")].map((from) => ({ from, to: from + 3 }));
    const decl = text.indexOf("fn foo");
    const hits = textOccurrences(text, "foo", ids, { from: decl, to: text.length });
    expect(hits.map((h) => text.slice(h.from - 3, h.to))).toEqual(["// foo", '= "foo']);
  });
});

describe("usagesMessage", () => {
  it("says how many usages and where", () => {
    const loc = (path: string): Location => ({ path, range: rangeOf("x", 0, 1) });
    expect(usagesMessage("Function 'f'", [loc("/a")])).toEqual({
      message: "1 usage found",
      detail: "Function 'f' has 1 usage that is not safe to delete.",
    });
    expect(usagesMessage("The 2 files", [loc("/a"), loc("/b")], true).detail).toBe(
      "The 2 files have 2 usages that are not safe to delete (in 2 files).",
    );
  });
});

describe("safeDelete in the editor", () => {
  const text = "fn used() {}\n\nfn unused() {\n    unused();\n}\n\nfn main() {}\n";

  it("deletes an unused declaration as one undo step, ignoring recursive calls", async () => {
    const v = editor(text, "unused() {");
    outline = ok([item(text, "used", "fn used() {}"), item(text, "unused", "fn unused() {\n    unused();\n}")]);
    const self = text.indexOf("unused();");
    references = ok([{ path: "/p/a.rs", range: rangeOf(text, self, self + 6) }]);
    await safeDelete(v);
    expect(v.state.doc.toString()).toBe("fn used() {}\n\nfn main() {}\n");
    expect(lspCodeActions).not.toHaveBeenCalled();
    expect(lspApplyCodeAction).not.toHaveBeenCalled();
    undo(v);
    expect(v.state.doc.toString()).toBe(text);
  });

  it("asks when usages exist: View Usages / Delete Anyway / Cancel", async () => {
    const usage: Location = { path: "/p/b.rs", range: { start: { line: 3, col: 4 }, end: { line: 3, col: 8 } } };
    outline = ok([item(text, "used", "fn used() {}")]);
    references = ok([usage]);

    const run = async (button: string) => {
      const v = editor(text, "used() {}");
      answer = button;
      ask.mockClear();
      await safeDelete(v);
      const request = ask.mock.calls[0]![0];
      expect(request.title).toBe("Usages Detected");
      expect(request.body).toBe("1 usage found\nFunction 'used' has 1 usage that is not safe to delete.");
      expect(request.buttons.map((b) => b.label)).toEqual(["View Usages", "Delete Anyway"]);
      return v;
    };

    expect((await run("cancel")).state.doc.toString()).toBe(text);
    expect(executeAction).not.toHaveBeenCalled();
    expect((await run("view")).state.doc.toString()).toBe(text);
    expect(executeAction).toHaveBeenCalledWith("find.showUsageResults", { symbol: "used", locations: [usage] });
    expect((await run("delete")).state.doc.toString()).toBe("fn unused() {\n    unused();\n}\n\nfn main() {}\n");
  });

  it("confirms first ('Delete Function …?') and searches nothing when cancelled", async () => {
    const v = editor(text, "unused() {");
    outline = ok([item(text, "unused", "fn unused() {\n    unused();\n}")]);
    confirmAnswer = null;
    await safeDelete(v);
    expect(confirmChecked).toHaveBeenCalledTimes(1);
    const opts = confirmChecked.mock.calls[0]![0];
    expect(opts.title).toBe("Safe Delete");
    expect(opts.message).toBe("Delete Function 'unused'?");
    expect(opts.checkbox).toBe("Search in comments and strings");
    expect(lspReferences).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe(text);
  });

  it("with 'Search in comments and strings' previews mentions before deleting", async () => {
    const src = "// calls unused\nfn unused() {}\n\nfn main() {}\n";
    const v = editor(src, "unused() {");
    outline = ok([item(src, "unused", "fn unused() {}")]);
    const decl = src.indexOf("unused() {");
    identifiers = [{ range: rangeOf(src, decl, decl + 6), qualified: false }];
    confirmAnswer = { checked: true };
    await safeDelete(v);
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("preview");
    if (popup?.kind !== "preview") return;
    expect(popup.occurrences).toEqual([{ line: 0, text: "// calls unused", from: 9, to: 15 }]);
    expect(v.state.doc.toString()).toBe(src);
    popup.onConfirm();
    expect(v.state.doc.toString()).not.toContain("fn unused");
  });

  it("refuses a declaration in another file instead of doing something else", async () => {
    const v = editor(text, "main");
    goto = ok([{ path: "/p/other.rs", range: rangeOf(text, 0, 1) }]);
    await safeDelete(v);
    expect(showHint).toHaveBeenCalledWith(
      v,
      "Cannot perform refactoring. 'main' is declared in other.rs; Safe Delete it there",
    );
    expect(v.state.doc.toString()).toBe(text);
  });

  it("without a language server deletes only locals, using the syntax references", async () => {
    const body = "fn f() {\n    let x = 1;\n    let y = 2;\n    g(y);\n}\n";
    goto = unavailable;
    references = unavailable;
    const x = body.indexOf("x");
    locals = {
      status: "local",
      symbol: {
        name: "x",
        kind: "var",
        definition: rangeOf(body, x, x + 1),
        scope: rangeOf(body, 0, body.length),
        references: [],
        certain: true,
        conflicts: [],
      },
    };
    const at = body.indexOf("let x");
    statement = {
      kind: "let_declaration",
      range: rangeOf(body, at, at + 10),
      field: null,
      named: true,
      error: false,
      missing: false,
      hasError: false,
    };
    const v = editor(body, " x =");
    v.dispatch({ selection: { anchor: x } });
    await safeDelete(v);
    expect(v.state.doc.toString()).toBe("fn f() {\n    let y = 2;\n    g(y);\n}\n");
    expect(lspReferences).not.toHaveBeenCalled();
  });

  it("without a language server refuses top-level declarations with the reason", async () => {
    goto = unavailable;
    outline = ok([item(text, "used", "fn used() {}")]);
    locals = { status: "notLocal", name: "used", range: rangeOf(text, 3, 7), reason: "topLevel" };
    const v = editor(text, "used() {}");
    await safeDelete(v);
    expect(showHint).toHaveBeenCalledWith(
      v,
      "Cannot perform refactoring. The language server for Rust is not available; only local declarations can be deleted safely without it",
    );
    expect(v.state.doc.toString()).toBe(text);
  });

  it("needs a symbol at the caret", async () => {
    const v = editor("fn a() {}\n\n\n", "\n\n");
    v.dispatch({ selection: { anchor: 11 } });
    await safeDelete(v);
    expect(showHint).toHaveBeenCalledWith(v, "Cannot perform refactoring. Caret should be on a symbol");
  });
});

describe("fileUsages", () => {
  const text = "pub fn a() {}\npub struct B;\n";

  it("collects references to top-level symbols from other files", async () => {
    outline = ok([item(text, "a", "pub fn a() {}"), item(text, "B", "pub struct B;", "struct")]);
    const r = (path: string, line: number): Location => ({
      path,
      range: { start: { line, col: 0 }, end: { line, col: 1 } },
    });
    references = ok([r("/p/a.rs", 0), r("/p/main.rs", 4), r("/p/main.rs", 4), r("/p/gone.rs", 1)]);
    const res = await fileUsages(["/p/a.rs", "/p/gone.rs"]);
    expect(res).toEqual({ status: "ok", usages: [r("/p/main.rs", 4)] });
    expect(docClose).toHaveBeenCalledTimes(2);
  });

  it("is unsupported when the language server can't search", async () => {
    outline = ok([item(text, "a", "pub fn a() {}")]);
    references = unavailable;
    expect((await fileUsages(["/p/a.rs"])).status).toBe("unsupported");
  });

  it("is cancellable", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(fileUsages(["/p/a.rs"], abort.signal)).rejects.toMatchObject({ kind: "cancelled" });
  });
});
