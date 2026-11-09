import { describe, expect, it, vi, afterEach } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { TestResults } from "./results";
import {
  failedTestPaths,
  leafTestPaths,
  rerunFailedConfig,
  rerunFailedConfigs,
  testsConfig,
  testsConfigs,
} from "./rerun";

import { providePluginTestSelector } from "@/workbench/contributions";

const cfg = (kind: string, command: string, args: string[]): RunConfig => ({
  id: `${kind}:test`,
  name: `${kind} test`,
  kind,
  command,
  args,
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
});

describe("failedTestPaths", () => {
  it("collects failed leaves and failed suites without failed children", () => {
    const r = new TestResults();
    r.apply([
      { type: "result", path: ["a.test.ts", "adds"], status: "passed" },
      { type: "result", path: ["a.test.ts", "subs"], status: "failed" },
      { type: "result", path: ["b.test.ts"], status: "failed" },
      { type: "result", path: ["b.test.ts", "ok"], status: "passed" },
    ]);
    expect(failedTestPaths(r)).toEqual([["a.test.ts", "subs"], ["b.test.ts"]]);
  });
});

describe("tests selected in the test tree", () => {
  it("expands suites to their tests; a suite without reported tests stands for itself", async () => {
    const r = new TestResults();
    r.apply([
      { type: "result", path: ["com.acme.ATest", "one()"], status: "passed" },
      { type: "result", path: ["com.acme.ATest", "two()"], status: "failed" },
      { type: "result", path: ["com.acme.BTest"], status: "passed" },
    ]);
    const nodes = [
      r.get("com.acme.ATest")!,
      r.get(["com.acme.ATest", "one()"].join("\u0000"))!,
      r.get("com.acme.BTest")!,
    ];
    expect(leafTestPaths(nodes)).toEqual([
      ["com.acme.ATest", "one()"],
      ["com.acme.ATest", "two()"],
      ["com.acme.BTest"],
    ]);
    const c = (await testsConfig(cfg("gradle", "./gradlew", ["test"]), leafTestPaths(nodes), "3 tests"))!;
    expect(c.name).toBe("3 tests");
    expect(c.args).toEqual([
      "test",
      "--tests",
      "com.acme.ATest.one",
      "--tests",
      "com.acme.ATest.two",
      "--tests",
      "com.acme.BTest",
    ]);
  });
});

describe("rerunFailedConfig", () => {
  it("cargo: exact names after --", async () => {
    const c = (await rerunFailedConfig(cfg("cargo", "cargo", ["test", "--workspace"]), [
      ["src/lib.rs", "tests", "adds"],
      ["tests/it.rs", "smoke"],
      ["Doc-tests app", "src/lib.rs - foo (line 3)"],
    ]))!;
    expect(c.args).toEqual(["test", "--workspace", "--", "tests::adds", "smoke", "--exact"]);
    expect(c.name).toBe("Failed: cargo test");
  });

  it("cargo: merges an existing -- section without duplicating --exact", async () => {
    const c = (await rerunFailedConfig(cfg("cargo", "cargo", ["test", "--", "--nocapture", "--exact", "old"]), [
      ["src/lib.rs", "a"],
    ]))!;
    expect(c.args).toEqual(["test", "--", "--nocapture", "old", "a", "--exact"]);
  });

  it.each([
    ["npm", ["--"]],
    ["pnpm", []],
    ["/opt/bin/pnpm", []],
    ["C:\\tools\\pnpm.CMD", []],
    ["yarn", ["--"]],
    ["bun", ["--"]],
    ["npx", []],
  ])("jest/vitest via %s: files + -t pattern", async (command, separator) => {
    const c = (await rerunFailedConfig(cfg("npm", command, ["run", "test"]), [
      ["src/a.test.ts", "math", "adds (1+1)"],
      ["src/b.test.ts"],
    ]))!;
    expect(c.args).toEqual([
      "run",
      "test",
      ...separator,
      "src/a.test.ts",
      "src/b.test.ts",
      "-t",
      "^(?:math adds \\(1\\+1\\))$",
    ]);
  });

  it.each([
    ["run", "test", "-t", "old"],
    ["run", "test", "--", "--testNamePattern=old"],
  ])("replaces an existing pnpm test filter in %j", async (...args) => {
    const c = (await rerunFailedConfig(cfg("npm", "pnpm", args), [["src/a.test.ts", "new"]]))!;
    expect(c.args).toEqual(["run", "test", ...(args.includes("--") ? ["--"] : []), "src/a.test.ts", "-t", "^(?:new)$"]);
  });

  it("pytest: node ids replace explicit paths", async () => {
    const c = (await rerunFailedConfig(cfg("pytest", ".venv/bin/pytest", ["-q", "tests/", "-k", "slow"]), [
      ["tests/test_x.py", "TestC", "test_y[1]"],
      ["tests/test_z.py", "test_a"],
    ]))!;
    expect(c.args).toEqual(["-q", "tests/test_x.py::TestC::test_y[1]", "tests/test_z.py::test_a"]);
  });

  it("django: dotted labels in place of the run's target, options kept", async () => {
    const c = (await rerunFailedConfig(
      cfg("django-test", ".venv/bin/python", ["manage.py", "test", "polls", "--keepdb", "-v", "2"]),
      [["polls.tests", "QuestionTests", "test_a"], ["polls.tests", "BrokenSetupTests"], ["broken.tests"]],
    ))!;
    expect(c.args).toEqual([
      "manage.py",
      "test",
      "polls.tests.QuestionTests.test_a",
      "polls.tests.BrokenSetupTests",
      "broken.tests",
      "--keepdb",
      "-v",
      "2",
    ]);
    // A configuration made in the form keeps its Target field in step.
    const form = {
      ...cfg("django-test", "uv", ["run", "python", "manage.py", "test", "polls"]),
      params: { command: "uv", runnerArgs: "run python", target: "polls", settings: "", options: "" },
    };
    expect(await rerunFailedConfig(form, [["polls.tests", "QuestionTests", "test_a"]])).toMatchObject({
      args: ["run", "python", "manage.py", "test", "polls.tests.QuestionTests.test_a"],
      params: { target: "polls.tests.QuestionTests.test_a" },
    });
  });

  it("go: keeps full subtest paths separate for each package", async () => {
    const configs = await rerunFailedConfigs(cfg("go", "go", ["test", "-v", "./..."]), [
      ["example.com/m/pkg", "TestAdd"],
      ["example.com/m/pkg", "TestSub", "case_1"],
      ["example.com/m/other", "TestX"],
    ]);
    expect(configs.map((config) => config.args)).toEqual([
      ["test", "-v", "-run", "^TestAdd$|^TestSub$/^case_1$", "example.com/m/pkg"],
      ["test", "-v", "-run", "^TestX$", "example.com/m/other"],
    ]);
    expect(new Set(configs.map((config) => config.id)).size).toBe(2);
  });

  it("gradle and maven filters", async () => {
    expect((await rerunFailedConfig(cfg("gradle", "./gradlew", ["test"]), [["com.a.FooTest", "bar()"]]))!.args).toEqual(
      ["test", "--tests", "com.a.FooTest.bar"],
    );
    expect(
      (await rerunFailedConfig(cfg("maven", "mvn", ["test"]), [
        ["com.a.FooTest", "bar"],
        ["com.a.FooTest", "baz"],
        ["com.a.BarTest"],
      ]))!.args,
    ).toEqual(["test", "-Dtest=com.a.FooTest#bar+baz,com.a.BarTest"]);
  });

  it("returns null when nothing failed or the framework is unknown", async () => {
    expect(await rerunFailedConfig(cfg("cargo", "cargo", ["test"]), [])).toBeNull();
    expect(await rerunFailedConfig(cfg("make", "make", ["test"]), [["x"]])).toBeNull();
  });
});

describe("withTestReporting", () => {
  it("asks pytest for one line per test unless a verbosity was chosen", async () => {
    const { withTestReporting } = await import("./index");
    expect(withTestReporting(cfg("pytest", "python3", ["-m", "pytest", "t.py"])).args).toEqual([
      "-m",
      "pytest",
      "t.py",
      "-v",
    ]);
    expect(withTestReporting(cfg("pytest", "uv", ["run", "pytest"])).args).toEqual(["run", "pytest", "-v"]);
    expect(withTestReporting(cfg("pytest", ".venv/bin/pytest", ["-q"])).args).toEqual(["-q"]);
    expect(withTestReporting(cfg("pytest", "pytest", ["-vv"])).args).toEqual(["-vv"]);
    // Django prints one line per test from verbosity 2.
    expect(withTestReporting(cfg("django-test", "python3", ["manage.py", "test", "--keepdb"])).args).toEqual([
      "manage.py",
      "test",
      "--keepdb",
      "-v",
      "2",
    ]);
    expect(withTestReporting(cfg("django-test", "python3", ["manage.py", "test", "-v", "3"])).args).toEqual([
      "manage.py",
      "test",
      "-v",
      "3",
    ]);
    expect(withTestReporting(cfg("shell", "python3", ["manage.py", "test", "--verbosity=0"])).args).toEqual([
      "manage.py",
      "test",
      "--verbosity=0",
    ]);
    // A plain script run (no pytest) and other frameworks are left alone.
    expect(withTestReporting(cfg("python", "python3", ["main.py"])).args).toEqual(["main.py"]);
    expect(withTestReporting(cfg("cargo", "cargo", ["test"])).args).toEqual(["test"]);
  });
});

describe("Go rerun argument boundaries", () => {
  it.each(["-test.v", "-test.short", "-test.benchmem", "-test.failfast", "-test.fullpath"])(
    "does not retain package targets after the boolean flag %s",
    async (flag) => {
      const config = cfg("go", "go", ["test", flag, "./..."]);
      const rerun = (await rerunFailedConfig(config, [["example.com/selected", "TestOnly"]]))!;
      expect(rerun.args).toEqual(["test", flag, "-run", "^TestOnly$", "example.com/selected"]);
    },
  );

  it("replaces import-path targets without losing flag values or binary arguments", async () => {
    const config = cfg("go", "go", ["test", "-tags", "demo", "-run", "old", "example.com/old", "-args", "-test.short"]);
    const rerun = (await rerunFailedConfig(config, [["example.com/new", "TestChild", "case"]]))!;
    expect(rerun.args).toEqual([
      "test",
      "-tags",
      "demo",
      "-run",
      "^TestChild$/^case$",
      "example.com/new",
      "-args",
      "-test.short",
    ]);
  });
  it.each(["command-line-arguments", "example.com/app"])(
    "retains file-scoped preparation for %s",
    async (packageName) => {
      const config = {
        ...cfg("go", "go", ["test", "main_test.go"]),
        params: { goKind: "test", scope: "file", target: "main_test.go", module: "app", pattern: "", useTags: "true" },
      };
      const rerun = (await rerunFailedConfig(config, [[packageName, "TestFail"]]))!;
      expect(rerun.params).toMatchObject({
        goKind: "test",
        scope: "file",
        target: "main_test.go",
        pattern: "^TestFail$",
      });
      expect(rerun.args).toEqual(["test", "-run", "^TestFail$", "main_test.go"]);
    },
  );
});

describe("exact Go test and benchmark selections", () => {
  it("keeps benchmark selectors and removes stale selectors from binary arguments", async () => {
    const base = cfg("go", "go", [
      "test",
      "-tags=demo",
      "-run=Old",
      "-bench",
      "Old",
      "./...",
      "-args",
      "-test.run",
      "Old",
      "-test.bench=Old",
      "-test.skip=New",
      "-custom",
      "keep",
    ]);
    const [config] = await testsConfigs(base, [["example.com/p", "BenchmarkNew", "case"]], "selected");
    expect(config!.args).toEqual([
      "test",
      "-tags=demo",
      "-run",
      "^$",
      "-bench",
      "^BenchmarkNew$/^case$",
      "example.com/p",
      "-args",
      "-custom",
      "keep",
    ]);
  });

  it("keeps independent alternatives for tests of different depths", async () => {
    const [config] = await testsConfigs(
      cfg("go", "go", ["test", "."]),
      [
        ["p", "TestA", "one"],
        ["p", "TestB", "two", "leaf.with.dot"],
        ["p", "BenchmarkC"],
      ],
      "selected",
    );
    expect(config!.args).toEqual([
      "test",
      "-run",
      "^TestA$/^one$|^TestB$/^two$/^leaf\\.with\\.dot$",
      "-bench",
      "^BenchmarkC$",
      "p",
    ]);
  });

  it("keeps typed file benchmark flags and clears overridden binary selectors", async () => {
    const base = {
      ...cfg("go", "go", ["test", "chosen_test.go", "-args", "-test.run=Old", "-custom", "keep"]),
      params: {
        goKind: "test",
        scope: "file",
        target: "chosen_test.go",
        module: "app",
        programArgs: "-test.run=Old -custom keep",
      },
    };
    const [config] = await testsConfigs(base, [["example.com/p", "BenchmarkNew"]], "selected");
    expect(config!.params).toMatchObject({
      target: "chosen_test.go",
      pattern: "^$",
      toolArgs: "-bench '^BenchmarkNew$'",
      programArgs: "-custom keep",
    });
    expect(config!.args).toContain("chosen_test.go");
  });

  it("reruns an entire failed package with its original runner options", async () => {
    const base = cfg("go", "go", ["test", "-race", "-bench", ".", "./..."]);
    const [config] = await testsConfigs(base, [["example.com/p"]], "selected");
    expect(config!.args).toEqual(["test", "-race", "-bench", ".", "example.com/p"]);
  });
});

it("keeps inherited Go build tags enabled when deriving a typed package rerun", async () => {
  const config = {
    ...cfg("go", "go", ["test", "./..."]),
    params: { goKind: "test", scope: "package", target: "./..." },
  };
  expect((await rerunFailedConfig(config, [["example.com/p", "TestChosen"]]))!.params?.useTags).toBe("true");
});

describe("plugin test selection", () => {
  let dispose = () => {};
  afterEach(() => dispose());
  const pluginConfig = (): RunConfig => ({
    ...cfg("plugin", "runner", ["test", "--old-filter"]),
    id: "plugin:example:tests",
    params: { framework: "plugin" },
    env: { EXAMPLE: "yes" },
    cwd: "/project",
    target: "plugin:example:container",
  });

  it("passes the owning config and exact failed name paths, replacing argv and preserving launch settings", async () => {
    const select = vi.fn().mockResolvedValue(["test", "--only", "suite::fails"]);
    dispose = providePluginTestSelector(select);
    const base = pluginConfig();
    const results = new TestResults();
    results.apply([
      { type: "result", path: ["suite", "fails"], status: "failed" },
      { type: "result", path: ["suite", "passes"], status: "passed" },
    ]);
    const configs = await rerunFailedConfigs(base, failedTestPaths(results));
    expect(select).toHaveBeenCalledExactlyOnceWith(base.id, [["suite", "fails"]]);
    expect(configs).toEqual([{ ...base, name: "Failed: plugin test", args: ["test", "--only", "suite::fails"] }]);
    expect(configs[0]!.env).not.toBe(base.env);
    expect(base.args).toEqual(["test", "--old-filter"]);
  });

  it("uses the same selection for test-tree suites and accepts empty replacement argv", async () => {
    const select = vi.fn().mockResolvedValue([]);
    dispose = providePluginTestSelector(select);
    const base = pluginConfig();
    const paths = [
      ["suite", "one"],
      ["suite", "two"],
    ];
    expect(await testsConfig(base, paths, "suite")).toEqual({ ...base, args: [], name: "suite" });
    expect(await testsConfigs(base, paths, "suite")).toHaveLength(1);
    expect(select).toHaveBeenCalledWith(base.id, paths);
  });

  it("returns unsupported for no provider, none, errors and empty selection", async () => {
    const base = pluginConfig();
    expect(await testsConfig(base, [["test"]], "selected")).toBeNull();
    const select = vi.fn().mockResolvedValue(null);
    dispose = providePluginTestSelector(select);
    expect(await rerunFailedConfigs(base, [["test"]])).toEqual([]);
    select.mockRejectedValue(new Error("timeout"));
    expect(await testsConfigs(base, [["test"]], "selected")).toEqual([]);
    select.mockClear();
    expect(testsConfigs(base, [], "selected")).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps built-in selection synchronous without calling plugins", () => {
    const select = vi.fn();
    dispose = providePluginTestSelector(select);
    const base = cfg("cargo", "cargo", ["test"]);
    expect(testsConfig(base, [["src/lib.rs", "test"]], "test")).not.toBeInstanceOf(Promise);
    expect(rerunFailedConfigs(base, [["src/lib.rs", "test"]])).not.toBeInstanceOf(Promise);
    expect(select).not.toHaveBeenCalled();
  });
});
