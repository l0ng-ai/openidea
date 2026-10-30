import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { IdeError, Locals, NodeAt, Range, SymbolMatch, SyntaxNode } from "@/bindings";

type R<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: IdeError }>;
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const unavailable = () =>
  Promise.resolve({ status: "error" as const, error: { kind: "unavailable", message: "no server" } as IdeError });

const cmd = {
  lspHover: vi.fn((): R<unknown> => ok(null)),
  lspDocumentLinks: vi.fn(() => ok([])),
  cancelRequest: vi.fn(() => ok(null)),
  lspGoto: vi.fn((): R<unknown> => unavailable()),
  lspDocumentHighlights: vi.fn((): R<unknown> => unavailable()),
  lspPrepareRename: vi.fn((): R<unknown> => unavailable()),
  lspRename: vi.fn((): R<unknown> => unavailable()),
  syntaxSupport: vi.fn(() => ok({ tree: true, locals: true })),
  syntaxLocals: vi.fn((): R<Locals> => ok({ status: "noIdentifier" })),
  syntaxNodeAt: vi.fn((): R<NodeAt | null> => ok(null)),
  syntaxIdentifiers: vi.fn((): R<unknown> => ok([])),
  syntaxErrors: vi.fn((): R<unknown> => ok({ errors: [], truncated: false })),
  findSymbols: vi.fn((): R<SymbolMatch[]> => ok([])),
  applyWorkspaceEdit: vi.fn((): R<unknown> => ok(null)),
};

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, ...cmd } };
});

const openFile = vi.fn(async () => {});
const { provideEditorService } = await import("@/workbench/contributions");
provideEditorService({ openFile } as never);

const fb = await import("./syntaxFallback");
const { gotoTargets, navigationExtension, highlightUsages } = await import("./navigation");
const { startRename, renameNamePart } = await import("./rename");
const { lspDoc } = await import("./lsp");
const { useLspPopup, closePopup } = await import("./popupStore");

const r = (line: number, col: number, endCol: number): Range => ({ start: { line, col }, end: { line, col: endCol } });
const node = (kind: string, range: Range, field: string | null = null): SyntaxNode => ({
  kind,
  range,
  field,
  named: true,
  error: false,
  missing: false,
  hasError: false,
});
const sym = (name: string, kind: SymbolMatch["kind"], path: string, container: string | null = null): SymbolMatch => ({
  name,
  kind,
  container,
  path,
  relPath: path.slice(1),
  range: r(3, 4, 4 + name.length),
  score: 1,
  indices: [],
});
const local = (over: Partial<Extract<Locals, { status: "local" }>["symbol"]> = {}): Locals => ({
  status: "local",
  symbol: {
    name: "x",
    kind: "var",
    definition: r(0, 6, 7),
    scope: { start: { line: 0, col: 0 }, end: { line: 9, col: 0 } },
    references: [r(1, 2, 3)],
    certain: true,
    conflicts: [],
    ...over,
  },
});

const views: EditorView[] = [];
function editor(doc: string, language = "typescript", anchor = 0) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        lspDoc.of({ doc: 7, path: "/p/a.ts", language, uiMode: null, readOnly: false }),
        navigationExtension(),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

beforeEach(() => {
  for (const f of Object.values(cmd)) f.mockClear();
  openFile.mockClear();
  closePopup();
});
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

describe("usageRole / filterSymbols", () => {
  it("reads the role from the tree", () => {
    const id = r(0, 0, 3);
    expect(fb.usageRole({ node: node("type_identifier", id), ancestors: [] })).toBe("type");
    expect(fb.usageRole({ node: node("identifier", id, "function"), ancestors: [node("call_expression", id)] })).toBe(
      "call",
    );
    expect(fb.usageRole({ node: node("identifier", id, "name"), ancestors: [node("method_invocation", id)] })).toBe(
      "call",
    );
    expect(fb.usageRole({ node: node("identifier", id, "constructor"), ancestors: [node("new_expression", id)] })).toBe(
      "new",
    );
    expect(fb.usageRole({ node: node("identifier", id), ancestors: [node("binary_expression", id)] })).toBe("other");
    expect(fb.usageRole(null)).toBe("other");
  });

  it("keeps exact names whose kind fits the role", () => {
    const all = [
      sym("Foo", "class", "/a"),
      sym("Foo", "function", "/b"),
      sym("Foo", "field", "/c"),
      sym("Foobar", "class", "/d"),
      sym("Foo", "file", "/e"),
    ];
    expect(fb.filterSymbols(all, "Foo", "type").map((s) => s.path)).toEqual(["/a"]);
    expect(fb.filterSymbols(all, "Foo", "call").map((s) => s.path)).toEqual(["/a", "/b"]);
    expect(fb.filterSymbols(all, "Foo", "other").map((s) => s.path)).toEqual(["/a", "/b", "/c"]);
  });

  it("only keeps declarations from the same language family", () => {
    expect(fb.compatibleFiles("/a/Main.kt", "/b/Util.java")).toBe(true);
    expect(fb.compatibleFiles("/a/app.tsx", "/b/util.js")).toBe(true);
    expect(fb.compatibleFiles("/a/pets.rb", "/b/util.lua")).toBe(false);
    expect(fb.compatibleFiles("/a/x.lua", "/b/y.lua")).toBe(true);
    expect(fb.compatibleFiles("/a/Makefile", "/b/y.lua")).toBe(true);
  });

  it("ranks the current file and same-extension files first", () => {
    const t = (path: string) => ({ path, range: r(0, 0, 1) });
    expect(fb.rankTargets([t("/z.kt"), t("/b.ts"), t("/a.py"), t("/me.ts")], "/me.ts").map((x) => x.path)).toEqual([
      "/me.ts",
      "/b.ts",
      "/a.py",
      "/z.kt",
    ]);
  });
});

describe("declarationFallback", () => {
  const doc = { doc: 7, path: "/p/a.ts", language: "typescript" };
  const text = Text.of(["const x = 1;", "  x + foo();"]);

  it("jumps to a certain local definition without asking the index", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok(local()));
    expect(await fb.declarationFallback(doc, text, { line: 1, col: 2 })).toEqual({
      kind: "targets",
      targets: [{ path: "/p/a.ts", range: r(0, 6, 7), name: "x" }],
      ambiguous: false,
    });
    expect(cmd.findSymbols).not.toHaveBeenCalled();
  });

  it("offers every same-scope declaration when the local is ambiguous", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok(local({ certain: false, conflicts: [r(4, 4, 5)] })));
    const res = await fb.declarationFallback(doc, text, { line: 1, col: 2 });
    expect(res).toMatchObject({ kind: "targets", ambiguous: true });
    expect(res.kind === "targets" && res.targets.map((t) => t.range.start.line)).toEqual([0, 4]);
  });

  it("looks non-locals up in the index by exact name and role", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(
      ok({ status: "notLocal", name: "foo", range: r(1, 6, 9), reason: "unresolved" }),
    );
    cmd.syntaxNodeAt.mockReturnValueOnce(
      ok({ node: node("identifier", r(1, 6, 9), "function"), ancestors: [node("call_expression", r(1, 6, 11))] }),
    );
    cmd.findSymbols.mockReturnValueOnce(
      ok([
        sym("foo", "function", "/p/b.ts", "util"),
        sym("foo", "field", "/p/c.ts"),
        sym("foobar", "function", "/p/d.ts"),
      ]),
    );
    const res = await fb.declarationFallback(doc, text, { line: 1, col: 7 });
    expect(cmd.findSymbols).toHaveBeenCalledWith("foo", "all", 500);
    expect(res).toEqual({
      kind: "targets",
      targets: [{ path: "/p/b.ts", range: r(3, 4, 7), name: "foo", kind: "function", container: "util" }],
      ambiguous: false,
    });
  });

  it("does not filter members by role", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok({ status: "notLocal", name: "foo", range: r(1, 6, 9), reason: "member" }));
    cmd.syntaxNodeAt.mockReturnValueOnce(ok({ node: node("property_identifier", r(1, 6, 9)), ancestors: [] }));
    cmd.findSymbols.mockReturnValueOnce(
      ok([sym("foo", "method", "/p/b.ts", "A"), sym("foo", "field", "/p/c.ts", "B")]),
    );
    const res = await fb.declarationFallback(doc, text, { line: 1, col: 7 });
    expect(res).toMatchObject({ kind: "targets", ambiguous: true });
  });

  it("uses the node text for languages without locals, and gives up without a grammar", async () => {
    cmd.syntaxSupport.mockReturnValueOnce(ok({ tree: true, locals: false }));
    cmd.syntaxNodeAt.mockReturnValueOnce(ok({ node: node("identifier", r(1, 6, 9)), ancestors: [] }));
    await fb.declarationFallback({ ...doc, language: "nolocals" }, text, { line: 1, col: 7 });
    expect(cmd.findSymbols).toHaveBeenCalledWith("foo", "all", 500);
    cmd.syntaxSupport.mockReturnValueOnce(ok({ tree: false, locals: false }));
    expect(await fb.declarationFallback({ ...doc, language: "nogrammar" }, text, { line: 0, col: 0 })).toEqual({
      kind: "unsupported",
    });
  });
});

describe("rename helpers", () => {
  it("expands shorthands and refuses stale text", () => {
    const text = Text.of(["const x = 1;", "f({ x }, x);"]);
    const plan = {
      symbol: (local() as Extract<Locals, { status: "local" }>).symbol,
      occurrences: [
        { range: r(0, 6, 7), shorthand: false },
        { range: r(1, 4, 5), shorthand: true },
        { range: r(1, 9, 10), shorthand: false },
      ],
    };
    const changes = fb.renameChanges(text, plan, "y");
    expect(EditorState.create({ doc: text }).update({ changes: changes! }).state.doc.toString()).toBe(
      "const y = 1;\nf({ x: y }, y);",
    );
    expect(fb.renameChanges(Text.of(["const z = 1;", "f({ x }, x);"]), plan, "y")).toBeNull();
  });

  it("detects JS and Rust shorthand nodes", () => {
    const id = r(0, 0, 1);
    expect(fb.isShorthand({ node: node("shorthand_property_identifier", id), ancestors: [] })).toBe(true);
    expect(fb.isShorthand({ node: node("shorthand_property_identifier_pattern", id), ancestors: [] })).toBe(true);
    expect(fb.isShorthand({ node: node("identifier", id), ancestors: [node("shorthand_field_initializer", id)] })).toBe(
      true,
    );
    expect(fb.isShorthand({ node: node("identifier", id), ancestors: [node("arguments", id)] })).toBe(false);
  });

  it("refuses non-locals and plans locals with shorthand detection", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok({ status: "notLocal", name: "foo", range: r(0, 0, 3), reason: "member" }));
    expect(await fb.planLocalRename({ doc: 7, language: "typescript" }, { line: 0, col: 1 })).toMatchObject({
      kind: "refused",
    });
    cmd.syntaxLocals.mockReturnValueOnce(ok(local()));
    cmd.syntaxNodeAt
      .mockReturnValueOnce(ok({ node: node("identifier", r(0, 6, 7)), ancestors: [] }))
      .mockReturnValueOnce(ok({ node: node("shorthand_property_identifier", r(1, 2, 3)), ancestors: [] }));
    const res = await fb.planLocalRename({ doc: 7, language: "typescript" }, { line: 0, col: 6 });
    expect(res.kind === "plan" && res.plan.occurrences.map((o) => o.shorthand)).toEqual([false, true]);
    // No shorthand syntax in Python: no node queries.
    cmd.syntaxNodeAt.mockClear();
    cmd.syntaxLocals.mockReturnValueOnce(ok(local()));
    await fb.planLocalRename({ doc: 7, language: "python" }, { line: 0, col: 6 });
    expect(cmd.syntaxNodeAt).not.toHaveBeenCalled();
  });

  it("flags ambiguity and name clashes inside the scope", async () => {
    const plan = {
      symbol: (local({ certain: false, conflicts: [r(3, 0, 1)] }) as Extract<Locals, { status: "local" }>).symbol,
      occurrences: [],
    };
    cmd.syntaxIdentifiers.mockReturnValueOnce(
      ok([
        { range: r(2, 0, 1), kind: "identifier", qualified: false },
        { range: r(2, 4, 5), kind: "property_identifier", qualified: true },
        { range: r(20, 0, 1), kind: "identifier", qualified: false },
      ]),
    );
    const risks = await fb.renameRisks(7, plan, "y");
    expect(risks).toHaveLength(2);
    expect(risks[0]).toContain("declared 2 times");
    expect(risks[1]).toContain("1 occurrence");
  });

  it("only highlights certain locals", () => {
    expect(fb.localHighlights(local())).toEqual([
      { range: r(0, 6, 7), kind: "write" },
      { range: r(1, 2, 3), kind: "text" },
    ]);
    expect(fb.localHighlights(local({ certain: false }))).toBeNull();
    expect(fb.localHighlights({ status: "notLocal", name: "x", range: r(0, 0, 1), reason: "topLevel" })).toBeNull();
  });
});

describe("navigation wiring", () => {
  it("respects an empty server answer", async () => {
    cmd.lspGoto.mockReturnValueOnce(ok([]));
    const view = editor("const x = 1;\nx;", "typescript", 13);
    await gotoTargets(view, "definition");
    expect(cmd.syntaxLocals).not.toHaveBeenCalled();
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("Cannot find declaration to go to");
  });

  it("falls back to the local definition when the server is not ready", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok(local({ references: [r(1, 0, 1)] })));
    const view = editor("const x = 1;\nx;", "typescript", 13);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/p/a.ts", { selection: { line: 0, col: 6 }, focus: true });
  });

  it("opens a chooser for several index candidates", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok({ status: "notLocal", name: "run", range: r(0, 4, 7), reason: "member" }));
    cmd.syntaxNodeAt.mockReturnValueOnce(ok({ node: node("property_identifier", r(0, 4, 7)), ancestors: [] }));
    cmd.findSymbols.mockReturnValueOnce(
      ok([sym("run", "method", "/p/a.ts", "A"), sym("run", "method", "/p/b.ts", "B")]),
    );
    const view = editor("obj.run();", "typescript", 5);
    await gotoTargets(view, "definition");
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("list");
    if (popup?.kind !== "list") return;
    expect(popup.title).toBe("Choose Declaration of run (2 found, based on syntax)");
    expect(popup.pin?.label).toBe("Open in Find Tool Window");
    expect(popup.items.map((i) => [i.label, i.symbol, i.detail?.split(" · ")[0]])).toEqual([
      ["run", "method", "A"],
      ["run", "method", "B"],
    ]);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("keeps the server error when the language has no grammar", async () => {
    cmd.syntaxSupport.mockReturnValueOnce(ok({ tree: false, locals: false }));
    const view = editor("x", "plain-nogrammar", 0);
    await gotoTargets(view, "definition");
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("No language server available");
  });

  it("highlights a certain local when the server is not ready", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok(local({ references: [r(1, 0, 1)] })));
    const view = editor("const x = 1;\nx;", "typescript", 13);
    highlightUsages(view);
    await vi.waitFor(() => expect(view.dom.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(2));
    expect(view.dom.querySelectorAll(".cm-lsp-occurrence-write")).toHaveLength(1);
  });

  it("does not highlight non-locals from syntax", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok({ status: "notLocal", name: "x", range: r(0, 0, 1), reason: "topLevel" }));
    const view = editor("x;", "typescript", 0);
    highlightUsages(view);
    await vi.waitFor(() =>
      expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("No language server available"),
    );
    expect(view.dom.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(0);
  });
});

describe("rename wiring", () => {
  it("preserves the server's missing capability when syntax cannot rename a method", async () => {
    cmd.lspPrepareRename.mockReturnValueOnce(
      Promise.resolve({
        status: "error",
        error: { kind: "unavailable", message: "intelephense doesn't support rename" },
      }),
    );
    cmd.syntaxLocals.mockReturnValueOnce(ok({ status: "notLocal", name: "run", range: r(0, 4, 7), reason: "member" }));
    const view = editor("obj.run();", "php", 5);
    await startRename(view);
    const message = document.querySelector(".cm-lsp-hint")?.textContent;
    expect(message).toContain("intelephense doesn't support rename");
    expect(message).toContain("only local variables");
    expect(message).not.toContain("without the language server");
    expect(view.state.doc.toString()).toBe("obj.run();");
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("renames a certain local in place when the server is not ready", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok(local({ references: [r(1, 4, 5)] })));
    cmd.syntaxNodeAt
      .mockReturnValueOnce(ok({ node: node("identifier", r(0, 6, 7)), ancestors: [] }))
      .mockReturnValueOnce(ok({ node: node("shorthand_property_identifier", r(1, 4, 5)), ancestors: [] }));
    const view = editor("const x = 1;\nf({ x });", "typescript", 6);
    await startRename(view);
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("rename");
    if (popup?.kind !== "rename") return;
    expect(popup.note).toContain("Based on syntax");
    popup.onSubmit("y");
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("const y = 1;\nf({ x: y });"));
    expect(cmd.lspRename).not.toHaveBeenCalled();
  });

  it("asks before renaming an ambiguous local", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(
      ok(local({ references: [r(1, 0, 1)], certain: false, conflicts: [r(2, 4, 5)] })),
    );
    const view = editor("const x = 1;\nx;\nvar x;", "typescript", 6);
    await startRename(view);
    const popup = useLspPopup.getState().popup;
    if (popup?.kind !== "rename") throw new Error("no rename popup");
    popup.onSubmit("y");
    await vi.waitFor(() => expect(useLspPopup.getState().popup?.kind).toBe("preview"));
    const preview = useLspPopup.getState().popup;
    if (preview?.kind !== "preview") return;
    expect(preview.occurrences?.map((o) => o.line)).toEqual([0, 1]);
    expect(view.state.doc.toString()).toBe("const x = 1;\nx;\nvar x;");
    preview.onConfirm();
    expect(view.state.doc.toString()).toBe("const y = 1;\ny;\nvar x;");
  });

  it("never renames non-locals from syntax", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(ok({ status: "notLocal", name: "run", range: r(0, 4, 7), reason: "member" }));
    const view = editor("obj.run();", "typescript", 5);
    await startRename(view);
    expect(useLspPopup.getState().popup).toBeNull();
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toContain("only local variables");
  });

  describe("Typo: Rename to (issue #42)", () => {
    it("renames the whole name through the server, references included", async () => {
      cmd.lspPrepareRename.mockReturnValueOnce(ok(r(0, 0, 12)));
      const edits = [r(0, 0, 12), r(1, 6, 18)].map((range) => ({ range, new_text: "message_count" }));
      const edit = { files: [{ kind: "edit", path: "/p/a.ts", edits }] };
      cmd.lspRename.mockReturnValueOnce(ok(edit));
      const view = editor("mesage_count = 1\nprint(mesage_count)", "python", 0);
      await renameNamePart(view, { from: 0, to: 6 }, "message");
      expect(cmd.lspRename).toHaveBeenCalledWith(7, { line: 0, col: 0 }, "message_count");
      expect(cmd.applyWorkspaceEdit).toHaveBeenCalledWith(edit);
      // Nothing was replaced locally: the server's edit covers every reference.
      expect(view.state.doc.toString()).toBe("mesage_count = 1\nprint(mesage_count)");
    });

    it("falls back to the syntax rename of a local, references included", async () => {
      cmd.syntaxLocals.mockReturnValueOnce(
        ok(local({ name: "mesage", definition: r(0, 0, 6), references: [r(1, 6, 12)] })),
      );
      const view = editor("mesage = 'hello'\nprint(mesage)", "python", 0);
      await renameNamePart(view, { from: 0, to: 6 }, "message");
      expect(view.state.doc.toString()).toBe("message = 'hello'\nprint(message)");
    });

    it("changes nothing when the symbol can't be renamed safely", async () => {
      cmd.syntaxLocals.mockReturnValueOnce(
        ok({ status: "notLocal", name: "mesage", range: r(0, 0, 6), reason: "topLevel" }),
      );
      const view = editor("mesage = 'hello'\nprint(mesage)", "python", 0);
      await renameNamePart(view, { from: 0, to: 6 }, "message");
      expect(view.state.doc.toString()).toBe("mesage = 'hello'\nprint(mesage)");
      expect(document.querySelector(".cm-lsp-hint")?.textContent).toContain("Cannot rename safely");
    });
  });

  it("respects a server refusal over valid code, but falls back over broken code", async () => {
    cmd.lspPrepareRename.mockReturnValueOnce(ok(null));
    const view = editor("const x = 1;", "typescript", 6);
    await startRename(view);
    expect(cmd.syntaxLocals).not.toHaveBeenCalled();
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("This element can't be renamed");

    cmd.lspPrepareRename.mockReturnValueOnce(ok(null));
    cmd.syntaxErrors.mockReturnValueOnce(
      ok({
        errors: [{ kind: "missing", range: r(0, 12, 12), expected: ";", message: "missing `;`" }],
        truncated: false,
      }),
    );
    cmd.syntaxLocals.mockReturnValueOnce(ok(local({ references: [] })));
    await startRename(view);
    expect(useLspPopup.getState().popup?.kind).toBe("rename");
  });
});

describe("modifier-hover navigation recovery", () => {
  const target = { path: "/p/target.ts", range: r(0, 0, 1), uri: null };
  let mac = false;
  beforeAll(async () => {
    mac = (await import("@/platform/keymap")).isMacHost();
  });
  function move(view: EditorView, pos = 0, primary = true) {
    vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
    view.contentDOM.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        metaKey: primary && mac,
        ctrlKey: primary && !mac,
      }),
    );
  }

  it("shows the link without waiting for documentation", async () => {
    cmd.lspGoto.mockReturnValueOnce(ok([target]));
    cmd.lspHover.mockReturnValueOnce(new Promise(() => {}));
    const view = editor("foo");
    move(view);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("foo"));
    expect(cmd.lspHover).toHaveBeenCalled();
  });

  it("retries a transient server error instead of caching no target", async () => {
    cmd.lspGoto.mockReturnValueOnce(
      Promise.resolve({ status: "error", error: { kind: "internal", message: "timeout" } }),
    );
    const view = editor("foo");
    move(view);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cmd.lspGoto.mockReturnValueOnce(ok([target]));
    move(view);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("foo"));
    expect(cmd.lspGoto).toHaveBeenCalledTimes(2);
  });

  it("retries a stuck probe and ignores its eventual response", async () => {
    let finish!: (value: Awaited<R<unknown>>) => void;
    cmd.lspGoto.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = editor("foo");
    vi.useFakeTimers();
    try {
      move(view);
      await vi.advanceTimersByTimeAsync(3001);
      cmd.lspGoto.mockReturnValueOnce(ok([target]));
      move(view);
      await vi.advanceTimersByTimeAsync(0);
      expect(cmd.lspGoto).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("foo"));
    finish({ status: "ok", data: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("foo");
  });

  it("ignores a late probe after moving to a different word", async () => {
    let finish!: (value: Awaited<R<unknown>>) => void;
    cmd.lspGoto.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    cmd.lspGoto.mockReturnValueOnce(ok([target]));
    const view = editor("foo bar");
    move(view);
    move(view, 4);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("bar"));
    finish({ status: "ok", data: [target] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("bar");
  });
});
