import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sdk } from "@/bindings";
import { setLocale } from "@/platform/i18n";

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  createVenv: vi.fn(),
  hatchEnvs: vi.fn(),
  cancel: vi.fn(),
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
      sdkPythonHatchEnvs: mocks.hatchEnvs,
      sdkPythonInterpreter: mocks.interpreter,
      cancelRequest: mocks.cancel,
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
  mocks.hatchEnvs.mockResolvedValue(ok(["default", "docs"]));
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
  it("hides the Hatch environment type for projects without Hatch configuration", async () => {
    mocks.hatchEnvs.mockResolvedValue(ok([]));
    await act(async () => {
      open();
    });
    expect(mocks.hatchEnvs).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Hatch Environment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pipenv Environment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Virtualenv Environment" })).toBeInTheDocument();
  });

  it("translates the Pipenv and Hatch environment types", async () => {
    await setLocale("zh");
    try {
      open();
      expect(await screen.findByRole("button", { name: "Hatch 环境" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pipenv 环境" })).toBeInTheDocument();
    } finally {
      await act(() => setLocale("en"));
    }
  });

  it("lists the environment types PyCharm offers", async () => {
    open();
    await screen.findByRole("button", { name: "Hatch Environment" });
    for (const label of [
      "Virtualenv Environment",
      "Conda Environment",
      "uv Environment",
      "Poetry Environment",
      "Pipenv Environment",
      "Hatch Environment",
    ]) {
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
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
    await act(async () => finish(VENV));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("/project/.venv/bin/python"));
  });

  it("inherits the base interpreter's packages for venv and uv when asked", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.createVenv.mockImplementation(() => new Promise((r) => (finish = r)));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    const inherit = () => screen.queryByRole("checkbox", { name: "Inherit packages from base interpreter" });
    expect(inherit()).not.toBeChecked();
    fireEvent.click(inherit()!);
    for (const [label, tool] of [
      ["Virtualenv Environment", "venv"],
      ["uv Environment", "uv"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(mocks.createVenv).toHaveBeenLastCalledWith(
        tool,
        "/usr/bin/python3",
        "/project/.venv",
        false,
        true,
        expect.anything(),
        expect.anything(),
      );
      // oxlint-disable-next-line no-await-in-loop -- the dialog must settle from the previous tool before the next tool is clicked
      await act(async () => finish(ok(VENV)));
    }
    // Conda builds a fresh environment: the option is neither shown nor passed.
    fireEvent.click(screen.getByRole("button", { name: "Conda Environment" }));
    expect(inherit()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenLastCalledWith(
      "conda",
      "/usr/bin/python3",
      "project",
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes each tool and Poetry hides the location field", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.createVenv.mockImplementation(() => new Promise((r) => (finish = r)));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    // Conda asks for a name (the project's by default) and keeps the env in its envs directory.
    for (const [label, tool, target] of [
      ["uv Environment", "uv", "/project/.venv"],
      ["Conda Environment", "conda", "project"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(mocks.createVenv).toHaveBeenLastCalledWith(
        tool,
        "/usr/bin/python3",
        target,
        false,
        false,
        expect.anything(),
        expect.anything(),
      );
      // oxlint-disable-next-line no-await-in-loop -- the dialog must settle from the previous tool before the next tool is clicked
      await act(async () => finish(ok(VENV)));
    }
    fireEvent.change(screen.getByLabelText("Name:"), { target: { value: " ds " } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenLastCalledWith(
      "conda",
      "/usr/bin/python3",
      "ds",
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
    await act(async () => finish(ok(VENV)));
    fireEvent.click(screen.getByRole("button", { name: "Poetry Environment" }));
    await waitFor(() => expect(screen.getByLabelText("Location:")).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenLastCalledWith(
      "poetry",
      "/usr/bin/python3",
      "/project/.venv",
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
    await act(async () => finish(ok(VENV)));
    // Pipenv keeps its own location too, and installs the Pipfile's packages unless told not to.
    // A location typed for another tool does not move it out of the project.
    fireEvent.click(screen.getByRole("button", { name: "Virtualenv Environment" }));
    fireEvent.change(screen.getByLabelText("Location:"), { target: { value: "/elsewhere/env" } });
    fireEvent.click(screen.getByRole("button", { name: "Pipenv Environment" }));
    await waitFor(() => expect(screen.getByLabelText("Location:")).toBeDisabled());
    expect(screen.getByLabelText("Location:")).toHaveValue("/project/.venv");
    for (const install of [true, false]) {
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(mocks.createVenv).toHaveBeenLastCalledWith(
        "pipenv",
        "/usr/bin/python3",
        "/project/.venv",
        install,
        false,
        expect.anything(),
        expect.anything(),
      );
      // oxlint-disable-next-line no-await-in-loop -- the checkbox is toggled between iterations, so each confirmation must settle first
      await act(async () => finish(ok(VENV)));
      fireEvent.click(screen.getByRole("checkbox", { name: "Install packages from Pipfile" }));
    }
  });

  it("creates the Hatch environment picked from the project's own", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.createVenv.mockImplementation(() => new Promise((r) => (finish = r)));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("button", { name: "Hatch Environment" }));
    // Hatch decides where the environment goes: its name travels as `<project>/<name>`.
    await waitFor(() => expect(screen.getByRole("button", { name: "Hatch environment" })).toHaveTextContent("default"));
    expect(screen.queryByLabelText("Location:")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenLastCalledWith(
      "hatch",
      "/usr/bin/python3",
      "/project/default",
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
    await act(async () => finish(ok(VENV)));
    fireEvent.click(screen.getByRole("button", { name: "Hatch environment" }));
    fireEvent.click(await screen.findByRole("option", { name: "docs" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.createVenv).toHaveBeenLastCalledWith(
      "hatch",
      "/usr/bin/python3",
      "/project/docs",
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
  });

  it("stops listing Hatch environments when the dialog closes", async () => {
    mocks.hatchEnvs.mockReturnValue(new Promise(() => {}));
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    await waitFor(() => expect(mocks.hatchEnvs).toHaveBeenCalled());
    const [request] = mocks.hatchEnvs.mock.calls[0] as [unknown];
    expect(mocks.cancel).not.toHaveBeenCalled();
    cleanup();
    expect(mocks.cancel).toHaveBeenCalledWith(request);
  });

  it("says that Hatch is missing instead of offering to create", async () => {
    mocks.hatchEnvs.mockResolvedValue({
      status: "error",
      error: { kind: "unavailable", message: "Hatch is not installed (install it from https://hatch.pypa.io)" },
    });
    open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("button", { name: "Hatch Environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hatch is not installed");
    expect(screen.getByRole("button", { name: "Hatch environment" })).toHaveTextContent("No environments");
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
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
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("/project/.venv/bin/python"));
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
    mocks.choosePath.mockResolvedValue("/opt/pyenv/erp19py3.12");
    const onAdded = open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Base interpreter" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("/opt/pyenv/erp19py3.12/bin/python"));
    expect(mocks.interpreter).toHaveBeenNthCalledWith(1, "/opt/pyenv/erp19py3.12");
    expect(mocks.interpreter).toHaveBeenNthCalledWith(2, OUTSIDE.path);
    await waitFor(() => expect(useSdks.getState().byKind.python?.some((s) => s.path === OUTSIDE.path)).toBe(true));
  });

  it.each([
    ["/project/.venv", "/project/.venv/bin/python"],
    ["C:\\project\\.venv", "C:\\project\\.venv\\Scripts\\python.exe"],
  ])("waits for validation and resolves the folder %s", async (folder, executable) => {
    let finish!: (value: ReturnType<typeof ok<Sdk>>) => void;
    mocks.interpreter.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mocks.detect.mockResolvedValue(ok([SYSTEM]));
    mocks.choosePath.mockResolvedValue(folder);
    const onAdded = open();
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(mocks.interpreter).toHaveBeenCalledWith(folder));
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    expect(mocks.choosePath).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Select Python Environment Folder",
      defaultPath: "/project",
    });
    expect(screen.getByRole("status", { name: "Checking interpreter" })).toBeInTheDocument();
    await act(async () => finish(ok({ ...VENV, path: executable })));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Interpreter:");
    expect(select).toHaveTextContent(`Python 3.12 (.venv) — ${executable}`);
    expect(onAdded).not.toHaveBeenCalled();
    expect(useSdks.getState().byKind.python?.some((s) => s.path === executable && s.source === "venv")).toBe(false);
    mocks.interpreter.mockResolvedValue(ok({ ...VENV, path: executable }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(executable));
  });

  it.each(["/project/.venv/bin/python", "C:\\project\\.venv\\Scripts\\python.exe"])(
    "preserves the detected interpreter path %s when validating",
    async (path) => {
      mocks.detect.mockResolvedValue(ok([{ ...VENV, path }]));
      mocks.interpreter.mockResolvedValue(ok({ ...VENV, path }));
      const onAdded = open();
      fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
      fireEvent.click(screen.getByRole("button", { name: "Interpreter" }));
      fireEvent.click(await screen.findByRole("option", { name: /Python 3\.12 \(\.venv\)/ }));
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      await waitFor(() => expect(onAdded).toHaveBeenCalledWith(path));
      expect(mocks.interpreter).toHaveBeenCalledWith(path);
      expect(mocks.choosePath).not.toHaveBeenCalled();
    },
  );

  it("ignores a validation result after cancelling", async () => {
    let finish!: (value: ReturnType<typeof ok<Sdk>>) => void;
    mocks.interpreter.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mocks.choosePath.mockResolvedValue(VENV.path);
    const onAdded = open();
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(mocks.interpreter).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => finish(ok(VENV)));
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Interpreter" })).toHaveTextContent("Select an interpreter");
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  });

  it("keeps the newly remembered interpreter when a pending scan finishes", async () => {
    let finish!: (value: ReturnType<typeof ok<Sdk[]>>) => void;
    mocks.detect.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mocks.interpreter.mockResolvedValue(ok(VENV));
    mocks.choosePath.mockResolvedValue(VENV.path);
    const onAdded = open();
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Interpreter" })).toHaveTextContent(VENV.path));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(VENV.path));
    await act(async () => finish(ok([SYSTEM])));
    expect(useSdks.getState().byKind.python?.some((s) => s.path === VENV.path)).toBe(true);
    expect(useSdks.getState().byKind.python?.some((s) => s.path === SYSTEM.path)).toBe(true);
  });

  it.each(["unusable", "failed"])("keeps an %s interpreter out of the project and shows an error", async (result) => {
    mocks.interpreter.mockImplementation(() =>
      result === "unusable" ? Promise.resolve(ok(null)) : Promise.reject(new Error("Cannot probe interpreter")),
    );
    mocks.choosePath.mockResolvedValue("/broken/bin/python");
    const onAdded = open();
    fireEvent.click(screen.getByRole("radio", { name: "Existing environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      result === "unusable" ? "Cannot run this Python interpreter" : "Cannot probe interpreter",
    );
    expect(onAdded).not.toHaveBeenCalled();
    expect(useSdks.getState().byKind.python?.some((s) => s.path === "/broken/bin/python")).toBe(false);
  });
});
