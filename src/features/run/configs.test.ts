import { afterEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import {
  commandLine,
  duplicateConfig,
  formatArgs,
  groupConfigs,
  mergeConfigs,
  newConfig,
  parseArgs,
  removeConfig,
  upsertConfig,
  userConfigs,
  validateConfig,
} from "./configs";
import { contextConfig, fileRole } from "./context";
import { cacheRunTemplates } from "./runTemplates";
import { registerBuiltinTypes } from "./types";
import { envFromRows } from "./EnvDialog";
import { configRemoved, defaultSelection, rerunConfig, useRun, type RunSession } from "./store";

const cfg = (over: Partial<RunConfig> & { id: string }): RunConfig => ({
  name: over.id,
  kind: "shell",
  command: "echo",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...over,
});

describe("config merge / override", () => {
  const detected = [cfg({ id: "npm:dev", kind: "npm" }), cfg({ id: "npm:test", kind: "npm", isTest: true })];

  it("user configs override detected ones with the same id", () => {
    const user = [cfg({ id: "npm:dev", kind: "npm", name: "dev (custom)", detected: false })];
    const merged = mergeConfigs(detected, user);
    expect(merged.map((c) => [c.id, c.name])).toEqual([
      ["npm:test", "npm:test"],
      ["npm:dev", "dev (custom)"],
    ]);
  });

  it("editing a detected config creates a user copy with the same id", () => {
    const edited = upsertConfig(detected, { ...detected[0]!, args: ["run", "dev", "--port", "3001"] });
    expect(edited[0]).toMatchObject({ id: "npm:dev", detected: false, args: ["run", "dev", "--port", "3001"] });
    expect(userConfigs(edited).map((c) => c.id)).toEqual(["npm:dev"]);
    expect(edited[1]!.detected).toBe(true);
  });

  it("adds, duplicates and removes user configs", () => {
    const added = newConfig(detected);
    expect(added.id.startsWith("user:")).toBe(true);
    expect(added.detected).toBe(false);
    let list = upsertConfig(detected, added);
    const copy = duplicateConfig(detected[0]!, list);
    expect(copy).toMatchObject({ name: "npm:dev (copy)", detected: false });
    expect(copy.id).not.toBe(detected[0]!.id);
    list = upsertConfig(list, copy);
    expect(userConfigs(list)).toHaveLength(2);
    list = removeConfig(list, added.id);
    expect(userConfigs(list).map((c) => c.id)).toEqual([copy.id]);
  });

  it("groups by kind in order", () => {
    const groups = groupConfigs([
      cfg({ id: "a", kind: "npm" }),
      cfg({ id: "b", kind: "cargo" }),
      cfg({ id: "c", kind: "npm" }),
    ]);
    expect(groups.map((g) => [g.label, g.configs.map((c) => c.id)])).toEqual([
      ["npm", ["a", "c"]],
      ["Cargo", ["b"]],
    ]);
  });

  it("prefers an application config as the default selection", () => {
    const list = [
      cfg({ id: "cargo:build" }),
      cfg({ id: "cargo:test", isTest: true }),
      cfg({ id: "cargo:run:app", name: "cargo run app" }),
    ];
    expect(defaultSelection(list)?.id).toBe("cargo:run:app");
    const spring = [
      cfg({ id: "maven:spring-boot:run", kind: "maven" }),
      cfg({ id: "application:demo.App", kind: "spring-boot" }),
    ];
    expect(defaultSelection(spring)?.id).toBe("application:demo.App");
  });
});

describe("validateConfig", () => {
  it("requires a name and command", () => {
    expect(validateConfig(cfg({ id: "x", name: " ", command: "" }))).toEqual({
      name: "Name is required",
      command: "Command is required",
    });
  });

  it("rejects duplicate names and bad env keys", () => {
    const all = [cfg({ id: "a", name: "Server" })];
    expect(validateConfig(cfg({ id: "b", name: "Server" }), all).name).toMatch(/Another/);
    expect(validateConfig(cfg({ id: "c", env: { "BAD KEY": "1" } })).env).toMatch(/Invalid/);
    expect(validateConfig(cfg({ id: "d", env: { RUST_LOG: "debug" } }))).toEqual({});
  });

  it("validates env table rows", () => {
    expect(
      envFromRows([
        { key: "A", value: "1" },
        { key: "", value: "" },
      ]),
    ).toEqual({ env: { A: "1" } });
    expect(envFromRows([{ key: "", value: "x" }]).error).toMatch(/empty/);
    expect(
      envFromRows([
        { key: "A", value: "1" },
        { key: "A", value: "2" },
      ]).error,
    ).toMatch(/Duplicate/);
  });
});

describe("argument parsing", () => {
  it("splits with quotes and escapes", () => {
    expect(parseArgs(`run --name "hello world" 'it''s' a\\ b ""`)).toEqual([
      "run",
      "--name",
      "hello world",
      "its",
      "a b",
      "",
    ]);
    expect(parseArgs("  ")).toEqual([]);
  });

  it("round-trips through formatArgs", () => {
    const args = ["test", "--", "it's here", "", "$HOME", "plain"];
    expect(parseArgs(formatArgs(args))).toEqual(args);
    expect(commandLine({ command: "cargo", args: ["run", "--bin", "my app"] })).toBe("cargo run --bin 'my app'");
  });
});

describe("context configuration", () => {
  const configs = [
    cfg({ id: "npm:test", kind: "npm", command: "pnpm", args: ["run", "test"], isTest: true }),
    cfg({ id: "npm:web:test", kind: "npm", command: "pnpm", args: ["run", "test"], cwd: "web", isTest: true }),
    cfg({ id: "cargo:test", kind: "cargo", command: "cargo", args: ["test"], isTest: true }),
    cfg({ id: "cargo:run:server", kind: "cargo", command: "cargo", args: ["run", "--bin", "server"] }),
    cfg({ id: "go:test", kind: "go", command: "go", args: ["test", "./..."], isTest: true }),
    cfg({ id: "pytest", kind: "pytest", command: "uv", args: ["run", "pytest"], isTest: true }),
    cfg({ id: "python:module:app", kind: "python", command: ".venv/bin/python", args: ["-m", "app"] }),
    cfg({ id: "gradle:test", kind: "gradle", command: "./gradlew", args: ["test"], isTest: true }),
    cfg({ id: "rspec", kind: "rspec", command: "bundle", args: ["exec", "rspec"], isTest: true }),
    cfg({ id: "rake:test", kind: "rake", command: "bundle", args: ["exec", "rake", "test"], isTest: true }),
  ];

  it("classifies files", () => {
    expect(fileRole("src/a.test.ts")).toBe("test");
    expect(fileRole("pkg/x_test.go")).toBe("test");
    expect(fileRole("tests/test_api.py")).toBe("test");
    // Django's default test module (pattern `test*.py`); a script outside Django projects.
    expect(fileRole("polls/tests.py", undefined, false, true)).toBe("test");
    expect(fileRole("polls/tests.py")).toBe("script");
    expect(fileRole("src/test/kotlin/OrderControllerTest.kt")).toBe("test");
    expect(fileRole("tests/integration.rs")).toBe("test");
    expect(fileRole("spec/models/user_spec.rb")).toBe("test");
    expect(fileRole("test/user_test.rb")).toBe("test");
    expect(fileRole("lib/tasks/gen.rb")).toBe("script");
    expect(fileRole("src/main.rs")).toBe("main");
    expect(fileRole("cmd/main.go", "package main\nfunc main() {}")).toBe("main");
    expect(fileRole("tools/gen.py")).toBe("script");
    expect(fileRole("scripts/build.bat", undefined, true)).toBe("script");
    expect(fileRole("scripts/run.cmd", undefined, true)).toBe("script");
    expect(fileRole("scripts/build.bat", undefined, false)).toBeNull();
    expect(fileRole("README.md")).toBeNull();
  });

  it("runs a JS test file through the closest test script", () => {
    const c = contextConfig("web/src/cart.test.ts", configs)!;
    expect(c).toMatchObject({
      args: ["run", "test", "--", "src/cart.test.ts"],
      cwd: "web",
      isTest: true,
      name: "cart.test.ts",
    });
    expect(c.id).toBe("context:npm:web:test:web/src/cart.test.ts");
    expect(contextConfig("src/a.spec.js", configs)!.args).toEqual(["run", "test", "--", "src/a.spec.js"]);
  });

  it("narrows rspec and rake test runs to the file", () => {
    expect(contextConfig("spec/models/user_spec.rb", configs)!.args).toEqual([
      "exec",
      "rspec",
      "spec/models/user_spec.rb",
    ]);
    expect(contextConfig("test/user_test.rb", configs)!.args).toEqual([
      "exec",
      "rake",
      "test",
      "TEST=test/user_test.rb",
    ]);
  });

  it("narrows go, cargo, pytest and gradle runs", () => {
    expect(contextConfig("internal/calc/calc_test.go", configs)!.args).toEqual(["test", "./internal/calc"]);
    expect(contextConfig("tests/api.rs", configs)!.args).toEqual(["test", "--test", "api"]);
    expect(contextConfig("tests/test_math.py", configs)!.args).toEqual(["run", "pytest", "tests/test_math.py"]);
    // `tests.py` is a test module in Django projects only.
    expect(contextConfig("polls/tests.py", configs)).toMatchObject({
      kind: "python",
      isTest: false,
      command: ".venv/bin/python",
      args: ["polls/tests.py"],
    });
    const django = cfg({
      id: "django:test",
      kind: "django-test",
      command: "uv",
      args: ["run", "python", "manage.py", "test"],
      isTest: true,
    });
    expect(contextConfig("polls/tests.py", [django])!.args).toEqual([
      "run",
      "python",
      "manage.py",
      "test",
      "polls.tests",
    ]);
    expect(contextConfig("src/test/kotlin/OrderControllerTest.kt", configs)!.args).toEqual([
      "test",
      "--tests",
      "*OrderControllerTest",
    ]);
  });

  it("does not borrow another Go module's run or test configuration", () => {
    const go = [
      cfg({ id: "go:run:api", kind: "go", command: "go", args: ["run", "."], cwd: "api" }),
      cfg({ id: "go:test:api", kind: "go", command: "go", args: ["test", "./..."], cwd: "api", isTest: true }),
    ];
    expect(contextConfig("other/main.go", go, "package main\nfunc main() {}")).toBeNull();
    expect(contextConfig("other/main_test.go", go, "package main")).toBeNull();
  });

  it("uses a nested Go module even when only the parent has a run configuration", () => {
    const go = [
      cfg({ id: "go:run", kind: "go", command: "go", args: ["run", "."] }),
      cfg({ id: "go:test:api", kind: "go", command: "go", args: ["test", "./..."], cwd: "api", isTest: true }),
    ];
    expect(contextConfig("api/tool/main.go", go, "package main\nfunc main() {}")).toMatchObject({
      cwd: "api",
      args: ["run", "./tool"],
    });
  });

  it("does not pass typed Go test flags to an application build", () => {
    const go = cfg({
      id: "user:go-test",
      kind: "go",
      command: "go",
      args: ["test", "-count=1", "./..."],
      isTest: true,
      params: { goKind: "test", module: "api", toolArgs: "-count=1" },
    });
    expect(contextConfig("api/cmd/server/main.go", [go], "package main\nfunc main() {}")).toMatchObject({
      cwd: "api",
      args: ["run", "./cmd/server"],
      params: undefined,
      isTest: false,
    });
  });

  it("finds run targets and script invocations", () => {
    expect(contextConfig("src/bin/server.rs", configs)!.id).toBe("cargo:run:server");
    expect(contextConfig("tools/gen.py", configs)).toMatchObject({
      command: ".venv/bin/python",
      args: ["tools/gen.py"],
    });
    expect(contextConfig("scripts/build.sh", configs)).toMatchObject({ command: "sh", args: ["scripts/build.sh"] });
    expect(contextConfig("scripts/build.bat", configs, undefined, true)).toMatchObject({
      command: "cmd.exe",
      args: ["/c", "build.bat"],
      cwd: "scripts",
    });
    expect(contextConfig("run.cmd", configs, undefined, true)).toMatchObject({
      command: "cmd.exe",
      args: ["/c", "run.cmd"],
      cwd: null,
    });
    expect(contextConfig("scripts/build.bat", configs, undefined, false)).toBeNull();
    expect(contextConfig("docs/readme.md", configs)).toBeNull();
  });

  it("runs a module that imports relatively as a module of its package", () => {
    const cli = "from .models import Priority, TaskList\n\n\ndef main():\n    pass\n";
    expect(contextConfig("src/tasks/cli.py", configs, cli)).toMatchObject({
      kind: "python",
      command: "../.venv/bin/python",
      args: ["-m", "tasks.cli"],
      cwd: "src",
      debugAdapter: "debugpy",
    });
    expect(contextConfig("app/api/routes.py", [], "from . import models\n")).toMatchObject({
      command: "python3",
      args: ["-m", "app.api.routes"],
      cwd: null,
    });
    expect(contextConfig("src/app/__main__.py", [], "from .cli import main\n")).toMatchObject({
      args: ["-m", "app"],
      cwd: "src",
    });
    // Inside a nested Python project: from its folder (the venv command stays relative to the root).
    const nested = [cfg({ id: "pytest", kind: "pytest", command: "backend/.venv/bin/pytest", cwd: "backend" })];
    expect(contextConfig("backend/app/jobs.py", nested, "from .db import session\n")).toMatchObject({
      command: "../backend/.venv/bin/python",
      args: ["-m", "app.jobs"],
      cwd: "backend",
    });
    // Absolute imports, a top-level file, a folder that can't be a package: as a script.
    expect(contextConfig("src/tasks/cli.py", configs, "import os\n")!.args).toEqual(["src/tasks/cli.py"]);
    expect(contextConfig("tool.py", [], "from .x import y\n")!.args).toEqual(["tool.py"]);
    expect(contextConfig("my-scripts/run.py", [], "from .x import y\n")!.args).toEqual(["my-scripts/run.py"]);
  });

  it("runs pytest for a test file even without a detected pytest config", () => {
    expect(contextConfig("worker/test_worker.py", [])).toMatchObject({
      command: "python3",
      args: ["-m", "pytest", "worker/test_worker.py"],
      isTest: true,
      debugAdapter: "debugpy",
    });
    const venv = [cfg({ id: "python:module:app", kind: "python", command: ".venv/bin/python", args: ["-m", "app"] })];
    expect(contextConfig("worker/test_worker.py", venv)).toMatchObject({
      command: ".venv/bin/python",
      args: ["-m", "pytest", "worker/test_worker.py"],
    });
  });

  it("runs a Go main package of a nested module from the module directory", () => {
    const nested = [
      cfg({ id: "go:run:api", kind: "go", command: "go", args: ["run", "."], cwd: "api" }),
      cfg({ id: "go:test:api", kind: "go", command: "go", args: ["test", "./..."], cwd: "api", isTest: true }),
    ];
    const main = "package main\nfunc main() {}";
    expect(contextConfig("api/main.go", nested, main)!.id).toBe("go:run:api");
    expect(contextConfig("api/cmd/tool/main.go", nested, main)).toMatchObject({
      args: ["run", "./cmd/tool"],
      cwd: "api",
    });
    expect(contextConfig("api/main_test.go", nested)).toMatchObject({ args: ["test", "."], cwd: "api" });
  });

  it("derives the interpreter from a venv pytest config", () => {
    const venv = [cfg({ id: "pytest", kind: "pytest", command: ".venv/bin/pytest", args: [], isTest: true })];
    expect(contextConfig("tools/gen.py", venv)).toMatchObject({ command: ".venv/bin/python", args: ["tools/gen.py"] });
    const uv = [cfg({ id: "pytest", kind: "pytest", command: "uv", args: ["run", "pytest"], isTest: true })];
    expect(contextConfig("tools/gen.py", uv)).toMatchObject({ command: "uv", args: ["run", "python", "tools/gen.py"] });
  });

  it("takes the interpreter from a Django runserver config without its arguments", () => {
    const runserver = (command: string, args: string[]) =>
      cfg({ id: "django:runserver", kind: "python", command, args: [...args, "manage.py", "runserver"] });
    expect(contextConfig("tools/seed.py", [runserver(".venv/bin/python", [])])).toMatchObject({
      command: ".venv/bin/python",
      args: ["tools/seed.py"],
    });
    expect(contextConfig("tools/seed.py", [runserver("uv", ["run", "python"])])).toMatchObject({
      command: "uv",
      args: ["run", "python", "tools/seed.py"],
    });
    expect(contextConfig("worker/test_worker.py", [runserver(".venv/bin/python", [])])).toMatchObject({
      args: ["-m", "pytest", "worker/test_worker.py"],
    });
  });

  it("keeps the interpreter of a plain python config", () => {
    const plain = [cfg({ id: "python:module:app", kind: "python", command: "python3", args: ["-m", "app"] })];
    expect(contextConfig("tools/gen.py", plain)).toMatchObject({ command: "python3", args: ["tools/gen.py"] });
    expect(contextConfig("tools/gen.py", [])).toMatchObject({ command: "python3", args: ["tools/gen.py"] });
  });

  describe("system python per OS (#1885)", () => {
    const os = usePlatform.getState().os;
    afterEach(() => {
      usePlatform.setState({ os });
      cacheRunTemplates([]);
    });

    it("falls back to `python` on Windows, `python3` elsewhere", () => {
      usePlatform.setState({ os: "windows" });
      // `python3` is not a command on Windows.
      expect(contextConfig("tools/gen.py", [])).toMatchObject({ command: "python", args: ["tools/gen.py"] });
      expect(contextConfig("worker/test_worker.py", [])).toMatchObject({
        command: "python",
        args: ["-m", "pytest", "worker/test_worker.py"],
      });
      usePlatform.setState({ os: "linux" });
      expect(contextConfig("tools/gen.py", [])).toMatchObject({ command: "python3", args: ["tools/gen.py"] });
      expect(contextConfig("worker/test_worker.py", [])).toMatchObject({
        command: "python3",
        args: ["-m", "pytest", "worker/test_worker.py"],
      });
    });

    it("seeds gutter pytest configs from the pytest template", () => {
      const dispose = registerBuiltinTypes();
      try {
        cacheRunTemplates([
          cfg({ id: "template:pytest", kind: "pytest", params: { command: "pixi", runnerArgs: "run pytest" } }),
        ]);
        expect(contextConfig("worker/test_worker.py", [])).toMatchObject({
          command: "pixi",
          args: ["run", "pytest", "worker/test_worker.py"],
          isTest: true,
        });
        // Template options come along; the file stays the target.
        cacheRunTemplates([
          cfg({
            id: "template:pytest",
            kind: "pytest",
            params: { command: "uv", runnerArgs: "run pytest", options: "-x" },
          }),
        ]);
        expect(contextConfig("worker/test_worker.py", [])!.args).toEqual([
          "run",
          "pytest",
          "-x",
          "worker/test_worker.py",
        ]);
        // A target stored on the template itself is dropped: the gutter file is
        // the target, or the run would execute both.
        cacheRunTemplates([
          cfg({
            id: "template:pytest",
            kind: "pytest",
            params: { command: "pixi", runnerArgs: "run pytest", target: "tests", options: "-x" },
          }),
        ]);
        expect(contextConfig("worker/test_worker.py", [])!.args).toEqual([
          "run",
          "pytest",
          "-x",
          "worker/test_worker.py",
        ]);
        // No template: the detected interpreter / system python as before.
        cacheRunTemplates([]);
        const venv = [
          cfg({ id: "python:module:app", kind: "python", command: ".venv/bin/python", args: ["-m", "app"] }),
        ];
        expect(contextConfig("worker/test_worker.py", venv)).toMatchObject({
          command: ".venv/bin/python",
          args: ["-m", "pytest", "worker/test_worker.py"],
        });
      } finally {
        dispose();
        cacheRunTemplates([]);
      }
    });
  });
});

describe("rerunning a session after its configuration changed (#1497)", () => {
  const session = (config: RunConfig, baseConfig?: RunConfig): RunSession => ({
    id: "s",
    config,
    baseConfig,
    runId: null,
    status: "finished",
    exitCode: 0,
    startedAt: 1,
    endedAt: 2,
    stdinClosed: true,
  });

  it("launches the configuration as saved now, or the one it ran with once deleted", () => {
    const ran = cfg({ id: "app", command: "python", args: ["init.py"] });
    const edited = { ...ran, args: ["main.py"] };
    useRun.setState({ configs: [edited] });
    expect(rerunConfig(session(ran))).toBe(edited);
    expect(configRemoved("app")).toBe(false);
    useRun.setState({ configs: [] });
    expect(rerunConfig(session(ran))).toBe(ran);
    expect(configRemoved("app")).toBe(true);
    // A run that was never a listed configuration isn't "removed".
    expect(configRemoved("build:task")).toBe(false);
  });

  it("keeps the tests of a derived run (Rerun Failed Tests)", () => {
    const base = cfg({ id: "tests", isTest: true });
    const derived = { ...base, args: ["-k", "failing"] };
    useRun.setState({ configs: [base] });
    expect(rerunConfig(session(derived, base))).toBe(derived);
    useRun.setState({ configs: [] });
  });
});
