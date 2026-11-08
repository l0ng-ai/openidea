import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sdk } from "@/bindings";

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  createVenv: vi.fn(),
  interpreter: vi.fn(),
  choosePath: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      sdkDetect: mocks.detect,
      sdkPythonCreateVenv: mocks.createVenv,
      sdkPythonInterpreter: mocks.interpreter,
      cancelRequest: vi.fn(),
    },
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.choosePath }));

const { AddInterpreterDialog } = await import("../languages/AddInterpreterDialog");
const { useSdks } = await import("../languages/api");

const SYSTEM: Sdk = {
  path: "/usr/bin/python3",
  name: "Python 3.12",
  version: "3.12.0",
  source: "system",
  home: "/usr",
  extra: null,
};
const VENV: Sdk = {
  path: "/project/.venv/bin/python",
  name: "Python 3.12 (.venv)",
  version: "3.12.0",
  source: "venv",
  home: "/project/.venv",
  extra: null,
};

const ok = <T,>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 1 } });
  mocks.detect.mockResolvedValue(ok([VENV, SYSTEM]));
  mocks.createVenv.mockResolvedValue(new Promise(() => {}));
  mocks.interpreter.mockResolvedValue(ok(null));
  useSdks.setState({ byKind: {}, loading: {}, errors: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = (onAdded = vi.fn()) => {
  render(<AddInterpreterDialog root="/project" onClose={() => {}} onAdded={onAdded} />);
  return onAdded;
};

describe("Add Python Interpreter", () => {
  it("lists the environment types PyCharm offers", async () => {
    open();
    await waitFor(() => expect(mocks.detect).toHaveBeenCalled());
    for (const label of ["Virtualenv Environment", "Conda Environment", "uv Environment", "Poetry Environment"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("creates a virtualenv with the base interpreter by default", async () => {
    let finish: (sdk: Sdk) => void = () => {};
    mocks.createVenv.mockReturnValue(new Promise((r) => (finish = (s) => r(ok(s)))));
    const onAdded = open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenCalledWith(
      "venv",
      "/usr/bin/python3",
      "/project/.venv",
      expect.anything(),
      expect.anything(),
    );
    await act(async () => finish(VENV));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("/project/.venv/bin/python"));
  });

  it("passes each tool and Poetry hides the location field", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.createVenv.mockImplementation(() => new Promise((r) => (finish = r)));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    for (const [label, tool] of [
      ["uv Environment", "uv"],
      ["Conda Environment", "conda"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(mocks.createVenv).toHaveBeenLastCalledWith(
        tool,
        "/usr/bin/python3",
        "/project/.venv",
        expect.anything(),
        expect.anything(),
      );
      await act(async () => finish(ok(VENV)));
    }
    fireEvent.click(screen.getByRole("button", { name: "Poetry Environment" }));
    await waitFor(() => expect(screen.getByLabelText("Location:")).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenLastCalledWith(
      "poetry",
      "/usr/bin/python3",
      "/project/.venv",
      expect.anything(),
      expect.anything(),
    );
  });

  it("adds an existing interpreter without creating anything", async () => {
    mocks.interpreter.mockResolvedValue(ok(VENV));
    const onAdded = open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Interpreter" }));
    fireEvent.click(await screen.findByRole("option", { name: /Python 3\.12 \(\.venv\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).not.toHaveBeenCalled();
    expect(onAdded).toHaveBeenCalledWith("/project/.venv/bin/python");
    expect(mocks.interpreter).toHaveBeenCalledWith("/project/.venv/bin/python");
    await waitFor(() =>
      expect(useSdks.getState().byKind.python?.some((s) => s.path === "/project/.venv/bin/python")).toBe(true),
    );
  });

  it("registers a virtualenv picked from outside detection", async () => {
    const OUTSIDE: Sdk = {
      path: "/opt/pyenv/erp19py3.12/bin/python",
      name: "Python 3.12 (erp19py3.12)",
      version: "3.12.1",
      source: "venv",
      home: "/opt/pyenv/erp19py3.12",
      extra: null,
    };
    mocks.interpreter.mockResolvedValue(ok(OUTSIDE));
    mocks.choosePath.mockResolvedValue("/opt/pyenv/erp19py3.12/bin/python");
    const onAdded = open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onAdded).toHaveBeenCalledWith("/opt/pyenv/erp19py3.12/bin/python");
    expect(mocks.interpreter).toHaveBeenCalledWith("/opt/pyenv/erp19py3.12/bin/python");
    await waitFor(() => expect(useSdks.getState().byKind.python?.some((s) => s.path === OUTSIDE.path)).toBe(true));
  });
});
