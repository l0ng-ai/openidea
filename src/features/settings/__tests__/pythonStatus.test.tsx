import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import type { ProjectInfo, Sdk } from "@/bindings";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  files: vi.fn(),
  effective: vi.fn(),
  detect: vi.fn(),
  set: vi.fn(),
  component: null as React.ComponentType | null,
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  isTauri: () => true,
  onIdeEvent: () => () => {},
  commands: {
    findFiles: mocks.files,
    sdkPythonEffective: mocks.effective,
    sdkDetect: mocks.detect,
    settingsSet: mocks.set,
  },
}));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: mocks.notify }),
  registerStatusItem: (item: { component: React.ComponentType }) => {
    mocks.component = item.component;
    return () => {};
  },
}));
import { activatePythonStatus, interpreterChoices, isPythonPath } from "../languages/PythonStatus";

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.mockResolvedValue([]);
  mocks.effective.mockResolvedValue(null);
  mocks.detect.mockResolvedValue([]);
  mocks.set.mockResolvedValue({ languages: { python: { interpreter: "/new/python" } } });
  useProject.setState({ project: { root: "/project" } as ProjectInfo, settings: null });
  setContext("projectOpen", true);
  dispose = activatePythonStatus();
});
afterEach(() => {
  cleanup();
  dispose();
});

const mount = () => {
  const Component = mocks.component!;
  return render(<Component />);
};

describe("Python interpreter status", () => {
  it.each([
    "src/main.py",
    "types/lib.pyi",
    "C:\\app\\main.pyw",
    "pyproject.toml",
    "requirements-dev.txt",
    "SConstruct",
  ])("recognizes %s", (path) => expect(isPythonPath(path)).toBe(true));
  it.each(["main.ts", "python.md", "pyproject.toml.bak", "copy.py.json"])("rejects %s", (path) =>
    expect(isPythonPath(path)).toBe(false),
  );
  it("keeps custom interpreters and deduplicates detected paths", () => {
    const sdk = { path: "/python", name: "Python 3.12" } as Sdk;
    expect(interpreterChoices([sdk, sdk], "/custom")).toEqual([sdk, { path: "/custom", name: "/custom" }]);
  });
  it("hides for non-Python projects without probing SDKs", async () => {
    mount();
    await waitFor(() => expect(mocks.files).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.detect).not.toHaveBeenCalled();
  });
  it("shows a warning for Python files without an interpreter", async () => {
    mocks.files.mockResolvedValue([{ path: "/project/src/main.py" }]);
    mount();
    expect(await screen.findByText("No interpreter")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Python Interpreter: No interpreter" });
    expect(button.querySelector("svg")).toBeTruthy();
  });
  it("shows the paths of interpreters that share a name", async () => {
    mocks.files.mockResolvedValue([{ path: "/project/main.py" }]);
    mocks.effective.mockResolvedValue("/usr/local/bin/python3.11");
    mocks.detect.mockResolvedValue([
      { path: "/usr/local/bin/python3.11", name: "Python 3.11" },
      { path: "/opt/homebrew/bin/python3.11", name: "Python 3.11" },
      { path: "/venv/bin/python", name: "Python 3.12 (.venv)" },
    ]);
    mount();
    await screen.findByRole("button", { name: "Python Interpreter: Python 3.11" });
    await act(() => executeAction("python.interpreterPopup"));
    expect(await screen.findByText("/opt/homebrew/bin/python3.11")).toBeTruthy();
    expect(screen.getByText("/usr/local/bin/python3.11")).toBeTruthy();
    expect(screen.queryByText("/venv/bin/python")).toBeNull();
  });
  it("opens the Python page when the widget is hidden", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "file.settings", title: "Settings…", run });
    mount();
    await waitFor(() => expect(mocks.files).toHaveBeenCalled());
    await executeAction("python.interpreterPopup");
    expect(run.mock.calls.map(([ctx]) => ctx.arg)).toEqual(["python.interpreter"]);
    off();
  });
  it("shows the effective SDK name and hides old state on project change", async () => {
    mocks.files.mockResolvedValue([{ path: "/project/pyproject.toml" }]);
    mocks.effective.mockResolvedValue("/venv/python");
    mocks.detect.mockResolvedValue([{ path: "/venv/python", name: "Python 3.12 (.venv)" }]);
    mount();
    expect(await screen.findByText("Python 3.12 (.venv)")).toBeTruthy();
    mocks.files.mockResolvedValue([]);
    act(() => useProject.setState({ project: { root: "/other" } as ProjectInfo }));
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("writes the project setting through the same backend path as Settings", async () => {
    await executeAction("python.selectInterpreter", "/new/python");
    expect(mocks.set).toHaveBeenCalledWith("project", "languages.python.interpreter", '"/new/python"');
    expect(useProject.getState().settings?.languages?.python?.interpreter).toBe("/new/python");
  });
  it("reports write failures without changing the selected interpreter", async () => {
    mocks.set.mockRejectedValueOnce(new Error("write failed"));
    await executeAction("python.selectInterpreter", "/new/python");
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    expect(useProject.getState().settings).toBeNull();
  });
  it("discards discovery completing after a project switch", async () => {
    mocks.files.mockResolvedValue([{ path: "/project/main.py" }]);
    let finish!: (sdks: Sdk[]) => void;
    mocks.detect.mockReturnValueOnce(
      new Promise<Sdk[]>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.effective.mockResolvedValue("/old/python");
    mount();
    await waitFor(() => expect(mocks.detect).toHaveBeenCalled());
    mocks.files.mockResolvedValue([]);
    act(() => useProject.setState({ project: { root: "/other" } as ProjectInfo }));
    await act(async () => finish([{ path: "/old/python", name: "Python 3.12" } as Sdk]));
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("opens the Python page for both settings entries", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "file.settings", title: "Settings…", run });
    await executeAction("python.addInterpreter");
    await executeAction("python.interpreterSettings");
    expect(run.mock.calls.map(([ctx]) => ctx.arg)).toEqual(["python.interpreter", "python.interpreter"]);
    off();
  });
});
