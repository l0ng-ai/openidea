import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, renderHook } from "@testing-library/react";
import type { PythonRequirements } from "@/bindings";

const pythonRequirements = vi.fn();
const sdkPythonPip = vi.fn();
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
    commands: { ...actual.commands, pythonRequirements, sdkPythonPip, cancelRequest },
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
  unsatisfied: [
    { dependency: { package: "Django", requirement: "Django>=5", ...span("Django>=5") }, installed: "4.2" },
    { dependency: { package: "requests", requirement: "requests", ...span("requests") }, installed: null },
  ],
};
let deactivate: () => void;
const views: EditorView[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  pythonRequirements.mockResolvedValue({ status: "ok", data: result });
  sdkPythonPip.mockResolvedValue({ status: "ok", data: null });
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
function editor(path = "/p/requirements.txt") {
  const ctx = { doc: 3, path, language: "text", uiMode: "Text", readOnly: false };
  const contribution = editorContributions().find((c) => c.id === "dependency-versions")!;
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor: span("requests").from },
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
    ]);
  });

  it("leaves other files alone", async () => {
    editor("/p/constraints.txt");
    await settle();
    expect(pythonRequirements).not.toHaveBeenCalled();
  });

  it("installs one or all requirements, then checks again", async () => {
    const view = editor();
    await settle();
    const fixes = contributedIntentions(view);
    expect(fixes.map((f) => f.label)).toEqual(["Install requirement", "Install all missing requirements"]);
    pythonRequirements.mockResolvedValue({ status: "ok", data: { ...result, unsatisfied: [] } });
    await fixes[1]!.run();
    await vi.waitFor(() => expect(useRequirements.getState().installs).toBe(1));
    expect(sdkPythonPip.mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/p/.venv/bin/python", "Django>=5", false, false],
      ["/p/.venv/bin/python", "requests", false, false],
    ]);
    await settle();
    expect(pythonRequirements).toHaveBeenCalledTimes(2);
    expect(diagnosticsFor("/p/requirements.txt")).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports failed installs in one notification", async () => {
    sdkPythonPip.mockResolvedValue({ status: "error", error: { kind: "failed", message: "no matching distribution" } });
    const view = editor();
    await settle();
    await contributedIntentions(view)[0]!.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify.mock.calls[0]![0]).toMatchObject({
      level: "error",
      body: expect.stringContaining("requests: no matching distribution"),
    });
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
});
