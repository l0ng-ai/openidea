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
  quickFixesAt,
  applyKindSilently,
  bulbLine,
  changedLines,
  indentUnderBrace,
  intentionPreview,
  lightsBulb,
  listedCodeActions,
  listedIntentions,
  withInspectionControls,
} = await import("./intentions");
const { setFileDiagnostics, toLintDiagnostics } = await import("./diagnostics");
const { lspDoc } = await import("./lsp");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
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
