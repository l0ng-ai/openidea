/**
 * Command lines that run with a run configuration rather than the shell, from Run Anything and
 * the terminal's Run Highlighted Command: `pytest …` / `python -m pytest …` with the project's
 * pytest setup (results in the test tree), `python -m <module> …` / `python <file>.py …` on the
 * project's interpreter, and `npm|pnpm|yarn|bun run <script> …` for a script of the package
 * the folder belongs to.
 */
import { executeAction } from "@/platform/actions";
import { parseArgs } from "@/platform/commandLine";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { RunAnythingProvider } from "@/workbench/contributions";
import { allClosest, implicitPythonTests, projectPython, PYTHON_KINDS } from "./context";
import { SHELL_SYNTAX } from "./packageBins";
import { systemPython } from "./pythonTypes";
import { useRun } from "./store";

export type CommandLine =
  | { kind: "pytest"; args: string[] }
  | { kind: "module"; module: string; args: string[] }
  | { kind: "script"; script: string; args: string[] }
  | { kind: "package"; runner: string; script: string; args: string[] };

const PYTHON = /^python(?:3(?:\.\d+)?)?$/;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_KINDS = new Set(["npm", "bun"]);

/** What `line` runs, or null for anything else (shell syntax included: pipes, `&&`, variables, globs…). */
export function parseCommandLine(line: string): CommandLine | null {
  if (SHELL_SYNTAX.test(line)) return null;
  const [head, ...rest] = parseArgs(line.trim());
  if (!head) return null;
  if (head === "pytest" || head === "py.test") return { kind: "pytest", args: rest };
  if (PYTHON.test(head)) {
    const [first, second, ...more] = rest;
    if (first === "-m" && second === "pytest") return { kind: "pytest", args: more };
    if (first === "-m" && second) return { kind: "module", module: second, args: more };
    // `python manage.py …` stays with Django's manage.py tasks.
    if (first?.endsWith(".py") && !/(?:^|\/)manage\.py$/.test(first))
      return { kind: "script", script: first, args: rest.slice(1) };
    return null;
  }
  if (RUNNERS.has(head) && rest[0] === "run" && rest[1])
    return {
      kind: "package",
      runner: head,
      script: rest[1],
      args: rest.slice(2),
    };
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
 * The configuration running `line` from the absolute folder `cwd` (the project root when
 * omitted), or null when it isn't one of these command lines or the folder is outside the project.
 */
export function commandLineConfig(
  line: string,
  cwd: string | undefined,
  root: string,
  configs: RunConfig[],
): RunConfig | null {
  const parsed = parseCommandLine(line);
  if (!parsed || !root) return null;
  const dir = cwd ?? root;
  const rel = dir === root ? "" : dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null;
  if (rel === null) return null;
  const named = { id: `command:${line.trim()}`, name: line.trim() };
  if (parsed.kind === "package") {
    const owners = allClosest(
      configs.filter((c) => NPM_KINDS.has(c.kind)),
      rel,
    );
    const owner = owners.find((c) => c.args[0] === "run" && c.args[1] === parsed.script);
    if (!owner) return null;
    return { ...owner, ...named, command: parsed.runner, args: ["run", parsed.script, ...parsed.args] };
  }
  const owners = allClosest(
    configs.filter((c) => PYTHON_KINDS.includes(c.kind)),
    rel,
  );
  const ownerDir = join(root, trimDir(owners[0]?.cwd));
  if (parsed.kind === "pytest") {
    const base = owners.find((c) => c.kind === "pytest") ?? implicitPythonTests(rel, configs, "pytest");
    const baseDir = join(root, trimDir(base.cwd));
    return {
      ...base,
      ...named,
      command: absoluteCommand(base.command, baseDir),
      args: [...base.args, ...parsed.args],
      cwd: dir,
    };
  }
  const py = projectPython(owners) ?? { command: systemPython(), prefix: [] };
  return {
    ...named,
    kind: "python",
    command: absoluteCommand(py.command, ownerDir),
    args: [...py.prefix, ...(parsed.kind === "module" ? ["-m", parsed.module] : [parsed.script]), ...parsed.args],
    cwd: dir,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "debugpy",
  };
}

const configFor = (line: string, cwd?: string) =>
  commandLineConfig(line, cwd, useProject.getState().project?.root ?? "", useRun.getState().configs);

export const commandLinesRunAnything: RunAnythingProvider = {
  id: "run.commandLines",
  group: "Commands",
  order: 22,
  items: () => [],
  accepts: (line, cwd) => !!configFor(line, cwd),
  execute(line, cwd) {
    const config = configFor(line, cwd);
    if (!config) return false;
    void executeAction("run.runConfig", config);
    return true;
  },
};
