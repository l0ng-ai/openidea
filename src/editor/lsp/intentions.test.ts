import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

const { intentionPreview, withInspectionControls } = await import("./intentions");
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
