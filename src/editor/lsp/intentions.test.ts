import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import type { CodeAction, Diagnostic } from "@/bindings";

const resolved: CodeAction = {
  title: "Introduce local variable",
  kind: "refactor.extract",
  isPreferred: false,
  disabledReason: null,
  edit: {
    files: [
      {
        kind: "edit",
        path: "/p/a.ts",
        edits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text: "const x = 1;\n" }],
      },
      { kind: "create", path: "/p/b.ts", overwrite: false },
    ],
  },
  command: null,
  data: null,
  server: 1,
};
const runInteractiveCodeAction = vi.fn(async () => false);
vi.mock("./interactiveCommand", () => ({ runInteractiveCodeAction }));
const lspCodeActions = vi.fn();
const lspApplyCodeAction = vi.fn();
const lspResolveCodeAction = vi.fn(async () => ({ status: "ok" as const, data: resolved }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, lspResolveCodeAction, lspCodeActions, lspApplyCodeAction },
  };
});

const {
  actionsForDiagnostic,
  applyQuickFix,
  INTENTIONS_POPUP_DELAY_MS,
  quickFixesAt,
  applyKindSilently,
  bulbLine,
  changedLines,
  indentUnderBrace,
  intentionPreview,
  lightsBulb,
  listedCodeActions,
  listedIntentions,
  showIntentions,
  withInspectionControls,
} = await import("./intentions");
const { useLspPopup, closePopup } = await import("./popupStore");
const { asyncIntentionProviders } = await import("@/editor/api");
const { setFileDiagnostics, toLintDiagnostics } = await import("./diagnostics");
const { lspDoc } = await import("./lsp");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  closePopup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("⌥↵ popup timing", () => {
  const editor = (doc: string, caret: number, path = "/p/a.ts") => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: caret },
        extensions: [lspDoc.of({ doc: 1, path, language: "typescript", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    return view;
  };
  const answer = (data: CodeAction[]) => ({ status: "ok" as const, data });

  it("shows the popup while the server is still answering, then fills it", async () => {
    vi.useFakeTimers();
    const view = editor("f(1);\n", 0);
    let resolve!: (v: unknown) => void;
    lspCodeActions.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const shown = showIntentions(view);
    await vi.advanceTimersByTimeAsync(INTENTIONS_POPUP_DELAY_MS);
    const popup = useLspPopup.getState().popup;
    expect(popup).toMatchObject({ kind: "list", title: "Intentions", busy: true, items: [] });
    resolve(answer([{ ...resolved, edit: null }]));
    await shown;
    expect(useLspPopup.getState().popup).toMatchObject({ kind: "list", busy: false });
    expect((useLspPopup.getState().popup as { items: { label: string }[] }).items.map((i) => i.label)).toEqual([
      "Introduce local variable",
    ]);
  });

  it("shows the answer at once when it beats the delay", async () => {
    vi.useFakeTimers();
    const view = editor("f(1);\n", 0);
    lspCodeActions.mockResolvedValue(answer([{ ...resolved, edit: null }]));
    await showIntentions(view);
    const popup = useLspPopup.getState().popup;
    expect(popup).toMatchObject({ kind: "list", busy: false });
    // Every row is there before the delay could have shown an empty list.
    expect((popup as { items: unknown[] }).items).toHaveLength(1);
  });

  it("asks the line's errors alongside the caret's actions instead of after them", async () => {
    vi.useFakeTimers();
    const view = editor("val order: Order\n", 4);
    const error: Diagnostic = {
      range: { start: { line: 0, col: 11 }, end: { line: 0, col: 16 } },
      severity: "error",
      message: "Unresolved reference: Order",
      source: "kotlin",
      code: null,
    };
    view.dispatch(setDiagnostics(view.state, toLintDiagnostics(view.state.doc, [error])));
    const fix = { ...resolved, title: "Create class 'Order'", kind: "quickfix", edit: null };
    lspCodeActions.mockImplementation(async (_doc: number, range: { start: { col: number } }) =>
      answer(range.start.col === 11 ? [fix] : []),
    );
    await showIntentions(view);
    expect(lspCodeActions).toHaveBeenCalledTimes(2);
    expect((useLspPopup.getState().popup as { items: { label: string }[] }).items.map((i) => i.label)).toEqual([
      "Create class 'Order'",
    ]);
    setFileDiagnostics("/p/a.ts", "kotlin", []);
  });

  it("drops the busy popup when the request fails and nothing local is offered", async () => {
    vi.useFakeTimers();
    const view = editor("f(1);\n", 0);
    let reject!: (e: unknown) => void;
    lspCodeActions.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const shown = showIntentions(view);
    await vi.advanceTimersByTimeAsync(INTENTIONS_POPUP_DELAY_MS);
    expect((useLspPopup.getState().popup as { busy: boolean }).busy).toBe(true);
    reject({ kind: "internal", message: "boom" });
    await shown;
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("closes instead of reopening when the caret's context changed meanwhile", async () => {
    vi.useFakeTimers();
    const view = editor("f(1);\n", 0);
    let resolve!: (v: unknown) => void;
    lspCodeActions.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const shown = showIntentions(view);
    await vi.advanceTimersByTimeAsync(INTENTIONS_POPUP_DELAY_MS);
    expect(useLspPopup.getState().popup).not.toBeNull();
    view.dispatch({ changes: { from: 0, insert: "g();\n" } });
    resolve(answer([{ ...resolved, edit: null }]));
    await shown;
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("keeps a popup the user opened while the actions were being computed", async () => {
    vi.useFakeTimers();
    const view = editor("f(1);\n", 0);
    let resolve!: (v: unknown) => void;
    lspCodeActions.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const shown = showIntentions(view);
    await vi.advanceTimersByTimeAsync(INTENTIONS_POPUP_DELAY_MS);
    const mine = useLspPopup.getState().popup;
    // Something else (a chooser, another ⌥↵) replaced it.
    const other = { kind: "list" as const, anchor: { x: 0, y: 0 }, title: "Other", items: [] };
    useLspPopup.setState((s) => ({ popup: other, seq: s.seq + 1 }));
    resolve(answer([{ ...resolved, edit: null }]));
    await shown;
    expect(useLspPopup.getState().popup).toBe(other);
    expect(mine).not.toBe(other);
  });
});

describe("context actions a feature finds through the language server", () => {
  const editor = (...providers: Parameters<typeof asyncIntentionProviders.of>[0][]) => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "f(1);\n",
        extensions: [
          lspDoc.of({ doc: 1, path: "/p/A.java", language: "java", uiMode: null, readOnly: false }),
          ...providers.map((p) => asyncIntentionProviders.of(p)),
        ],
      }),
    });
    views.push(view);
    return view;
  };
  const labels = () => (useLspPopup.getState().popup as { items: { label: string }[] }).items.map((i) => i.label);
  const intention = (label: string) => ({ id: label, label, run: () => {} });

  it("waits for them and lists them with the server's actions", async () => {
    let answer!: (v: ReturnType<typeof intention>[]) => void;
    const view = editor(() => new Promise((r) => (answer = r)));
    lspCodeActions.mockResolvedValue({ status: "ok", data: [{ ...resolved, edit: null }] });
    const shown = showIntentions(view);
    await Promise.resolve();
    answer([intention("Create exception breakpoint on Failure")]);
    await shown;
    expect(labels()).toEqual(
      expect.arrayContaining(["Create exception breakpoint on Failure", "Introduce local variable"]),
    );
  });

  it("lists them alone when the server has nothing", async () => {
    const view = editor(async () => [intention("Disable exception breakpoint on Failure")]);
    lspCodeActions.mockResolvedValue({ status: "ok", data: [] });
    await showIntentions(view);
    expect(labels()).toEqual(["Disable exception breakpoint on Failure"]);
  });

  it("keeps the other rows when one provider fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor(
      async () => {
        throw new Error("boom");
      },
      async () => [intention("Enable exception breakpoint on Failure")],
    );
    lspCodeActions.mockResolvedValue({ status: "ok", data: [] });
    await showIntentions(view);
    expect(labels()).toEqual(["Enable exception breakpoint on Failure"]);
    error.mockRestore();
  });
});

describe("inspection controls in ⌥↵ (issue #42)", () => {
  const editorAt = (path: string) => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "import os\n",
        selection: { anchor: 8 },
        extensions: [lspDoc.of({ doc: 1, path, language: "python", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    return view;
  };
  const unused = {
    range: { start: { line: 0, col: 7 }, end: { line: 0, col: 9 } },
    severity: "warning" as const,
    message: "`os` imported but unused",
    source: "Ruff",
    code: "F401",
  };
  const labels = (items: { label: string }[]) => items.map((i) => i.label);

  it("gives the fixes of the one inspection at the caret its → menu", () => {
    setFileDiagnostics("/p/one.py", "ruff", [unused]);
    const view = editorAt("/p/one.py");
    const fix = { id: "0", label: "Remove unused import", icon: "bulb-fix", run: vi.fn() };
    const refactor = { id: "1", label: "Extract method", icon: "bulb", run: vi.fn() };
    const [withMenu, plain] = withInspectionControls(view, [fix, refactor]);
    expect(withMenu!.submenu?.map((s) => ("label" in s ? s.label : "-"))).toEqual([
      "Edit inspection profile setting",
      "Disable inspection",
    ]);
    expect(plain!.submenu).toBeUndefined();
    setFileDiagnostics("/p/one.py", "ruff", []);
  });

  it("offers an options row when the inspection has no fix", () => {
    setFileDiagnostics("/p/two.py", "ruff", [unused]);
    const view = editorAt("/p/two.py");
    const items = withInspectionControls(view, []);
    expect(labels(items)).toEqual(["Inspection 'ruff F401' options"]);
    expect(items[0]!.submenu).toHaveLength(2);
    setFileDiagnostics("/p/two.py", "ruff", []);
    expect(withInspectionControls(view, [])).toEqual([]);
  });

  it.each(["info", "warning", "error"] as const)(
    "uses the effective %s severity for local and LSP fixes",
    (severity) => {
      const path = `/p/severity-${severity}.py`;
      setFileDiagnostics(path, "ruff", [{ ...unused, severity }]);
      const view = editorAt(path);
      view.dispatch(setDiagnostics(view.state, [{ from: 7, to: 9, severity, message: unused.message }]));
      const items = listedIntentions(view, [
        { id: "refactor", label: "Extract method", icon: "bulb", run: vi.fn() },
        { id: "local", label: "Local fix", quickFix: true, run: vi.fn() },
        { id: "lsp", label: "LSP fix", quickFix: true, emphasis: true, run: vi.fn() },
      ]);
      expect(items.map((i) => i.id)).toEqual(["lsp", "local", "refactor"]);
      expect(items.slice(0, 2).map((i) => i.icon)).toEqual(Array(2).fill(severity === "error" ? "bulb-fix" : "bulb"));
      const controls = withInspectionControls(view, items);
      expect(controls.slice(0, 2).every((i) => i.submenu?.length === 2)).toBe(true);
      expect(controls[2]!.submenu).toBeUndefined();
      setFileDiagnostics(path, "ruff", []);
    },
  );
});

describe("silent code actions", () => {
  it("does not run lazy plugin actions that could prompt during Actions on Save", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "f(1);",
        extensions: [lspDoc.of({ doc: 1, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    lspCodeActions.mockResolvedValueOnce({
      status: "ok",
      data: [{ ...resolved, kind: "source.fixAll", server: 0, edit: null }],
    });
    expect(await applyKindSilently(view, "source.fixAll")).toBe(false);
    expect(lspApplyCodeAction).not.toHaveBeenCalled();
    expect(lspResolveCodeAction).not.toHaveBeenCalled();
  });
});

describe("fix-all from every server", () => {
  const fixAll = (server: number, title: string): CodeAction => ({
    ...resolved,
    title,
    kind: "source.fixAll",
    server,
    edit: null,
    data: "{}",
  });
  const editor = () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "const a = 'x';",
        extensions: [lspDoc.of({ doc: 1, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    return view;
  };

  it("applies each server's source.fixAll in turn, asking the next one again after an edit", async () => {
    const view = editor();
    const ts = fixAll(1, "Fix all fixable JS/TS issues");
    const eslint = fixAll(2, "Fix all fixable ESLint issues");
    const eslintAfter = { ...eslint, data: '{"version":2}' };
    lspCodeActions
      .mockResolvedValueOnce({ status: "ok", data: [ts, eslint] })
      .mockResolvedValueOnce({ status: "ok", data: [{ ...ts, data: '{"again":true}' }, eslintAfter] });
    lspApplyCodeAction.mockResolvedValue({ status: "ok", data: null });
    expect(await applyKindSilently(view, "source.fixAll")).toBe(true);
    expect(lspCodeActions).toHaveBeenCalledTimes(2);
    expect(lspApplyCodeAction.mock.calls.map((c) => (c as unknown[])[1])).toEqual([ts, eslintAfter]);
  });

  it("goes on with the next server when one server's action fails", async () => {
    const view = editor();
    const ts = fixAll(1, "Fix all fixable JS/TS issues");
    const eslint = fixAll(2, "Fix all fixable ESLint issues");
    lspCodeActions.mockResolvedValue({ status: "ok", data: [ts, eslint] });
    lspApplyCodeAction
      .mockResolvedValueOnce({ status: "error", error: { kind: "internal", message: "boom" } })
      .mockResolvedValueOnce({ status: "ok", data: null });
    expect(await applyKindSilently(view, "source.fixAll")).toBe(true);
    expect(lspApplyCodeAction.mock.calls.map((c) => ((c as unknown[])[1] as CodeAction).server)).toEqual([1, 2]);
  });

  it("applies a single organize-imports action", async () => {
    const view = editor();
    const a = { ...fixAll(1, "Organize Imports"), kind: "source.organizeImports" };
    const b = { ...fixAll(2, "Organize Imports"), kind: "source.organizeImports" };
    lspCodeActions.mockResolvedValueOnce({ status: "ok", data: [a, b] });
    lspApplyCodeAction.mockResolvedValue({ status: "ok", data: null });
    expect(await applyKindSilently(view, "source.organizeImports")).toBe(true);
    expect(lspApplyCodeAction).toHaveBeenCalledTimes(1);
  });
});

describe("intention preview", () => {
  it("does not resolve lazy plugin actions while previewing", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "f(1);",
        extensions: [lspDoc.of({ doc: 1, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    const cache = new Map<CodeAction, Promise<CodeAction>>();
    const preview = await intentionPreview(
      view,
      { ...resolved, server: 0, edit: null },
      cache,
      new AbortController().signal,
    );
    expect(preview).toEqual({ kind: "text", text: "Preview isn't available for this action" });
    expect(lspResolveCodeAction).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
    expect(await intentionPreview(view, { ...resolved, server: 0 }, cache, new AbortController().signal)).toMatchObject(
      { kind: "diff" },
    );
  });

  it("resolves the action once and shows its diff for this file", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "f(1);",
        extensions: [lspDoc.of({ doc: 1, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    const action = { ...resolved, edit: null };
    const cache = new Map<CodeAction, Promise<CodeAction>>();
    const signal = new AbortController().signal;
    const preview = await intentionPreview(view, action, cache, signal);
    expect(preview).toEqual({
      kind: "diff",
      lines: [
        { kind: "added", text: "const x = 1;" },
        { kind: "context", text: "f(1);" },
      ],
      note: "Also changes 1 other file",
    });
    await intentionPreview(view, action, cache, signal);
    expect(lspResolveCodeAction).toHaveBeenCalledOnce();
  });
});

describe("listedCodeActions", () => {
  const action = (title: string, kind: string): CodeAction => ({ ...resolved, title, kind, edit: null });
  it("lists one action per title, quick fixes first", () => {
    const list = listedCodeActions([
      action("Generate toString()", "quickassist"),
      action("Add unimplemented methods", "quickfix"),
      action("Generate toString()", "source.generate.toString"),
    ]);
    expect(list.map((a) => [a.title, a.kind])).toEqual([
      ["Add unimplemented methods", "quickfix"],
      ["Generate toString()", "quickassist"],
    ]);
  });
});

describe("changedLines", () => {
  const text = (s: string) => EditorState.create({ doc: s }).doc;
  it("spans the lines an edit inserted", () => {
    expect(changedLines(text("class A {\n}\n"), text("class A {\n  f() {\n  }\n}\n"))).toEqual([{ from: 2, to: 3 }]);
  });
  it("keeps separate edits apart", () => {
    const before = text("package p;\n\nclass A {\n  int a;\n  int b;\n  void f() {\n  }\n}\n");
    const after = text(
      "package p;\n\nimport java.util.List;\n\nclass A {\n  int a;\n  int b;\n  void f() {\n    List<String> x = null;\n    x.size();\n  }\n}\n",
    );
    expect(changedLines(before, after)).toEqual([
      { from: 3, to: 4 },
      { from: 9, to: 10 },
    ]);
  });
  it("is empty for equal texts", () => {
    expect(changedLines(text("a\nb"), text("a\nb"))).toEqual([]);
  });
});

describe("bulbLine", () => {
  const state = (s: string) => EditorState.create({ doc: s });
  it("prefers an indented caret line, then the lines around it", () => {
    expect(bulbLine(state("    x\ny"), 1)).toEqual({ line: 1, gutter: false });
    expect(bulbLine(state("x\n\ny"), 1)).toEqual({ line: 2, gutter: false });
  });
  it("falls back to the gutter when no nearby line has room", () => {
    expect(bulbLine(state("x\n  y\nz"), 1)).toEqual({ line: 1, gutter: true });
  });
});

describe("lightsBulb", () => {
  const kinds = (k: string | null) => lightsBulb({ ...resolved, kind: k });
  it("lights for fixes and refactorings only", () => {
    expect([null, "quickfix", "refactor.extract", "quickassist"].map(kinds)).toEqual([true, true, true, true]);
    expect(["source.organizeImports", "source.doc", "gopls.doc.features"].map(kinds)).toEqual([false, false, false]);
  });
});

describe("indentUnderBrace", () => {
  const text = (s: string) => EditorState.create({ doc: s }).doc;
  it("moves code generated at the brace's column one level in", () => {
    const doc = text("class A : B {\noverride fun f() {\n    g()\n}\n}");
    expect(indentUnderBrace(doc, 2, 4, "    ").map((c) => [doc.lineAt(c.from).number, c.insert])).toEqual([
      [2, "    "],
      [3, "    "],
      [4, "    "],
    ]);
  });
  it("leaves code already indented, or not under a brace", () => {
    expect(indentUnderBrace(text("class A {\n    f()\n}"), 2, 2, "    ")).toEqual([]);
    expect(indentUnderBrace(text("class A:\npass\nx"), 2, 3, "    ")).toEqual([]);
  });
});

describe("quick fixes for overlapping diagnostics", () => {
  const unused: Diagnostic = {
    range: { start: { line: 0, col: 1 }, end: { line: 0, col: 37 } },
    severity: "warning",
    message: "github.com/sergi/go-diff is not used in this module",
    source: "go mod tidy",
    code: null,
    unnecessary: false,
    deprecated: false,
  };
  const upgrade: Diagnostic = {
    ...unused,
    severity: "info",
    message: "github.com/sergi/go-diff can be upgraded",
    source: "upgrade available",
  };
  const remove: CodeAction = {
    ...resolved,
    title: "Remove dependency: github.com/sergi/go-diff",
    kind: "quickfix",
    isPreferred: true,
    diagnostics: [unused],
  };
  const update: CodeAction = {
    ...remove,
    title: "Upgrade to v1.4.0",
    isPreferred: false,
    diagnostics: [upgrade],
  };

  it("keeps only actions for each problem even when another problem's fix is preferred", () => {
    expect(actionsForDiagnostic([remove, update], unused)).toEqual([remove]);
    expect(actionsForDiagnostic([remove, update], upgrade)).toEqual([update]);
    expect(actionsForDiagnostic([remove], upgrade)).toEqual([]);
    expect(actionsForDiagnostic([remove, { ...update, diagnostics: [] }], upgrade)).toEqual([]);
    expect(actionsForDiagnostic([{ ...remove, diagnostics: [unused, upgrade] }], upgrade)).toHaveLength(1);
  });

  it("retains the range fallback only when every action omits diagnostics", () => {
    const actions = [
      { ...remove, diagnostics: [] },
      { ...update, diagnostics: undefined },
    ];
    expect(actionsForDiagnostic(actions, unused)).toEqual(actions);
    expect(actionsForDiagnostic(actions, upgrade)).toEqual(actions);
  });

  it.each([
    { message: "another problem" },
    { range: { ...unused.range, end: { line: 0, col: 38 } } },
    { code: "other" },
    { source: "other" },
  ])("checks diagnostic identity: %j", (over) => {
    const problem = { ...unused, code: "unused" };
    expect(actionsForDiagnostic([{ ...remove, diagnostics: [{ ...problem, ...over }] }], problem)).toEqual([]);
  });

  it.each([unused, upgrade])("uses the matching fix for hover and Apply Quick Fix: $message", async (problem) => {
    const view = new EditorView({
      state: EditorState.create({
        doc: " github.com/sergi/go-diff v1.3.1         ",
        selection: { anchor: 3 },
        extensions: [lspDoc.of({ doc: 1, path: "/p/go.mod", language: "go", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    view.dispatch(setDiagnostics(view.state, toLintDiagnostics(view.state.doc, [problem])));
    const expected = problem === unused ? remove : update;
    lspCodeActions.mockResolvedValue({ status: "ok", data: [remove, update] });
    expect(await quickFixesAt(view, 1, 37, problem)).toEqual([expected]);
    await applyQuickFix(view);
    expect(runInteractiveCodeAction).toHaveBeenCalledWith(1, expected);
  });

  it("prefers a preferred matching fix and preserves empty ranges widened for display", async () => {
    const problem = { ...upgrade, range: { start: { line: 0, col: 2 }, end: { line: 0, col: 2 } } };
    const first = { ...update, diagnostics: [problem] };
    const preferred = { ...first, title: "Preferred upgrade", isPreferred: true };
    const view = new EditorView({
      state: EditorState.create({
        doc: " dependency",
        selection: { anchor: 2 },
        extensions: [lspDoc.of({ doc: 1, path: "/p/go.mod", language: "go", uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    view.dispatch(setDiagnostics(view.state, toLintDiagnostics(view.state.doc, [problem])));
    lspCodeActions.mockResolvedValue({ status: "ok", data: [remove, first, preferred] });
    expect(await quickFixesAt(view, 2, 3, problem)).toEqual([preferred, first]);
    await applyQuickFix(view);
    expect(runInteractiveCodeAction).toHaveBeenCalledWith(1, preferred);
  });
});
