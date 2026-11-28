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
    expect(parseCommandLine("python3.12 tools/gen.py --out x")).toEqual({
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
      "npm install",
      "npm run",
      "ls -la",
    ])
      expect(parseCommandLine(line), line).toBeNull();
  });
});

describe("commandLineConfig", () => {
  it("runs pytest with the folder's pytest setup from the terminal's directory", () => {
    const c = commandLineConfig("pytest tests/test_a.py -q", "/p/api/tests", "/p", CONFIGS)!;
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
    expect(commandLineConfig("python -m api --port 1", "/p/api", "/p", CONFIGS)).toMatchObject({
      kind: "python",
      command: "/p/api/.venv/bin/python",
      args: ["-m", "api", "--port", "1"],
      cwd: "/p/api",
      debugAdapter: "debugpy",
    });
    expect(commandLineConfig("python main.py", undefined, "/p", [])).toMatchObject({
      command: expect.stringMatching(/^python/),
      args: ["main.py"],
      cwd: "/p",
    });
  });

  it("runs a script of the package the folder belongs to, with the typed runner", () => {
    expect(commandLineConfig("npm run test -- --watch", "/p/web/src", "/p", CONFIGS)).toMatchObject({
      kind: "npm",
      isTest: true,
      command: "npm",
      args: ["run", "test", "--", "--watch"],
      cwd: "web",
    });
    expect(commandLineConfig("npm run lint", "/p/web", "/p", CONFIGS)).toBeNull();
    expect(commandLineConfig("npm run dev", "/p/api", "/p", CONFIGS)).toBeNull();
  });

  it("ignores folders outside the project", () => {
    expect(commandLineConfig("pytest", "/elsewhere", "/p", CONFIGS)).toBeNull();
    expect(commandLineConfig("pytest", "/p2", "/p", CONFIGS)).toBeNull();
  });
});
