import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, renderHook } from "@testing-library/react";
import type { PythonRequirements } from "@/bindings";

const pythonRequirements = vi.fn();
const sdkPythonInstallRequirements = vi.fn();
const cancelRequest = vi.fn(async () => {});
const notify = vi.fn();
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = (_: string) => {};
  },
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, pythonRequirements, sdkPythonInstallRequirements, cancelRequest },
  };
});
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));
const { activate } = await import("./index");
const { useRequirements } = await import("./python");
const { editorContributions, contributedIntentions } = await import("@/editor/api");
const { diagnosticsFor } = await import("@/editor/lsp/diagnostics");
const { lspDoc } = await import("@/editor/lsp/lsp");
const { useProject } = await import("@/platform/project");
const { useEditorBanners } = await import("@/workbench/contributions");

const text = "# 中文 😀\nDjango>=5\nrequests\nnumpy\n";
const span = (s: string) => ({ from: text.indexOf(s), to: text.indexOf(s) + s.length });
const result: PythonRequirements = {
  python: "/p/.venv/bin/python",
  options: ["--index-url https://private.example/simple"],
  unsatisfied: [
    {
      dependency: { package: "Django", requirement: "Django>=5", ...span("Django>=5") },
      installed: "4.2",
      install: "Django>=5",
    },
    {
      dependency: { package: "requests", requirement: "requests", ...span("requests") },
      installed: null,
      install: "requests --hash=sha256:abc",
    },
    // From a uv source: marked, never installed by pip.
    { dependency: { package: "numpy", requirement: "numpy", ...span("numpy") }, installed: null, install: null },
  ],
};
let deactivate: () => void;
const views: EditorView[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  pythonRequirements.mockResolvedValue({ status: "ok", data: result });
  sdkPythonInstallRequirements.mockResolvedValue({ status: "ok", data: null });
  useProject.setState({ project: { root: "/p" } as never, settings: {} as never });
  deactivate = activate();
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  deactivate();
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
  vi.useRealTimers();
});
function editor(path = "/p/requirements.txt", anchor = span("requests").from) {
  const ctx = { doc: 3, path, language: "text", uiMode: "Text", readOnly: false };
  const contribution = editorContributions().find((c) => c.id === "dependency-versions")!;
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor },
      extensions: [lspDoc.of(ctx), contribution.extensions(ctx)],
    }),
  });
  views.push(view);
  return view;
}
const settle = () => vi.advanceTimersByTimeAsync(550);
const banner = (path: string) =>
  renderHook(() => useEditorBanners.getState().banners.get("python.requirements")!.useBanner(path)).result.current;

describe("Python requirements", () => {
  it.each(["/p/requirements.txt", "/p/requirements-dev.txt", "/p/pyproject.toml"])("checks %s", async (path) => {
    editor(path);
    await settle();
    expect(pythonRequirements).toHaveBeenCalledWith(3, expect.any(Number));
    expect(diagnosticsFor(path)).toMatchObject([
      {
        severity: "warning",
        message: "Requirement Django>=5 is not satisfied: 4.2 is installed",
        range: { start: { line: 1, col: 0 }, end: { line: 1, col: 9 } },
      },
      { severity: "warning", message: "Package requests is not installed", range: { start: { line: 2, col: 0 } } },
      { severity: "warning", message: "Package numpy is not installed", range: { start: { line: 3, col: 0 } } },
    ]);
  });

  it("leaves other files alone", async () => {
    editor("/p/constraints.txt");
    await settle();
    expect(pythonRequirements).not.toHaveBeenCalled();
  });

  it("installs one or all requirements with the manifest's options, then checks again", async () => {
    const view = editor();
    await settle();
    const fixes = contributedIntentions(view);
    expect(fixes.map((f) => f.label)).toEqual(["Install requirement", "Install all missing requirements"]);
    pythonRequirements.mockResolvedValue({ status: "ok", data: { ...result, unsatisfied: [] } });
    await fixes[1]!.run();
    await vi.waitFor(() => expect(useRequirements.getState().installs).toBe(1));
    expect(sdkPythonInstallRequirements.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [
        "/p/.venv/bin/python",
        ["--index-url https://private.example/simple", "Django>=5", "requests --hash=sha256:abc"],
      ],
    ]);
    await settle();
    expect(pythonRequirements).toHaveBeenCalledTimes(2);
    expect(diagnosticsFor("/p/requirements.txt")).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("offers no install for a requirement pip can't install faithfully", async () => {
    const view = editor("/p/requirements.txt", span("numpy").from);
    await settle();
    expect(contributedIntentions(view)).toEqual([]);
  });

  it("queues a second install into the same interpreter behind the first", async () => {
    const view = editor();
    await settle();
    let finish!: () => void;
    sdkPythonInstallRequirements.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ status: "ok", data: null }))),
    );
    const [one] = contributedIntentions(view);
    await one!.run();
    await one!.run();
    await vi.advanceTimersByTimeAsync(10);
    expect(sdkPythonInstallRequirements).toHaveBeenCalledOnce();
    expect(useRequirements.getState().installing.get("/p/.venv/bin/python")).toBe(2);
    finish();
    await vi.waitFor(() => expect(sdkPythonInstallRequirements).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useRequirements.getState().installing.size).toBe(0));
  });

  it("reports a failed install in a notification", async () => {
    sdkPythonInstallRequirements.mockResolvedValue({
      status: "error",
      error: { kind: "failed", message: "no matching distribution" },
    });
    const view = editor();
    await settle();
    await contributedIntentions(view)[0]!.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify.mock.calls[0]![0]).toMatchObject({
      level: "error",
      body: expect.stringContaining("no matching distribution"),
    });
  });

  it("checks again when the interpreter changes, not for other settings", async () => {
    editor();
    await settle();
    act(() => useProject.setState({ settings: { editor: { fontSize: 14 } } as never }));
    await settle();
    expect(pythonRequirements).toHaveBeenCalledOnce();
    act(() => useProject.setState({ settings: { languages: { python: { interpreter: "/other/python" } } } as never }));
    await settle();
    expect(pythonRequirements).toHaveBeenCalledTimes(2);
  });

  it("shows a banner until ignored, and none without unsatisfied requirements", async () => {
    editor();
    await settle();
    expect(useRequirements.getState().byPath.get("/p/requirements.txt")).toEqual(result);
    expect(banner("/p/requirements.txt")).toMatchObject({
      text: "Package requirements are not satisfied",
      actions: [{ label: "Install requirements" }, { label: "Ignore" }],
    });
    act(() => useRequirements.setState({ ignored: true }));
    expect(banner("/p/requirements.txt")).toBeNull();
    expect(banner("/p/other.txt")).toBeNull();
  });

  it("offers only Ignore when nothing can be installed from the file", async () => {
    pythonRequirements.mockResolvedValue({ status: "ok", data: { ...result, unsatisfied: [result.unsatisfied[2]!] } });
    editor("/p/pyproject.toml");
    await settle();
    expect(banner("/p/pyproject.toml")?.actions?.map((a) => a.label)).toEqual(["Ignore"]);
  });
});
