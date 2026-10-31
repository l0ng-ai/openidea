import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { TestResults } from "./results";
import { failedTestPaths, leafTestPaths, rerunFailedConfig, testsConfig } from "./rerun";

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
  it("expands suites to their tests; a suite without reported tests stands for itself", () => {
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
    const c = testsConfig(cfg("gradle", "./gradlew", ["test"]), leafTestPaths(nodes), "3 tests")!;
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
  it("cargo: exact names after --", () => {
    const c = rerunFailedConfig(cfg("cargo", "cargo", ["test", "--workspace"]), [
      ["src/lib.rs", "tests", "adds"],
      ["tests/it.rs", "smoke"],
      ["Doc-tests app", "src/lib.rs - foo (line 3)"],
    ])!;
    expect(c.args).toEqual(["test", "--workspace", "--", "tests::adds", "smoke", "--exact"]);
    expect(c.name).toBe("Failed: cargo test");
  });

  it("cargo: merges an existing -- section without duplicating --exact", () => {
    const c = rerunFailedConfig(cfg("cargo", "cargo", ["test", "--", "--nocapture", "--exact", "old"]), [
      ["src/lib.rs", "a"],
    ])!;
    expect(c.args).toEqual(["test", "--", "--nocapture", "old", "a", "--exact"]);
  });

  it("jest/vitest via npm: files + -t pattern", () => {
    const c = rerunFailedConfig(cfg("npm", "pnpm", ["run", "test"]), [
      ["src/a.test.ts", "math", "adds (1+1)"],
      ["src/b.test.ts"],
    ])!;
    expect(c.args).toEqual([
      "run",
      "test",
      "--",
      "src/a.test.ts",
      "src/b.test.ts",
      "-t",
      "^(?:math adds \\(1\\+1\\))$",
    ]);
  });

  it("pytest: node ids replace explicit paths", () => {
    const c = rerunFailedConfig(cfg("pytest", ".venv/bin/pytest", ["-q", "tests/", "-k", "slow"]), [
      ["tests/test_x.py", "TestC", "test_y[1]"],
      ["tests/test_z.py", "test_a"],
    ])!;
    expect(c.args).toEqual(["-q", "tests/test_x.py::TestC::test_y[1]", "tests/test_z.py::test_a"]);
  });

  it("go: -run with top-level names and packages", () => {
    const c = rerunFailedConfig(cfg("go", "go", ["test", "-v", "./..."]), [
      ["example.com/m/pkg", "TestAdd"],
      ["example.com/m/pkg", "TestSub", "case_1"],
      ["example.com/m/other", "TestX"],
    ])!;
    expect(c.args).toEqual([
      "test",
      "-v",
      "-run",
      "^(TestAdd|TestSub|TestX)$",
      "example.com/m/pkg",
      "example.com/m/other",
    ]);
  });

  it("gradle and maven filters", () => {
    expect(rerunFailedConfig(cfg("gradle", "./gradlew", ["test"]), [["com.a.FooTest", "bar()"]])!.args).toEqual([
      "test",
      "--tests",
      "com.a.FooTest.bar",
    ]);
    expect(
      rerunFailedConfig(cfg("maven", "mvn", ["test"]), [
        ["com.a.FooTest", "bar"],
        ["com.a.FooTest", "baz"],
        ["com.a.BarTest"],
      ])!.args,
    ).toEqual(["test", "-Dtest=com.a.FooTest#bar+baz,com.a.BarTest"]);
  });

  it("returns null when nothing failed or the framework is unknown", () => {
    expect(rerunFailedConfig(cfg("cargo", "cargo", ["test"]), [])).toBeNull();
    expect(rerunFailedConfig(cfg("make", "make", ["test"]), [["x"]])).toBeNull();
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
    // A plain script run (no pytest) and other frameworks are left alone.
    expect(withTestReporting(cfg("python", "python3", ["main.py"])).args).toEqual(["main.py"]);
    expect(withTestReporting(cfg("cargo", "cargo", ["test"])).args).toEqual(["test"]);
  });
});

describe("Go rerun argument boundaries", () => {
  it("replaces import-path targets without losing flag values or binary arguments", () => {
    const config = cfg("go", "go", ["test", "-tags", "demo", "-run", "old", "example.com/old", "-args", "-test.short"]);
    const rerun = rerunFailedConfig(config, [["example.com/new", "TestChild", "case"]])!;
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
  it("retains preparation of file-scoped configurations", () => {
    const config = {
      ...cfg("go", "go", ["test", "main_test.go"]),
      params: { goKind: "test", scope: "file", target: "main_test.go", module: "app", pattern: "", useTags: "true" },
    };
    const rerun = rerunFailedConfig(config, [["command-line-arguments", "TestFail"]])!;
    expect(rerun.params).toMatchObject({
      goKind: "test",
      scope: "file",
      target: "main_test.go",
      pattern: "^(TestFail)$",
    });
    expect(rerun.args).toEqual(["test", "-run", "^(TestFail)$", "main_test.go"]);
  });
});
