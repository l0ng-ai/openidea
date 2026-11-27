/**
 * Python (PyCharm's "Python" configuration): a script or a `-m` module with its
 * arguments. The command is the interpreter (`python3`, `.venv/bin/python`, `uv`),
 * the runner args its leading arguments (`run python` for uv / poetry, `-u`). A plain
 * `python` / `python3` runs on the project interpreter: the backend swaps it at launch.
 */
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { isWindows } from "./jvmTypes";

/** `python` on Windows (where `python3` is not a command), `python3` elsewhere. */
export const systemPython = () => (isWindows() ? "python" : "python3");

export const pythonType: RunConfigTypeContribution = {
  id: "python",
  label: "Python",
  icon: "file-python",
  description: "Run a Python script or module",
  // A getter: the host's OS is known only once the project is open.
  get defaults() {
    return { mode: "script", command: systemPython() };
  },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "mode",
      label: "Execute",
      control: "select",
      options: [
        { value: "script", label: "Script file" },
        { value: "module", label: "Module" },
      ],
    },
    {
      key: "script",
      label: "Script path",
      mono: true,
      required: true,
      browse: "file",
      placeholder: "main.py",
      visible: (p) => p.mode !== "module",
    },
    {
      key: "module",
      label: "Module",
      mono: true,
      required: true,
      placeholder: "uvicorn",
      visible: (p) => p.mode === "module",
    },
    { key: "args", label: "Arguments", mono: true, placeholder: "Space separated; quote with ' or \"" },
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "python3",
      required: true,
      hint: "e.g. python3, .venv/bin/python, uv, poetry",
    },
    {
      key: "runnerArgs",
      label: "Runner arguments",
      mono: true,
      placeholder: "run python",
      hint: "e.g. `run python` for uv/poetry; empty calls the interpreter itself",
    },
  ],
  commandLine(p) {
    const module = p.mode === "module";
    const target = (module ? p.module : p.script)?.trim();
    const program = !target ? [] : module ? ["-m", target] : [target];
    return {
      command: p.command?.trim() || systemPython(),
      args: [...parseArgs(p.runnerArgs ?? ""), ...program, ...parseArgs(p.args ?? "")],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "python") return null;
    // The program starts at `-m` or the script; what precedes it belongs to the interpreter.
    const at = c.args.findIndex((a) => a === "-m" || /\.pyw?$/.test(a));
    if (at < 0) return null;
    const module = c.args[at] === "-m";
    const target = c.args[module ? at + 1 : at];
    if (!target) return null;
    return {
      mode: module ? "module" : "script",
      [module ? "module" : "script"]: target,
      args: formatArgs(c.args.slice(at + (module ? 2 : 1))),
      command: c.command,
      runnerArgs: formatArgs(c.args.slice(0, at)),
    };
  },
};

/**
 * Python unittest (PyCharm's "Python tests › Unittests"): `python -m unittest` with a target
 * (dotted test names, a file, or `discover -s <folder>`) and further options. The command is the
 * interpreter, the runner args its leading arguments (`run python` for uv / poetry).
 */
export const unittestType: RunConfigTypeContribution = {
  id: "unittest",
  label: "Python unittest",
  icon: "file-python",
  description: "Run Python tests with python -m unittest",
  get defaults() {
    return { command: systemPython() };
  },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "target",
      label: "Target",
      mono: true,
      placeholder: "tests.test_models",
      hint: "Modules, classes or tests (tests.test_models.ModelTests.test_save), a file, or discover -s <folder>; empty discovers every test",
    },
    { key: "options", label: "Options", mono: true, placeholder: "e.g. -f --locals" },
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "python3",
      required: true,
      hint: "e.g. python3, .venv/bin/python, uv, poetry",
    },
    {
      key: "runnerArgs",
      label: "Runner arguments",
      mono: true,
      placeholder: "run python",
      hint: "e.g. `run python` for uv/poetry; empty calls the interpreter itself",
    },
  ],
  commandLine(p) {
    return {
      command: p.command?.trim() || systemPython(),
      args: [
        ...parseArgs(p.runnerArgs ?? ""),
        "-m",
        "unittest",
        ...parseArgs(p.target ?? ""),
        ...parseArgs(p.options ?? ""),
      ],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "unittest") return null;
    const at = c.args.findIndex((a, i) => a === "-m" && c.args[i + 1] === "unittest");
    if (at < 0) return null;
    const rest = c.args.slice(at + 2);
    // `discover` takes its own options: all of it is the target.
    const n = rest[0] === "discover" ? rest.length : rest.findIndex((a) => a.startsWith("-"));
    const end = n < 0 ? rest.length : n;
    return {
      command: c.command,
      runnerArgs: formatArgs(c.args.slice(0, at)),
      target: formatArgs(rest.slice(0, end)),
      options: formatArgs(rest.slice(end)),
    };
  },
};
