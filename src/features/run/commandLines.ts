/**
 * Command lines that run with a run configuration rather than the shell, from Run Anything and
 * the terminal's Run Highlighted Command: `pytest …` / `python -m pytest …` with the project's
 * pytest setup (results in the test tree), `python -m <module> …` / `python <file>.py …` on the
 * project's interpreter (a terminal's active environment first), and `npm|pnpm|yarn|bun run
 * <script> …` for a script of the package the folder belongs to.
 */
import { executeAction } from "@/platform/actions";
import { activePython, parseArgs } from "@/platform/commandLine";
import type { RunConfig } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import type { RunAnythingProvider, TerminalCommandContext } from "@/workbench/contributions";
import { allClosest, implicitPythonTests, projectPython, PYTHON_KINDS } from "./context";
import { SHELL_SYNTAX } from "./packageBins";
import { systemPython } from "./pythonTypes";
import { useRun } from "./store";

export type CommandLine =
  | { kind: "pytest"; args: string[] }
  | { kind: "module"; module: string; args: string[] }
  | { kind: "script"; script: string; args: string[] }
  | { kind: "package"; runner: string; script: string; args: string[] };

/** `python` / `python3`: a versioned name (`python3.11`) may not be the project's interpreter, so the shell runs it. */
const PYTHON = /^python3?$/;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_KINDS = new Set(["npm", "bun"]);

/**
 * What `line` runs, or null for anything else (shell syntax included: pipes, `&&`, variables, globs…).
 * `windowsPaths`: backslashes are path separators (cmd.exe), not escapes (a POSIX shell).
 */
export function parseCommandLine(line: string, windowsPaths = false): CommandLine | null {
  if (SHELL_SYNTAX.test(line)) return null;
  const [head, ...rest] = parseArgs(line.trim(), windowsPaths);
  if (!head) return null;
  if (head === "pytest" || head === "py.test") return { kind: "pytest", args: rest };
  if (PYTHON.test(head)) {
    const [first, second, ...more] = rest;
    if (first === "-m" && second === "pytest") return { kind: "pytest", args: more };
    if (first === "-m" && second) return { kind: "module", module: second, args: more };
    // `python manage.py …` stays with Django's manage.py tasks.
    if (first?.endsWith(".py") && !/(?:^|[\\/])manage\.py$/.test(first))
      return { kind: "script", script: first, args: rest.slice(1) };
    return null;
  }
  if (RUNNERS.has(head) && rest[0] === "run" && rest[1])
    return { kind: "package", runner: head, script: rest[1], args: rest.slice(2) };
  return null;
}

const trimDir = (dir: string | null | undefined) => (dir ?? "").replace(/^\.(?:\/|$)/, "").replace(/\/+$/, "");
const join = (dir: string, path: string) => (path ? `${dir.replace(/\/+$/, "")}/${path}` : dir);
const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/** A configuration's relative program (`.venv/bin/pytest`) made absolute, so it runs from another folder. */
function absoluteCommand(command: string, dir: string): string {
  return /[\\/]/.test(command) && !isAbsolute(command) ? join(dir, command) : command;
}

/**
 * The configuration running `line`, or null when it isn't one of these command lines. A line
 * typed in a `terminal` runs from its folder (null outside the project) and, when its shell has
 * a Python environment active, with that interpreter; Python lines need that or a Python project.
 */
export function commandLineConfig(
  line: string,
  terminal: TerminalCommandContext | undefined,
  root: string,
  configs: RunConfig[],
  windows: boolean,
): RunConfig | null {
  const parsed = parseCommandLine(line, windows && !terminal);
  if (!parsed || !root) return null;
  const dir = terminal?.cwd ?? root;
  const rel = dir === root ? "" : dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null;
  if (rel === null) return null;
  const named = { id: `command:${line.trim()}`, name: line.trim() };
  // What the shell would run with: its `PATH` (version-manager shims, an activated environment)
  // and Python environment. Not a Windows POSIX shell's (Git Bash) `PATH`: native processes can't read it.
  const env = Object.fromEntries(
    [...(windows ? [] : ["PATH"]), "VIRTUAL_ENV", "CONDA_PREFIX"].flatMap((k) =>
      terminal?.env[k] ? [[k, terminal.env[k]]] : [],
    ),
  );
  if (parsed.kind === "package") {
    const owners = allClosest(
      configs.filter((c) => NPM_KINDS.has(c.kind)),
      rel,
    );
    const owner = owners.find((c) => c.args[0] === "run" && c.args[1] === parsed.script);
    if (!owner) return null;
    return {
      ...owner,
      ...named,
      command: parsed.runner,
      args: ["run", parsed.script, ...parsed.args],
      env: { ...owner.env, ...env },
    };
  }
  const owners = allClosest(
    configs.filter((c) => PYTHON_KINDS.includes(c.kind)),
    rel,
  );
  const active = terminal ? activePython(terminal.env, windows) : null;
  if (!owners.length && !active) return null;
  if (parsed.kind === "pytest") {
    const base = owners.find((c) => c.kind === "pytest") ?? implicitPythonTests(rel, configs, "pytest");
    const program = active
      ? { command: active, args: ["-m", "pytest"] }
      : { command: absoluteCommand(base.command, join(root, trimDir(base.cwd))), args: base.args };
    return {
      ...base,
      ...named,
      ...program,
      args: [...program.args, ...parsed.args],
      cwd: dir,
      env: { ...base.env, ...env },
    };
  }
  const py = active
    ? { command: active, prefix: [] }
    : (projectPython(owners) ?? { command: systemPython(), prefix: [] });
  return {
    ...named,
    kind: "python",
    command: absoluteCommand(py.command, join(root, trimDir(owners[0]?.cwd))),
    args: [...py.prefix, ...(parsed.kind === "module" ? ["-m", parsed.module] : [parsed.script]), ...parsed.args],
    cwd: dir,
    env,
    detected: false,
    isTest: false,
    debugAdapter: "debugpy",
  };
}

const configFor = (line: string, terminal?: TerminalCommandContext) =>
  commandLineConfig(
    line,
    terminal,
    useProject.getState().project?.root ?? "",
    useRun.getState().configs,
    usePlatform.getState().os === "windows",
  );

export const commandLinesRunAnything: RunAnythingProvider = {
  id: "run.commandLines",
  group: "Commands",
  order: 22,
  items: () => [],
  accepts: (line, terminal) => !!configFor(line, terminal),
  execute(line, terminal) {
    const config = configFor(line, terminal);
    if (!config) return false;
    void executeAction("run.runConfig", config);
    return true;
  },
};
