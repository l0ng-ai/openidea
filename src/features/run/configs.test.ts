import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
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
import { envFromRows } from "./EnvDialog";
import { defaultSelection } from "./store";

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
  ];

  it("classifies files", () => {
    expect(fileRole("src/a.test.ts")).toBe("test");
    expect(fileRole("pkg/x_test.go")).toBe("test");
    expect(fileRole("tests/test_api.py")).toBe("test");
    expect(fileRole("src/test/kotlin/OrderControllerTest.kt")).toBe("test");
    expect(fileRole("tests/integration.rs")).toBe("test");
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

  it("narrows go, cargo, pytest and gradle runs", () => {
    expect(contextConfig("internal/calc/calc_test.go", configs)!.args).toEqual(["test", "./internal/calc"]);
    expect(contextConfig("tests/api.rs", configs)!.args).toEqual(["test", "--test", "api"]);
    expect(contextConfig("tests/test_math.py", configs)!.args).toEqual(["run", "pytest", "tests/test_math.py"]);
    expect(contextConfig("src/test/kotlin/OrderControllerTest.kt", configs)!.args).toEqual([
      "test",
      "--tests",
      "*OrderControllerTest",
    ]);
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
});
