import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PluginInfo, TerminalInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { useContributions } from "@/workbench/contributions";
import { usePlugins } from "../store";
import { startViewUi } from "../uiPoints";
import { registerLogActions } from "../views/logActions";
import { PluginLogEditor } from "../views/logEditor";
import { boundedLog, logTabData, type PluginLogEditorData } from "../views/logTab";
import { logTabPtyBackend, webPtyBackend } from "../views/ptyBackend";
import type { PtyBackend } from "../views/ptyBridge";

vi.mock("../views/ptyBackend", () => ({ webPtyBackend: vi.fn(), logTabPtyBackend: vi.fn() }));

const plugin = { id: "probe", enabled: true, capabilities: [{ id: "process:bash", granted: true }] } as PluginInfo;
const spec = {
  program: "bash",
  title: "Probe logs",
  args: ["--noprofile", "--norc"],
  toggles: [{ id: "verbose", label: "Verbose", args: ["-v"] }],
};
let stopActions: () => void;
beforeEach(() => {
  stopActions = registerLogActions();
});

const projectState = useProject.getState();
afterEach(() => {
  cleanup();
  stopActions();
  usePlugins.setState({ plugins: [] });
  useProject.setState(projectState, true);
  vi.restoreAllMocks();
});

function setup(extra: Partial<PluginLogEditorData> = {}) {
  usePlugins.setState({ plugins: [plugin] });
  let output: (text: string) => void = () => {};
  let exit: Parameters<PtyBackend["onExit"]>[0] = () => {};
  const backend: PtyBackend = {
    spawn: vi.fn(async (_command, listener) => {
      output = listener;
      return { id: 42 } as TerminalInfo;
    }),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    onExit: (listener) => {
      exit = listener;
      return vi.fn();
    },
  };
  vi.mocked(webPtyBackend).mockReturnValue(backend);
  vi.mocked(logTabPtyBackend).mockReturnValue(backend);
  const data = { ...logTabData("probe", "logs", spec, 100), ...extra };
  const input = { kind: "pluginLog", key: "test-log", data };
  const rendered = render(<PluginLogEditor input={input} />);
  const content = () => rendered.container.querySelector(".cm-content")!;
  const view = () => EditorView.findFromDOM(content() as HTMLElement)!;
  return {
    backend,
    rendered,
    input,
    view,
    output: (text: string) => act(() => output(text)),
    exit: () => act(() => exit(42, 0)),
  };
}

describe("plugin streaming log tabs", () => {
  it("rejects malformed requests and exact-grant failures instead of rewriting commands", () => {
    usePlugins.setState({ plugins: [plugin] });
    for (const bad of [
      { program: "sh" },
      { program: "/bin/bash" },
      { program: " bash" },
      { args: [123] },
      { args: ["\0"] },
      { args: ["x".repeat(4097)] },
      { baseArgs: ["--verbose"] },
      { cwd: "/" },
      { env: { PATH: "/tmp" } },
      { title: "x".repeat(257) },
      { toggles: [spec.toggles[0], spec.toggles[0]] },
      { toggles: [{ id: "v", label: "V", args: [false] }] },
      { key: "x".repeat(129) },
    ])
      expect(() => logTabData("probe", "logs", { ...spec, ...bad }, 100)).toThrow();
    expect(() => logTabData("probe", "logs", spec, (2 << 20) + 1)).toThrow();
    usePlugins.setState({ plugins: [{ ...plugin, enabled: false }] });
    expect(() => logTabData("probe", "logs", spec, 100)).toThrow();
  });

  it("bounds newline-free output and retained lines", () => {
    expect(boundedLog("x".repeat(2 << 20))).toHaveLength(1 << 20);
    expect(boundedLog("😀" + "x".repeat((1 << 20) - 1))).toBe("x".repeat((1 << 20) - 1));
    expect(boundedLog(Array.from({ length: 6000 }, (_, i) => `${i}`).join("\n")).split("\n")).toHaveLength(5000);
  });

  it("renders partial output read-only, handles early exit, clears, wraps and finds", async () => {
    const f = setup();
    expect(webPtyBackend).toHaveBeenCalledWith("probe", "logs");
    expect(f.backend.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ program: "bash", env: {}, args: spec.args }),
      expect.any(Function),
    );
    expect(f.view().state.facet(EditorState.readOnly)).toBe(true);
    expect(f.view().contentDOM.getAttribute("contenteditable")).toBe("false");
    f.output("INFO partial");
    f.exit();
    await waitFor(() => expect(f.view().state.doc.toString()).toContain("[Process finished with exit code 0]"));
    expect(f.view().state.doc.toString()).toContain("INFO partial");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(f.view().state.doc.length).toBe(0);
    const wasWrapped = f.view().contentDOM.classList.contains("cm-lineWrapping");
    fireEvent.click(screen.getByRole("switch", { name: "Soft-wrap" }));
    expect(screen.getByRole("switch", { name: "Soft-wrap" }).getAttribute("aria-checked")).toBe(String(!wasWrapped));
    expect(f.view().contentDOM.classList.contains("cm-lineWrapping")).toBe(!wasWrapped);
    fireEvent.click(screen.getByRole("button", { name: "Find in Logs" }));
    expect(screen.getByRole("textbox", { name: "Find" })).toBeTruthy();
  });

  it("starts a tab opened by plugin code by its key, with the toggles that are on", async () => {
    const f = setup({ view: "", key: "code", origin: "code" });
    expect(webPtyBackend).not.toHaveBeenCalled();
    expect(logTabPtyBackend).toHaveBeenLastCalledWith("probe", "code", []);
    await act(async () => {});
    fireEvent.click(screen.getByRole("switch", { name: "Verbose" }));
    await waitFor(() => expect(f.backend.kill).toHaveBeenCalledWith(42));
    expect(logTabPtyBackend).toHaveBeenLastCalledWith("probe", "code", ["verbose"]);
  });

  it("kills the previous process on toggle and every lifecycle boundary", async () => {
    for (const boundary of ["unmount", "disable", "project", "window"] as const) {
      const f = setup();
      await act(async () => {});
      fireEvent.click(screen.getByRole("switch", { name: "Verbose" }));
      await waitFor(() => expect(f.backend.kill).toHaveBeenCalledWith(42));
      expect(f.backend.spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ args: [...spec.args, "-v"] }),
        expect.any(Function),
      );
      vi.mocked(f.backend.kill).mockClear();
      act(() => {
        if (boundary === "unmount") f.rendered.unmount();
        if (boundary === "disable") usePlugins.setState({ plugins: [{ ...plugin, enabled: false }] });
        if (boundary === "project") useProject.setState({ project: { root: "/other" } as never });
        if (boundary === "window") window.dispatchEvent(new Event("pagehide"));
      });
      expect(f.backend.kill).toHaveBeenCalledWith(42);
      f.rendered.unmount();
    }
  });

  it("kills a spawn that resolves after its tab closes", async () => {
    const f = setup();
    let resolve!: (info: TerminalInfo) => void;
    vi.mocked(f.backend.spawn).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Verbose" }));
    f.rendered.unmount();
    await act(async () => resolve({ id: 99 } as TerminalInfo));
    expect(f.backend.kill).toHaveBeenCalledWith(99);
  });

  it("registers a transient tab that stays mounted when switching editors and has no dirty document", () => {
    const dispose = startViewUi(() => {});
    try {
      const kind = useContributions.getState().editorKinds.get("pluginLog")!;
      expect(kind.keepAlive).toBe(true);
      expect(kind.restorable).not.toBe(true);
      expect(kind.document).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
