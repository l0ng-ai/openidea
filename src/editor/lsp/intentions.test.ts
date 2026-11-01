import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import type { CodeAction } from "@/bindings";

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
const lspResolveCodeAction = vi.fn(async () => ({ status: "ok" as const, data: resolved }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspResolveCodeAction } };
});

const {
  bulbLine,
  changedLines,
  indentUnderBrace,
  intentionPreview,
  lightsBulb,
  listedCodeActions,
  listedIntentions,
  withInspectionControls,
} = await import("./intentions");
const { setFileDiagnostics } = await import("./diagnostics");
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

describe("intention preview", () => {
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
