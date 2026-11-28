import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import type { CodeAction } from "@/bindings";

const ipc = vi.hoisted(() => ({ navPythonLibraryImports: vi.fn(), cancelRequest: vi.fn() }));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { pythonLibraryImports, undefinedNameAt } = await import("./libraryImports");
const { withoutSuperseded } = await import("../../intentions");
const { lspDoc } = await import("../../lsp");

const ctx = { doc: 3, path: "/p/agent.py", language: "python", uiMode: "Python", readOnly: false };
const views: EditorView[] = [];

/** `doc` with the caret on `caret` and an unresolved-name diagnostic of `code` on each of `unresolved`. */
function mount(doc: string, caret: string, unresolved: string[], code = "reportUndefinedVariable") {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.indexOf(caret) + 1 }, extensions: [lspDoc.of(ctx)] }),
    parent: document.body,
  });
  views.push(view);
  const diagnostics = unresolved.map((name) => {
    const from = doc.indexOf(name);
    const message = `"${name}" is not defined`;
    return {
      from,
      to: from + name.length,
      severity: "error" as const,
      message,
      problem: { code, message, source: "basedpyright" },
    };
  });
  view.dispatch(setDiagnostics(view.state, diagnostics));
  return view;
}

const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
const action = (title: string, kind = "quickfix"): CodeAction => ({ title, kind }) as CodeAction;

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.clearAllMocks();
});

describe("Python library imports", () => {
  const source = "from my_model.my_model import cpa_model\nmodel = cpa_model()\n\ncreate_agent(\n  model=model\n)\n";

  it("finds the unresolved name at the caret, for every Python server's code", () => {
    for (const code of ["reportUndefinedVariable", "F821", "unresolved-reference", "unknown-name"]) {
      const view = mount(source, "create_agent", ["create_agent"], code);
      expect(undefinedNameAt(view.state, view.state.selection.main.head)).toBe("create_agent");
    }
    const other = mount(source, "create_agent", ["create_agent"], "reportAttributeAccessIssue");
    expect(undefinedNameAt(other.state, other.state.selection.main.head)).toBeNull();
  });

  it("offers the candidates of the installed packages and inserts the chosen import", async () => {
    ipc.navPythonLibraryImports.mockReturnValue(
      ok([
        { module: "langchain.agents", name: "create_agent" },
        { module: "langchain.agents.factory", name: "create_agent" },
      ]),
    );
    const view = mount(source, "create_agent", ["create_agent"]);
    const found = await pythonLibraryImports(view, new AbortController().signal);
    expect(ipc.navPythonLibraryImports).toHaveBeenCalledWith(3, "create_agent", expect.any(Number));
    expect(found.map((i) => i.label)).toEqual([
      "Import 'create_agent' from 'langchain.agents'",
      "Import 'create_agent' from 'langchain.agents.factory'",
    ]);
    expect(found.every((i) => i.quickFix)).toBe(true);
    await found[0]!.run();
    expect(view.state.doc.toString()).toBe(
      "from my_model.my_model import cpa_model\nfrom langchain.agents import create_agent\nmodel = cpa_model()\n\n" +
        "create_agent(\n  model=model\n)\n",
    );
  });

  it("adds to an import from the same module and imports a module as a whole", async () => {
    ipc.navPythonLibraryImports.mockReturnValue(
      ok([
        { module: "matplotlib", name: null },
        { module: "matplotlib.colors", name: "Normalize" },
      ]),
    );
    const view = mount("from matplotlib.colors import Colormap\n\nn = Normalize()\n", "Normalize", ["Normalize"]);
    const found = await pythonLibraryImports(view, new AbortController().signal);
    expect(found.map((i) => i.label)).toEqual([
      "Import module 'matplotlib'",
      "Import 'Normalize' from 'matplotlib.colors'",
    ]);
    await found[1]!.run();
    expect(view.state.doc.toString()).toBe("from matplotlib.colors import Colormap, Normalize\n\nn = Normalize()\n");
  });

  it("asks nothing away from an unresolved name, and cancels the request when the caret moves on", async () => {
    const plain = mount(source, "model =", ["create_agent"]);
    expect(await pythonLibraryImports(plain, new AbortController().signal)).toEqual([]);
    expect(ipc.navPythonLibraryImports).not.toHaveBeenCalled();

    let answer!: (value: unknown) => void;
    ipc.navPythonLibraryImports.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = mount(source, "create_agent", ["create_agent"]);
    const asked = new AbortController();
    const found = pythonLibraryImports(view, asked.signal);
    asked.abort();
    expect(ipc.cancelRequest).toHaveBeenCalledWith(ipc.navPythonLibraryImports.mock.calls[0]![2]);
    answer({ status: "error", error: { kind: "cancelled", message: "cancelled" } });
    expect(await found).toEqual([]);
  });

  it("gives way to an import fix of the language server", async () => {
    ipc.navPythonLibraryImports.mockReturnValue(ok([{ module: "collections", name: "OrderedDict" }]));
    const view = mount("d = OrderedDict()\n", "OrderedDict", ["OrderedDict"]);
    const found = await pythonLibraryImports(view, new AbortController().signal);
    const ignore = action('Add "# pyright: ignore[reportUndefinedVariable]"');
    expect(withoutSuperseded(found, [ignore])).toHaveLength(1);
    expect(withoutSuperseded(found, [ignore, action('Import "OrderedDict" from "collections"')])).toEqual([]);
    // Another name's import, a refactoring or a disabled action does not count.
    expect(withoutSuperseded(found, [action('Import "Counter" from "collections"')])).toHaveLength(1);
    expect(withoutSuperseded(found, [action("Import OrderedDict", "refactor.extract")])).toHaveLength(1);
    expect(withoutSuperseded(found, [{ ...action("Import OrderedDict"), disabledReason: "no" }])).toHaveLength(1);
  });
});
