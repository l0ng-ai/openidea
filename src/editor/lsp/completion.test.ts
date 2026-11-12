import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { CompletionItem } from "@/bindings";
import type { EditorDocContext } from "@/editor/api";
import { lspDoc } from "./lsp";
import {
  completionSymbolKind,
  identifierEnd,
  toCmCompletion,
  triggerCharacter,
  typeColumnText,
  withoutDuplicates,
} from "./completionItems";
import {
  applyLspCompletion,
  callParens,
  offersPaths,
  commitsLookup,
  completionExtension,
  explicitCompletion,
  makeCompletion,
  matchRanges,
  sortAlphabetically,
} from "./completion";
import {
  acceptCompletion,
  currentCompletions,
  snippet,
  startCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { useProject } from "@/platform/project";
import type { Settings } from "@/platform/ipc";

function item(over: Partial<CompletionItem> = {}): CompletionItem {
  return {
    label: "create",
    labelDetail: null,
    labelDescription: null,
    detail: null,
    kind: "method",
    documentation: null,
    sortText: null,
    filterText: null,
    preselect: false,
    deprecated: false,
    insertText: "create",
    isSnippet: false,
    replaceRange: null,
    replaceRangeTab: null,
    additionalEdits: [],
    commitCharacters: [],
    command: null,
    data: null,
    server: 1,
    ...over,
  };
}

describe("PHP construct completion documentation", () => {
  const req = { doc: 1, path: "/p/a.php", language: "PHP", pos: 3, text: EditorState.create({ doc: "emp" }).doc };

  it("documents a keyword without changing its insertion", () => {
    const c = makeCompletion(item({ label: "empty", kind: "keyword", insertText: "empty" }), req);
    expect(c.lsp.documentation?.value).toContain("empty(mixed $var): bool");
    expect(c.lsp.insertText).toBe("empty");
  });

  it("preserves server documentation and leaves methods and other languages alone", () => {
    const documentation = { kind: "markdown" as const, value: "Server documentation" };
    expect(makeCompletion(item({ label: "empty", kind: "keyword", documentation }), req).lsp.documentation).toEqual(
      documentation,
    );
    expect(makeCompletion(item({ label: "empty", kind: "method" }), req).lsp.documentation).toBeNull();
    expect(
      makeCompletion(item({ label: "empty", kind: "keyword" }), { ...req, language: "JavaScript" }).lsp.documentation,
    ).toBeNull();
  });
});

describe("toCmCompletion", () => {
  it("maps label, detail, kind and sort text", () => {
    const c = toCmCompletion(
      item({ labelDetail: "(req: CreateOrderRequest)", detail: "Order", sortText: "0001", commitCharacters: ["("] }),
    );
    expect(c).toMatchObject({
      label: "create",
      detail: "(req: CreateOrderRequest)",
      type: "method",
      sortText: "0001",
      commitCharacters: ["("],
    });
    expect(c.displayLabel).toBeUndefined();
    expect(c.boost).toBeUndefined();
  });

  it("filters on filterText while displaying the label", () => {
    const c = toCmCompletion(item({ label: "@GetMapping", filterText: "GetMapping" }));
    expect(c.label).toBe("GetMapping");
    expect(c.displayLabel).toBe("@GetMapping");
  });

  it("filters on the label when filterText only adds the call or body", () => {
    for (const filterText of ["String(${0})", "List<>()", "Runnable() {\n\t${0}\n};"]) {
      const label = filterText.match(/^\w+/)![0];
      const c = toCmCompletion(item({ label, filterText }));
      expect(c.label).toBe(label);
      expect(c.displayLabel).toBeUndefined();
    }
    expect(toCmCompletion(item({ label: "foo", filterText: "foo_bar" })).label).toBe("foo_bar");
  });

  it("lists identical items once", () => {
    const ctor = item({ label: "String()", kind: "constructor", data: "1" });
    const overload = item({ label: "String()", kind: "constructor", labelDetail: "(bytes: ByteArray)" });
    const out = withoutDuplicates([ctor, { ...ctor, data: "2" }, overload, { ...ctor, server: 2 }]);
    expect(out).toEqual([ctor, overload, { ...ctor, server: 2 }]);
  });

  it("boosts preselected and demotes deprecated items", () => {
    expect(toCmCompletion(item({ preselect: true })).boost).toBe(99);
    expect(toCmCompletion(item({ deprecated: true })).boost).toBeLessThan(0);
  });

  it("maps completion kinds to symbol badges", () => {
    expect(completionSymbolKind("function")).toBe("function");
    expect(completionSymbolKind("enumMember")).toBe("constant");
    expect(completionSymbolKind("typeParameter")).toBe("type");
    expect(completionSymbolKind(null)).toBe("text");
  });
});

describe("completion label presentation", () => {
  // gopls v0.24.0: labelDetails.detail includes a leading space for field types; description is absent.
  it.each([
    ["Cap", "field", " int", "int", null, null, "int"],
    ["Array", "field", " []any", "[]any", null, null, "[]any"],
    ["Add", "method", "() error", "func() error", null, "()", "error"],
    [
      "MakeArray",
      "function",
      "(capacity int) *LRUArray",
      "func(capacity int) *LRUArray",
      null,
      "(capacity int)",
      "*LRUArray",
    ],
    ["Format", "method", "(layout string) string", "func(layout string) string", null, "(layout string)", "string"],
    [
      "Lookup",
      "function",
      "(x int) (string, error)",
      "func(x int) (string, error)",
      null,
      "(x int)",
      "(string, error)",
    ],
    ["Identity", "function", "[T any](x T) T", "func[T any](x T) T", null, "[T any](x T)", "T"],
    [
      "Apply",
      "function",
      "[T interface{ ~[]byte | ~[2]byte }](f func(T) (T, error), xs []T) (T, error)",
      "func[T interface{ ~[]byte | ~[2]byte }](f func(T) (T, error), xs []T) (T, error)",
      null,
      "[T interface{ ~[]byte | ~[2]byte }](f func(T) (T, error), xs []T)",
      "(T, error)",
    ],
    ["Run", "function", "()", "func()", null, "()", "func()"],
    ["broken", "function", "(f func() error", "func(f func() error", null, "(f func() error", "func(f func() error"],
    ["callback", "field", " func() error", "func() error", null, null, "func() error"],
    ["pair", "field", " (int, error)", "(int, error)", null, null, "(int, error)"],
    ["repeat", "function", "(x: number)", null, "number", "(x: number)", "number"],
    ["len", "method", "(…)", "fn len(&self) -> usize", "fn(…) -> usize", "(…)", "fn(…) -> usize"],
    ["print", "function", null, "(value: object, /) -> None", null, null, "(value: object, /) -> None"],
    ["size", "method", "() const", "size_t", null, "()", "size_t"],
    ["Other", "function", "() error", "func(x int) error", null, "()", "func(x int) error"],
    ["Named", "function", "() error", "func() error", "description", "()", "description"],
    ["fmt", "module", ' "fmt"', '"fmt"', null, null, '"fmt"'],
    ["count", "field", "int", null, null, null, "int"],
    ["count", "field", null, "int", null, null, "int"],
    ["pair", "field", "(i32, i32)", null, null, null, "(i32, i32)"],
    ["callback", "property", "(value: string) => void", null, null, null, "(value: string) => void"],
    ["print", "method", "(Object obj)", "PrintStream.print(Object obj) : void", "void", "(Object obj)", "void"],
    ["map", "method", "<T>(value: T)", null, "T[]", "<T>(value: T)", "T[]"],
    [
      "map",
      "method",
      "<T extends (x: number) => number>(value: T)",
      null,
      "T[]",
      "<T extends (x: number) => number>(value: T)",
      "T[]",
    ],
    ["literal", "function", '(value: ")" | "(")', null, "void", '(value: ")" | "(")', "void"],
    ["literal", "function", '<T extends ">">(value: T)', null, "T", '<T extends ">">(value: T)', "T"],
    ["literal", "function", "(value: ')' | '(')", null, "void", "(value: ')' | '(')", "void"],
    [
      "borrow",
      "function",
      "<'a>(value: &'a str)",
      "fn borrow<'a>(value: &'a str)",
      "&'a str",
      "<'a>(value: &'a str)",
      "&'a str",
    ],
    ["str", "function", "(value: object)", null, "str", "(value: object)", "str"],
    ["println!", "function", "(…)", null, "std", "(…)", "std"],
    ["size", "property", "number", "(property) size: number", "number", null, "number"],
    ["value", "variable", "  ", "Order", " ", null, "Order"],
  ] as const)(
    "renders %s (%s) as name, signature suffix and type",
    (label, kind, labelDetail, detail, labelDescription, suffix, type) => {
      const source = item({ label, kind, labelDetail, detail, labelDescription });
      const completion = toCmCompletion(source);
      expect(completion.label).toBe(label);
      expect(completion.detail ?? null).toBe(suffix);
      expect(typeColumnText(source)).toBe(type);
      expect(source.labelDetail).toBe(labelDetail);
    },
  );
});

describe("completion helpers", () => {
  it("detects trigger characters", () => {
    expect(triggerCharacter("a.")).toBe(".");
    expect(triggerCharacter("..")).toBeNull();
    expect(triggerCharacter("a::")).toBe(":");
    expect(triggerCharacter("a:")).toBeNull();
    expect(triggerCharacter("a->")).toBe(">");
    expect(triggerCharacter("a>")).toBeNull();
    expect(triggerCharacter(" @")).toBe("@");
    expect(triggerCharacter("ab")).toBeNull();
  });

  it("finds identifier ends", () => {
    expect(identifierEnd("foo.barBaz(1)", 4)).toBe(10);
    expect(identifierEnd("x ", 1)).toBe(1);
  });
});

describe("applying completions", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  /** `|` marks the caret where completion was requested; `typed` is typed afterwards. */
  function setup(text: string, typed = "") {
    const pos = text.indexOf("|");
    const doc = text.replace("|", "");
    const state = EditorState.create({ doc, selection: { anchor: pos } });
    view = new EditorView({ state, parent: document.body });
    const req = { doc: 1, path: "/p/a.ts", language: null, pos, text: view.state.doc };
    if (typed) view.dispatch({ changes: { from: pos, insert: typed }, selection: { anchor: pos + typed.length } });
    return { view, req, pos };
  }

  const apply = (v: EditorView, c: ReturnType<typeof makeCompletion>, from: number) =>
    (c.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(v, c, from, v.state.selection.main.head);

  it("inserts over the typed prefix and keeps text after the caret (↵)", () => {
    const { view, req } = setup("service.cr|Order()");
    apply(view, makeCompletion(item({ insertText: "create" }), req), 8);
    expect(view.state.doc.toString()).toBe("service.createOrder()");
    expect(view.state.selection.main.head).toBe(14);
  });

  it("keeps overloads sharing a filterText apart", () => {
    const { req } = setup("x.ti|");
    const [a, b] = ["times(other: Int)", "times(other: Long)"].map((label) =>
      makeCompletion(item({ label, filterText: "times" }), req),
    );
    expect([a!.label, b!.label]).toEqual(["times", "times"]);
    expect(a!.apply).not.toBe(b!.apply);
  });

  it("replaces the rest of the identifier with ⇥", () => {
    const { view, req } = setup("service.cr|Order()");
    applyLspCompletion(view, makeCompletion(item({ insertText: "create" }), req), 8, 10, "replace");
    expect(view.state.doc.toString()).toBe("service.create()");
  });

  it("leaves the caret inside a call snippet without stops, past `)` once nothing takes arguments", async () => {
    const { view, req } = setup("new Arr|");
    view.dispatch({ effects: StateEffect.appendConfig.of(lspDoc.of({ doc: 1 } as EditorDocContext)) });
    apply(view, makeCompletion(item({ kind: "constructor", insertText: "ArrayList<>()", isSnippet: true }), req), 4);
    expect(view.state.doc.toString()).toBe("new ArrayList<>()");
    expect(view.state.selection.main.head).toBe(16);
    // Signature help fails outside Tauri: nothing to pass.
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(17));
  });

  it("uses the server's ⇥ range when given", () => {
    const { view, req } = setup("a.cr|Order.x");
    const c = makeCompletion(
      item({
        kind: "field",
        insertText: "create",
        replaceRange: { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } },
        replaceRangeTab: { start: { line: 0, col: 2 }, end: { line: 0, col: 9 } },
      }),
      req,
    );
    applyLspCompletion(view, c, 2, 4, "replace");
    expect(view.state.doc.toString()).toBe("a.create.x");
  });

  it("honours the server's replace range shifted by text typed since the request", () => {
    const { view, req } = setup("x.c|", "re");
    const c = makeCompletion(
      item({ insertText: "create()", replaceRange: { start: { line: 0, col: 2 }, end: { line: 0, col: 3 } } }),
      req,
    );
    apply(view, c, 2);
    expect(view.state.doc.toString()).toBe("x.create()");
  });

  for (const mode of ["insert", "replace"] as const) {
    for (const prefix of ["", "v"]) {
      it(`${mode} leaves the caret after a field snippet accepted at root.${prefix}`, () => {
        const { view, req, pos } = setup(`int a = root.${prefix}|Suffix`);
        const start = "int a = root.".length;
        const c = makeCompletion(
          item({
            label: "val",
            kind: "field",
            insertText: "val",
            isSnippet: true,
            replaceRange: { start: { line: 0, col: start }, end: { line: 0, col: pos } },
          }),
          req,
        );
        applyLspCompletion(view, c, start, pos, mode);
        expect(view.state.doc.toString()).toBe(`int a = root.val${mode === "insert" ? "Suffix" : ""}`);
        expect(view.state.selection.main.head).toBe(start + 3);
      });
    }

    it(`${mode} places a fieldless snippet after imports and a cached UTF-16 prefix`, () => {
      const { view, req, pos } = setup("\n/* 😀 */ root.|Suffix", "v");
      const c = makeCompletion(
        item({
          label: "val",
          kind: "field",
          insertText: "val",
          isSnippet: true,
          replaceRange: { start: { line: 1, col: pos - 1 }, end: { line: 1, col: pos - 1 } },
          additionalEdits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text: "import X;" }],
        }),
        req,
      );
      applyLspCompletion(view, c, pos, pos + 1, mode);
      expect(view.state.doc.toString()).toBe(`import X;\n/* 😀 */ root.val${mode === "insert" ? "Suffix" : ""}`);
      expect(view.state.selection.main.head).toBe(pos + "import X;val".length);
    });

    for (const shape of ["textEdit", "insertReplace", "noEdit"] as const) {
      for (const isSnippet of [false, true]) {
        it(`${mode} replaces a mixed-case prefix typed after a ${shape} request (snippet: ${isSnippet})`, () => {
          const { view, req, pos } = setup("/* 😀 */ System.out.|Suffix", "Print");
          const range = { start: { line: 0, col: pos }, end: { line: 0, col: pos } };
          const c = makeCompletion(
            item({
              label: "print",
              filterText: "print(Object obj) : void",
              insertText: isSnippet ? "print(${0})" : "print()",
              isSnippet,
              replaceRange: shape === "noEdit" ? null : range,
              replaceRangeTab: shape === "insertReplace" ? { ...range, end: { line: 0, col: pos + 6 } } : null,
            }),
            req,
          );
          applyLspCompletion(view, c, pos, pos + 5, mode);
          expect(view.state.doc.toString()).toBe(`/* 😀 */ System.out.print()${mode === "insert" ? "Suffix" : ""}`);
        });
      }
    }

    it(`${mode} accepts the fresh JDT.LS Print response range`, () => {
      const { view, req } = setup("        System.out.Print|");
      const c = makeCompletion(
        item({
          label: "print",
          filterText: "print(Object obj) : void",
          insertText: "print(${0});",
          isSnippet: true,
          replaceRange: { start: { line: 0, col: 19 }, end: { line: 0, col: 24 } },
        }),
        req,
      );
      applyLspCompletion(view, c, 19, 24, mode);
      expect(view.state.doc.toString()).toBe("        System.out.print();");
    });
  }

  for (const mode of ["insert", "replace"] as const) {
    it(`${mode} accepts a cached lookup requested before typing Print`, async () => {
      const { view, req, pos } = setup("System.out.|Suffix");
      const c = makeCompletion(
        item({
          label: "print",
          filterText: "print(Object obj) : void",
          insertText: "print(${0})",
          isSnippet: true,
          replaceRange: { start: { line: 0, col: pos }, end: { line: 0, col: pos } },
        }),
        req,
      );
      const source = vi.fn(() => ({ from: pos, options: [c], validFor: /^\w*$/ }));
      view.dispatch({
        effects: StateEffect.appendConfig.of([
          completionExtension(),
          EditorState.languageData.of(() => [{ openideaCompletion: source }]),
        ]),
      });
      startCompletion(view);
      await vi.waitFor(() => expect(currentCompletions(view.state)).toHaveLength(1));
      view.dispatch({
        changes: { from: pos, insert: "Print" },
        selection: { anchor: pos + 5 },
        userEvent: "input.type",
      });
      await vi.waitFor(() => expect(currentCompletions(view.state)[0]).toBe(c));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        mode === "insert"
          ? acceptCompletion(view)
          : runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Tab" }), "editor"),
      ).toBe(true);
      expect(source).toHaveBeenCalledTimes(1);
      expect(view.state.doc.toString()).toBe(`System.out.print()${mode === "insert" ? "Suffix" : ""}`);
    });
  }

  for (const template of [false, true]) {
    it(`replaces mixed-case prefixes in contributed ${template ? "snippet" : "word"} completions`, async () => {
      const { view } = setup("Print|");
      const source: CompletionSource = () => ({
        from: 0,
        options: [{ label: "print", apply: template ? snippet("print(#{})") : "print" }],
      });
      view.dispatch({
        effects: StateEffect.appendConfig.of([
          completionExtension(),
          EditorState.languageData.of(() => [{ openideaCompletion: source }]),
        ]),
      });
      startCompletion(view);
      await vi.waitFor(() => expect(currentCompletions(view.state)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acceptCompletion(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(template ? "print()" : "print");
    });
  }

  it("applies additional edits (imports) in the same change", () => {
    const { view, req } = setup("\nfoo.ba|");
    const c = makeCompletion(
      item({
        kind: "field",
        insertText: "bar",
        additionalEdits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text: "import bar;" }],
      }),
      req,
    );
    apply(view, c, 5);
    expect(view.state.doc.toString()).toBe("import bar;\nfoo.bar");
  });

  it("adds parentheses to a called function and opens its parameters", () => {
    const { view, req } = setup("svc.cr|");
    apply(view, makeCompletion(item({ insertText: "create", labelDetail: "(req: Req)" }), req), 4);
    expect(view.state.doc.toString()).toBe("svc.create()");
    expect(view.state.selection.main.head).toBe(11);
  });

  it("places the caret after the parentheses of a parameterless call", () => {
    const { view, req } = setup("svc.cl|");
    apply(view, makeCompletion(item({ insertText: "close", labelDetail: "()" }), req), 4);
    expect(view.state.doc.toString()).toBe("svc.close()");
    expect(view.state.selection.main.head).toBe(11);
  });

  it("expands snippets with fields", () => {
    const { view, req } = setup("pri|");
    apply(view, makeCompletion(item({ insertText: "println!(${1:arg})$0", isSnippet: true }), req), 0);
    expect(view.state.doc.toString()).toBe("println!(arg)");
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("arg");
  });
});

describe("insert parentheses", () => {
  const line = (text: string) => ({ from: 0, text });
  it("applies to plain callables only", () => {
    expect(callParens(item(), line("a.cr"), 2, 4)).toBe("inside");
    expect(callParens(item({ kind: "field" }), line("a.cr"), 2, 4)).toBeNull();
    expect(callParens(item({ isSnippet: true }), line("a.cr"), 2, 4)).toBeNull();
    expect(callParens(item({ insertText: "create()" }), line("a.cr"), 2, 4)).toBeNull();
  });

  it("skips calls that already have parentheses and imports", () => {
    expect(callParens(item(), line("a.cr(x)"), 2, 4)).toBeNull();
    expect(callParens(item(), line("cr'"), 0, 2)).toBeNull();
    expect(callParens(item(), line('cr"'), 0, 2)).toBeNull();
    expect(callParens(item(), line("import { cr"), 9, 11)).toBeNull();
    expect(callParens(item(), line("use crate::cr"), 11, 13)).toBeNull();
  });
});

describe("file paths in strings", () => {
  it("are offered in PHP and Blade only once the string reads like a path", () => {
    expect(offersPaths("php", "config('app.")).toBe(false);
    expect(offersPaths("php", "User::create(['na")).toBe(false);
    expect(offersPaths("php", "require './")).toBe(true);
    expect(offersPaths("blade", "@include('partials/")).toBe(true);
  });

  it("are offered as before in other languages", () => {
    expect(offersPaths("typescript", "import x from 'mod")).toBe(true);
    expect(offersPaths("rust", 'include_str!("da')).toBe(true);
  });
});

describe("sort suggestions alphabetically", () => {
  const result = (labels: string[]) => ({ from: 0, options: labels.map((label) => ({ label })), validFor: /^\w*$/ });

  it("filters and orders by name", () => {
    const sorted = sortAlphabetically(result(["zeta", "Alpha", "beta", "gamma", "alphabet"]), "a");
    expect(sorted.filter).toBe(false);
    expect(sorted.options.map((o) => o.label)).toEqual(["Alpha", "alphabet", "beta", "gamma", "zeta"]);
    expect(sortAlphabetically(result(["zeta", "Alpha", "beta"]), "al").options.map((o) => o.label)).toEqual(["Alpha"]);
  });

  it("matches substrings, then subsequences", () => {
    expect(matchRanges("getValue", "val")).toEqual([3, 6]);
    expect(matchRanges("getValue", "gv")).toEqual([0, 1, 3, 4]);
    expect(matchRanges("getValue", "x")).toBeNull();
  });
});

describe("lookup commit characters", () => {
  it("finishes only focused lookups unless the setting asks for it (IDEA)", () => {
    expect(commitsLookup(".", true, false)).toBe(true);
    expect(commitsLookup(".", false, false)).toBe(false);
    expect(commitsLookup(".", false, true)).toBe(true);
    expect(commitsLookup("-", true, false)).toBe(false);
    expect(commitsLookup("[", true, false, ["["])).toBe(true);
  });

  it("leaves server commit characters to the lookup", () => {
    const req = { doc: 1, path: "/a.ts", language: "typescript", pos: 0, text: EditorState.create().doc };
    expect(makeCompletion(item({ commitCharacters: ["."] }), req).commitCharacters).toBeUndefined();
  });
});

describe("explicit completion", () => {
  function editor(labels: string[]) {
    const source: CompletionSource = (ctx) => {
      const word = ctx.matchBefore(/\w*/);
      return { from: word?.from ?? ctx.pos, options: labels.map((label) => ({ label })) };
    };
    const view = new EditorView({
      state: EditorState.create({
        doc: "pri",
        selection: { anchor: 3 },
        extensions: [completionExtension(), EditorState.languageData.of(() => [{ openideaCompletion: source }])],
      }),
      parent: document.body,
    });
    return view;
  }

  it("inserts a sole candidate right away (IDEA)", async () => {
    const view = editor(["println"]);
    explicitCompletion(view);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("println"), { timeout: 2000 });
    view.destroy();
  });

  it("keeps a sole candidate in the list when auto-insert is off", async () => {
    useProject.setState({ settings: { editor: { completion: { autoInsertSingle: false } } } as unknown as Settings });
    const view = editor(["println"]);
    explicitCompletion(view);
    await new Promise((r) => setTimeout(r, 300));
    expect(view.state.doc.toString()).toBe("pri");
    view.destroy();
    useProject.setState({ settings: null });
  });

  it("shows the list when there are several candidates", async () => {
    const view = editor(["println", "print"]);
    explicitCompletion(view);
    await new Promise((r) => setTimeout(r, 300));
    expect(view.state.doc.toString()).toBe("pri");
    view.destroy();
  });
});

describe("typeColumnText", () => {
  const edit = (new_text: string) => [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text }];

  it("names the module an auto-import comes from", () => {
    expect(
      typeColumnText({ detail: "Auto-import", additionalEdits: edit("\nfrom collections import OrderedDict") }),
    ).toBe("collections");
    expect(typeColumnText({ detail: "Map<K, V>", additionalEdits: edit("import java.util.HashMap;\n") })).toBe(
      "Map<K, V> (java.util)",
    );
    expect(typeColumnText({ detail: null, additionalEdits: edit("use std::collections::HashMap;\n") })).toBe(
      "std::collections",
    );
    expect(typeColumnText({ detail: null, additionalEdits: edit('import { a } from "./money";\n') })).toBe("./money");
  });

  it("shows the type, not the repeated signature, when the server sends both (JDT.LS `print`)", () => {
    expect(
      typeColumnText({
        labelDescription: "void",
        detail: "PrintStream.print(Object obj) : void",
        additionalEdits: [],
      }),
    ).toBe("void");
    expect(typeColumnText({ labelDescription: "String", detail: "Person.name : String", additionalEdits: [] })).toBe(
      "String",
    );
  });

  it("falls back to the detail when the server sends no description, and names the import source", () => {
    expect(typeColumnText({ labelDescription: null, detail: "Order", additionalEdits: [] })).toBe("Order");
    expect(
      typeColumnText({
        labelDescription: "Auto-import",
        detail: "Auto import from './money'",
        additionalEdits: edit('import { a } from "./money";\n'),
      }),
    ).toBe("./money");
  });

  it.each([
    ["TypeScript", "(method) String.toUpperCase(): string"],
    ["Python", "(value: object) -> str"],
    ["Rust", "fn len(&self) -> usize"],
    ["Go", "func() error"],
  ])("keeps %s details unchanged without label details", (_language, detail) => {
    expect(typeColumnText(item({ detail }))).toBe(detail);
  });

  it.each(["", " \n\t "])("falls back to the signature for a blank description (%j)", (labelDescription) => {
    expect(typeColumnText(item({ labelDescription, detail: "Order" }))).toBe("Order");
  });

  it("keeps a detail that already says where", () => {
    expect(
      typeColumnText({ detail: "java.util.ArrayList", additionalEdits: edit("import java.util.ArrayList;\n") }),
    ).toBe("java.util.ArrayList");
    expect(typeColumnText({ detail: "fn()  ", additionalEdits: [] })).toBe("fn() ");
  });
});
