import { afterEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { testBasesFor, testConfigFor } from "../context";
import { produceDirectory } from "../producers";
import { unittestType } from "../pythonTypes";
import { detectRunTargets, targetConfig } from "../targets";
import { createTestParser, frameworkFor, parseAll, TestResults, withTestReporting } from "./index";
import { REPORTER_VAR, unittestRerunArgs, withUnittestReporter } from "./pythonUnittest";
import { failedTestPaths, rerunFailedConfig } from "./rerun";
import REPORTER from "./unittestReporter.py?raw";

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: "python3",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: "debugpy",
  ...over,
});
const unittest = cfg({ id: "unittest", kind: "unittest", args: ["-m", "unittest"] });
const pytest = cfg({ id: "pytest", kind: "pytest", command: "pytest" });
const runner = (testRunner: string) =>
  useProject.setState({ settings: { languages: { python: { testRunner } } } } as never);

afterEach(() => useProject.setState({ settings: null } as never));

describe("python -m unittest", () => {
  it("runs through the IDE's reporter with the same arguments", () => {
    expect(frameworkFor(unittest)).toBe("python-unittest");
    expect(frameworkFor(cfg({ id: "p", kind: "python", args: ["-m", "unittest", "-v"] }))).toBe("python-unittest");
    const bootstrap = `import os; exec(os.environ.pop("${REPORTER_VAR}"))`;
    expect(withUnittestReporter({ args: ["run", "python", "-m", "unittest", "tests", "-f"], env: { A: "1" } })).toEqual(
      {
        args: ["run", "python", "-c", bootstrap, "tests", "-f"],
        env: { A: "1", [REPORTER_VAR]: REPORTER },
      },
    );
    const launch = withTestReporting({ ...unittest, args: ["-m", "unittest", "discover", "-s", "tests"] });
    expect(launch.args).toEqual(["-c", bootstrap, "discover", "-s", "tests"]);
    expect(launch.env?.[REPORTER_VAR]).toBe(REPORTER);
  });

  it("reads the reporter's records into the tree", () => {
    const mark = "@@openidea:test@@";
    const out = [
      ".taking one apple",
      `${mark}{"path": ["tests.test_stock", "StockTests", "test_take"], "status": "passed", "ms": 0.2, "file": "tests/test_stock.py", "line": 16, "error": "taking one apple"}`,
      `${mark}{"path": ["tests.test_stock", "StockTests", "test_sub", "(i=1)"], "status": "failed", "file": "tests/test_stock.py", "line": 30, "error": "AssertionError: 1 != 0"}`,
      `${mark}{"path": ["tests.test_broken"], "status": "failed", "error": "ImportError: Failed to import test module: tests.test_broken"}`,
    ].join("\n");
    const results = new TestResults();
    results.apply(parseAll(createTestParser(unittest), out));
    const take = results.get(["tests.test_stock", "StockTests", "test_take"].join("\u0000"));
    expect(take?.own).toBe("passed");
    expect(take?.output).toEqual(["taking one apple"]);
    // Named by module: the file comes with the record.
    expect(take?.location).toEqual({ path: "tests/test_stock.py", line: 16, resolve: "path" });
    expect(results.counts()).toMatchObject({ passed: 1, failed: 2, total: 3 });
    expect(failedTestPaths(results)).toEqual([
      ["tests.test_stock", "StockTests", "test_sub", "(i=1)"],
      ["tests.test_broken"],
    ]);
  });

  it("reruns failed tests with -k patterns in place of the run's own", () => {
    expect(
      unittestRerunArgs(
        ["-m", "unittest", "discover", "-s", "tests", "-k", "old", "-kother"],
        [
          ["tests.test_stock", "StockTests", "test_a", "(i=1)"],
          ["tests.test_stock", "StockTests", "test_a", "(i=2)"],
          ["tests.test_stock", "Fixture"],
          ["tests.test_broken"],
        ],
      ),
    ).toEqual([
      "-m",
      "unittest",
      "discover",
      "-s",
      "tests",
      "-k",
      "*tests.test_stock.StockTests.test_a",
      "-k",
      "*tests.test_stock.Fixture.*",
      "-k",
      "*tests.test_broken.*",
    ]);
    const rerun = rerunFailedConfig(unittest, [["m", "C", "t"]]) as RunConfig;
    expect(rerun.args).toEqual(["-m", "unittest", "-k", "*m.C.t"]);
  });

  it("has a run configuration type", () => {
    const params = { command: "uv", runnerArgs: "run python", target: "tests.test_stock", options: "-f" };
    const line = unittestType.commandLine(params)!;
    expect(line).toEqual({ command: "uv", args: ["run", "python", "-m", "unittest", "tests.test_stock", "-f"] });
    expect(unittestType.paramsFrom!(cfg({ id: "u", kind: "unittest", ...line }))).toEqual(params);
    const discover = ["-m", "unittest", "discover", "-s", "tests", "-p", "check_*.py"];
    expect(unittestType.paramsFrom!(cfg({ id: "u", kind: "unittest", args: discover }))).toMatchObject({
      target: "discover -s tests -p check_*.py",
      options: "",
    });
  });
});

describe("running unittest tests from the editor", () => {
  const module = "import unittest\n\nclass StockTests(unittest.TestCase):\n    def test_add(self):\n        pass\n";

  it("narrows the project's unittest run to a module, class or test", () => {
    expect(testConfigFor("tests/test_stock.py", [unittest])!.args).toEqual(["-m", "unittest", "tests.test_stock"]);
    const [cls, test] = detectRunTargets(module, "tests/test_stock.py");
    expect(targetConfig(cls!, "tests/test_stock.py", [unittest], module)!.args).toEqual([
      "-m",
      "unittest",
      "tests.test_stock.StockTests",
    ]);
    expect(targetConfig(test!, "tests/test_stock.py", [unittest], module)!.args).toEqual([
      "-m",
      "unittest",
      "tests.test_stock.StockTests.test_add",
    ]);
    // A module-level function is pytest's: unittest can't run it.
    const fn = detectRunTargets("def test_x():\n    pass\n", "tests/test_x.py")[0]!;
    expect(targetConfig(fn, "tests/test_x.py", [unittest])).toBeNull();
  });

  it("discovers a folder's tests", () => {
    const produced = produceDirectory({ path: "/p/tests", root: "/p", configs: [unittest] } as never);
    expect(produced?.config?.args).toEqual(["-m", "unittest", "discover", "-s", "tests"]);
  });

  it("picks the runner by the Default test runner setting", () => {
    const python = cfg({ id: "python:module:app", kind: "python", args: ["-m", "app"], isTest: false });
    // Autodetect without a test configuration: unittest for a module of unittest tests, else pytest.
    expect(testBasesFor("tests/test_stock.py", [python], module)[0]).toMatchObject({
      kind: "unittest",
      args: ["-m", "unittest"],
    });
    expect(testBasesFor("tests/test_x.py", [python], "def test_x():\n    pass\n")[0]?.kind).toBe("pytest");
    expect(testBasesFor("tests/test_x.py", [python], `import pytest\n${module}`)[0]?.kind).toBe("pytest");
    // A project's pytest configuration wins under Autodetect…
    expect(testBasesFor("tests/test_stock.py", [pytest, unittest], module)[0]?.id).toBe("pytest");
    // …and the chosen runner sets the other one's aside.
    runner("unittest");
    expect(testBasesFor("tests/test_stock.py", [pytest], module)[0]).toMatchObject({ id: "unittest:implicit" });
    expect(produceDirectory({ path: "/p/tests", root: "/p", configs: [pytest] } as never)?.config?.kind).toBe(
      "unittest",
    );
    runner("pytest");
    expect(testBasesFor("tests/test_stock.py", [unittest], module)[0]?.kind).toBe("pytest");
  });
});
