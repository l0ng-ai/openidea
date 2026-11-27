import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  detect: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      sdkDetect: (kind: string) => Promise.resolve({ status: "ok", data: ipc.detect(kind) }),
      sdkPythonInterpreter: (path: string) => Promise.resolve({ status: "ok", data: ipc.probe(path) }),
    },
  };
});

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { ConfigForm } from "./ConfigForm";
import {
  chooseInterpreter,
  CUSTOM_INTERPRETER,
  interpreterChoice,
  interpreterOptions,
  pythonType,
} from "./pythonTypes";
import { formParams, newConfigOfType, withParams } from "./types";

const VENV = "/work/app/.venv/bin/python";
const PYPY = "/opt/pypy/bin/pypy3";
const sdk = (path: string, name: string) => ({ path, name, version: null, source: "venv", home: null, extra: null });

afterEach(() => {
  cleanup();
  useProject.setState({ settings: null } as never);
  ipc.detect.mockReset();
  ipc.probe.mockReset();
});

describe("Python run configuration interpreter", () => {
  it("opens configurations made before the dropdown with the choice their command means", () => {
    expect(interpreterChoice({ command: "python3" })).toBe("");
    expect(interpreterChoice({ command: "python.exe" })).toBe("");
    expect(interpreterChoice({})).toBe("");
    expect(interpreterChoice({ command: VENV })).toBe(VENV);
    expect(interpreterChoice({ command: "C:\\envs\\app\\Scripts\\python.exe" })).toBe(
      "C:\\envs\\app\\Scripts\\python.exe",
    );
    // A runner, a relative path or another executable keeps its command.
    expect(interpreterChoice({ command: "uv" })).toBe(CUSTOM_INTERPRETER);
    expect(interpreterChoice({ command: ".venv/bin/python" })).toBe(CUSTOM_INTERPRETER);
    expect(interpreterChoice({ command: "/usr/local/bin/uv" })).toBe(CUSTOM_INTERPRETER);
  });

  it("stores the chosen interpreter's path as the command, so the command line is the same as typing it", () => {
    const python = pythonType;
    const before = { mode: "script", script: "main.py", runnerArgs: "-u", command: "uv" };
    const picked = chooseInterpreter(PYPY, before);
    expect(picked).toEqual({ ...before, interpreter: PYPY, command: PYPY });
    // Not named `python…`: the recorded choice keeps it selected.
    expect(interpreterChoice(picked)).toBe(PYPY);
    expect(python.commandLine(picked)).toEqual({ command: PYPY, args: ["-u", "main.py"] });

    const custom = chooseInterpreter(CUSTOM_INTERPRETER, picked);
    expect(interpreterChoice(custom)).toBe(CUSTOM_INTERPRETER);
    // Typing an interpreter's path as the custom command keeps the Custom command choice.
    expect(interpreterChoice({ ...custom, command: VENV })).toBe(CUSTOM_INTERPRETER);

    const fallback = chooseInterpreter("", { ...custom, command: "uv" });
    expect(fallback).not.toHaveProperty("interpreter");
    expect(interpreterChoice(fallback)).toBe("");
    expect(python.commandLine(fallback)?.command).toMatch(/^python3?$/);
  });

  it("leaves the command line of an existing configuration unchanged", () => {
    const python = pythonType;
    for (const command of ["python", "python3", ".venv/bin/python", VENV, "uv"]) {
      const config: RunConfig = { ...newConfigOfType(python, []), command, args: ["main.py"], params: undefined };
      const params = formParams(config, python)!;
      expect(python.commandLine(params)).toEqual({ command, args: ["main.py"] });
    }
  });

  it("lists detected interpreters, minus removed ones, and marks a chosen one that is gone", async () => {
    useProject.setState({ settings: { languages: { python: { hiddenInterpreters: ["/usr/bin/python3"] } } } } as never);
    ipc.detect.mockReturnValue([sdk(VENV, "Python 3.12 (app)"), sdk("/usr/bin/python3", "Python 3.9")]);
    ipc.probe.mockImplementation((path: string) => (path === PYPY ? sdk(PYPY, "PyPy 3.10") : null));
    expect(await interpreterOptions("")).toEqual([{ value: VENV, label: "Python 3.12 (app)", detail: VENV }]);
    expect((await interpreterOptions(PYPY)).at(-1)).toEqual({ value: PYPY, label: "PyPy 3.10", detail: PYPY });
    expect((await interpreterOptions("/gone/bin/python")).at(-1)).toMatchObject({
      value: "/gone/bin/python",
      label: "/gone/bin/python (not found)",
    });
  });

  it("offers no local interpreter when the project interpreter is a run target's", async () => {
    useProject.setState({ settings: { languages: { python: { interpreter: "target:docker-app" } } } } as never);
    ipc.detect.mockReturnValue([sdk(VENV, "Python 3.12 (app)")]);
    expect(await interpreterOptions(VENV)).toEqual([]);
  });

  it("shows the Command field only for Custom command", async () => {
    ipc.detect.mockReturnValue([sdk(VENV, "Python 3.12 (app)")]);
    const type = pythonType;
    const base = newConfigOfType(type, []);
    const config = withParams(base, { ...base.params, script: "main.py", command: "uv", runnerArgs: "run python" });
    const changed = vi.fn();
    render(<ConfigForm config={config} all={[config]} type={type} errors={{}} onChange={changed} modifyRequest={0} />);
    expect(screen.getByRole("button", { name: "Interpreter" })).toHaveTextContent("Custom command");
    expect(screen.getByRole("textbox", { name: "Command" })).toHaveValue("uv");

    fireEvent.click(screen.getByRole("button", { name: "Interpreter" }));
    fireEvent.click(await screen.findByRole("option", { name: /Python 3\.12 \(app\)/ }));
    const next = changed.mock.lastCall![0] as RunConfig;
    expect(next).toMatchObject({ command: VENV, args: ["run", "python", "main.py"] });
    cleanup();

    render(<ConfigForm config={next} all={[next]} type={type} errors={{}} onChange={changed} modifyRequest={0} />);
    // Named once the detected interpreters are in.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Interpreter" })).toHaveTextContent("Python 3.12 (app)"),
    );
    expect(screen.queryByRole("textbox", { name: "Command" })).toBeNull();
  });
});
