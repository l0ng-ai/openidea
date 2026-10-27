import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CompletionItem } from "@/bindings";
import { completionSymbolKind, identifierEnd, toCmCompletion, triggerCharacter } from "./completionItems";
import {
  applyLspCompletion,
  callParens,
  commitsLookup,
  completionExtension,
  explicitCompletion,
  makeCompletion,
  matchRanges,
  sortAlphabetically,
} from "./completion";
import type { CompletionSource } from "@codemirror/autocomplete";
import { useProject } from "@/platform/project";
import type { Settings } from "@/platform/ipc";

function item(over: Partial<CompletionItem> = {}): CompletionItem {
  return {
    label: "create",
    labelDetail: null,
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

  it("replaces the rest of the identifier with ⇥", () => {
    const { view, req } = setup("service.cr|Order()");
    applyLspCompletion(view, makeCompletion(item({ insertText: "create" }), req), 8, 10, "replace");
    expect(view.state.doc.toString()).toBe("service.create()");
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
    expect(callParens(item(), line("import { cr"), 9, 11)).toBeNull();
    expect(callParens(item(), line("use crate::cr"), 11, 13)).toBeNull();
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
