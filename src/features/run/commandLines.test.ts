import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { commandLineConfig, parseCommandLine } from "./commandLines";

const config = (patch: Partial<RunConfig>): RunConfig => ({
  id: "x",
  name: "x",
  kind: "python",
  command: "python3",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...patch,
});

const CONFIGS = [
  config({ id: "pytest", name: "pytest", kind: "pytest", command: ".venv/bin/pytest", cwd: "api", isTest: true }),
  config({ id: "python:module:api", kind: "python", command: ".venv/bin/python", args: ["-m", "api"], cwd: "api" }),
  config({ id: "npm:dev", kind: "npm", command: "pnpm", args: ["run", "dev"], cwd: "web" }),
  config({ id: "npm:test", kind: "npm", command: "pnpm", args: ["run", "test"], cwd: "web", isTest: true }),
];

describe("parseCommandLine", () => {
  it("recognises pytest, python and package script lines", () => {
    expect(parseCommandLine("pytest tests -k 'a or b'")).toEqual({
      kind: "pytest",
      args: ["tests", "-k", "a or b"],
    });
    expect(parseCommandLine("python3 -m pytest -x")).toEqual({
      kind: "pytest",
      args: ["-x"],
    });
    expect(parseCommandLine("python -m http.server 8000")).toEqual({
      kind: "module",
      module: "http.server",
      args: ["8000"],
    });
    expect(parseCommandLine("python3 tools/gen.py --out x")).toEqual({
      kind: "script",
      script: "tools/gen.py",
      args: ["--out", "x"],
    });
    expect(parseCommandLine("yarn run build --watch")).toEqual({
      kind: "package",
      runner: "yarn",
      script: "build",
      args: ["--watch"],
    });
  });

  it("leaves shell syntax, manage.py and other lines to their owners", () => {
    for (const line of [
      "pytest | tee out",
      "pytest && echo ok",
      "python $SCRIPT",
      "python manage.py migrate",
      "python ./manage.py test",
      "python",
      "python -c 'print(1)'",
      "python3.11 x.py",
      "npm install",
      "npm run",
      "ls -la",
    ])
      expect(parseCommandLine(line), line).toBeNull();
  });
});

const at = (cwd: string, env: Record<string, string> = {}) => ({ cwd, env });

describe("commandLineConfig", () => {
  it("runs pytest with the folder's pytest setup from the terminal's directory", () => {
    const c = commandLineConfig("pytest tests/test_a.py -q", at("/p/api/tests"), "/p", CONFIGS, false)!;
    expect(c).toMatchObject({
      kind: "pytest",
      isTest: true,
      name: "pytest tests/test_a.py -q",
      command: "/p/api/.venv/bin/pytest",
      args: ["tests/test_a.py", "-q"],
      cwd: "/p/api/tests",
    });
  });

  it("runs modules and scripts on the project's interpreter", () => {
    expect(commandLineConfig("python -m api --port 1", at("/p/api"), "/p", CONFIGS, false)).toMatchObject({
      kind: "python",
      command: "/p/api/.venv/bin/python",
      args: ["-m", "api", "--port", "1"],
      cwd: "/p/api",
      debugAdapter: "debugpy",
    });
    // From the project root, Python lines need a Python configuration there.
    expect(commandLineConfig("python3 main.py", undefined, "/p", CONFIGS, false)).toBeNull();
    expect(commandLineConfig("python3 main.py", at("/p/api/sub"), "/p", CONFIGS, false)).toMatchObject({
      command: "/p/api/.venv/bin/python",
      args: ["main.py"],
      cwd: "/p/api/sub",
    });
  });

  it("prefers the Python environment active in the terminal", () => {
    const conda = at("/p/api", { CONDA_PREFIX: "/opt/conda/envs/x" });
    expect(commandLineConfig("pytest -x", conda, "/p", CONFIGS, false)).toMatchObject({
      kind: "pytest",
      command: "/opt/conda/envs/x/bin/python",
      args: ["-m", "pytest", "-x"],
      env: { CONDA_PREFIX: "/opt/conda/envs/x" },
    });
    const venv = at("/p/api", { VIRTUAL_ENV: "/w/.venv", CONDA_PREFIX: "/opt/conda" });
    expect(commandLineConfig("python run.py", venv, "/p", CONFIGS, false)?.command).toBe("/w/.venv/bin/python");
    expect(commandLineConfig("python run.py", venv, "/p", CONFIGS, true)?.command).toBe(
      "/w/.venv\\Scripts\\python.exe",
    );
  });

  it("runs with the shell's PATH (not on Windows)", () => {
    const shell = at("/p/web", { PATH: "/home/u/.nvm/bin:/usr/bin" });
    expect(commandLineConfig("npm run test", shell, "/p", CONFIGS, false)?.env).toEqual({
      PATH: "/home/u/.nvm/bin:/usr/bin",
    });
    expect(commandLineConfig("npm run test", shell, "/p", CONFIGS, true)?.env).toEqual({});
    const pytest = [config({ kind: "pytest", command: ".venv/bin/pytest", env: { PATH: "/p/.venv/bin" } })];
    expect(commandLineConfig("pytest", at("/p", { PATH: "/v/bin:/usr/bin" }), "/p", pytest, false)?.env).toEqual({
      PATH: "/v/bin:/usr/bin",
    });
  });

  it("needs a Python project or an active environment for Python lines", () => {
    const rust = [config({ kind: "cargo", command: "cargo", args: ["run"] })];
    expect(commandLineConfig("pytest", at("/p"), "/p", rust, false)).toBeNull();
    expect(commandLineConfig("python main.py", undefined, "/p", rust, false)).toBeNull();
    expect(commandLineConfig("python main.py", at("/p", { VIRTUAL_ENV: "/v" }), "/p", rust, false)?.command).toBe(
      "/v/bin/python",
    );
    // A versioned interpreter may not be the project's: the shell runs it.
    expect(commandLineConfig("python3.11 main.py", at("/p/api"), "/p", CONFIGS, false)).toBeNull();
  });

  it("parses backslashes as a POSIX shell in a terminal and as paths elsewhere on Windows", () => {
    const root = [config({ kind: "python", command: "python", args: ["-m", "app"] })];
    expect(commandLineConfig("python a\\b.py", undefined, "/p", root, true)?.args).toEqual(["a\\b.py"]);
    expect(commandLineConfig("python a\\b.py", at("/p"), "/p", root, true)?.args).toEqual(["ab.py"]);
  });

  it("runs a script of the package the folder belongs to, with the typed runner", () => {
    expect(commandLineConfig("npm run test -- --watch", at("/p/web/src"), "/p", CONFIGS, false)).toMatchObject({
      kind: "npm",
      isTest: true,
      command: "npm",
      args: ["run", "test", "--", "--watch"],
      cwd: "web",
    });
    expect(commandLineConfig("npm run lint", at("/p/web"), "/p", CONFIGS, false)).toBeNull();
    expect(commandLineConfig("npm run dev", at("/p/api"), "/p", CONFIGS, false)).toBeNull();
  });

  it("ignores folders outside the project", () => {
    expect(commandLineConfig("pytest", at("/elsewhere"), "/p", CONFIGS, false)).toBeNull();
    expect(commandLineConfig("pytest", at("/p2"), "/p", CONFIGS, false)).toBeNull();
  });
});
