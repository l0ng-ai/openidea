import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { produceFile } from "../producers";
import { doctestType } from "../pythonTypes";
import { detectRunTargets, targetConfig } from "../targets";
import { createTestParser, frameworkFor, parseAll, TestResults, withTestReporting } from "./index";
import { doctestRerunArgs } from "./pythonDoctest";
import { matchesTarget } from "./states";
import REPORTER from "./doctestReporter.py?raw";

const python: RunConfig = {
  id: "python:module:app",
  name: "python -m app",
  kind: "python",
  command: ".venv/bin/python",
  args: ["-m", "app"],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "debugpy",
};

const MODULE = [
  '"""Prices.', // 0
  "",
  ">>> total([1, 2])",
  "3",
  '"""',
  "",
  "",
  "def total(xs):", // 7
  '    """Sum.',
  "",
  "    >>> total([])",
  "    0",
  '    """',
  "    def inner():", // 13
  '        """>>> 1"""',
  "    return sum(xs)",
  "",
  "",
  "class Cart:", // 18
  '    """No examples."""',
  "",
  "    def add(",
  "        self, x", // 22
  "    ):",
  "        '''",
  "        >>> Cart().add(1)",
  "        '''",
].join("\n");

describe("doctest targets", () => {
  it("finds docstrings with examples in modules, classes and functions", () => {
    const targets = detectRunTargets(MODULE, "shop/prices.py").map((t) => [t.line, t.kind, t.name, t.path.join(".")]);
    // Not `Cart` (no examples) nor `inner` (doctest doesn't look into functions).
    expect(targets).toEqual([
      [0, "suite", "prices", ""],
      [7, "test", "total", "total"],
      [21, "test", "Cart.add", "Cart.add"],
    ]);
  });

  it("shows the last result of an object's examples on its icon", () => {
    const [, fn] = detectRunTargets(MODULE, "shop/prices.py");
    expect(matchesTarget(["shop/prices.py", "total", "total([])"], { path: fn!.path, file: "shop/prices.py" })).toBe(
      true,
    );
    expect(matchesTarget(["shop/prices.py", "total"], { path: fn!.path, file: "shop/prices.py" })).toBe(true);
    expect(matchesTarget(["other.py", "total"], { path: fn!.path, file: "shop/prices.py" })).toBe(false);
  });

  it("keeps a test's own target on its line", () => {
    const src =
      "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        '''>>> 1\n        1\n        '''\n";
    expect(detectRunTargets(src, "tests/test_t.py").filter((t) => t.doctest)).toEqual([]);
  });

  it("doesn't take the lines of a string or a one-line def for code", () => {
    const src = [
      "class A:",
      "    def f(self):",
      '        q = """',
      "select 1", // flush left, in a string: A stays open
      '"""',
      "    def g(self):", // 5
      '        """',
      "        class of the docs, not a class", // prose
      "        >>> A().g()",
      '        """',
      "def one(): return 1", // 10: its body is on this line
      "class B:",
      '    """>>> B()"""',
    ].join("\n");
    expect(detectRunTargets(src, "a.py").map((t) => [t.line, t.name])).toEqual([
      [5, "A.g"],
      [11, "B"],
    ]);
  });

  it("runs the doctests of a module, class or function on the project interpreter", () => {
    const [module, fn, method] = detectRunTargets(MODULE, "shop/prices.py");
    expect(targetConfig(module!, "shop/prices.py", [python])).toMatchObject({
      kind: "doctest",
      name: "Doctests in prices",
      command: ".venv/bin/python",
      args: ["-m", "doctest", "shop/prices.py"],
      isTest: true,
    });
    expect(targetConfig(fn!, "shop/prices.py", [python])?.args).toEqual(["-m", "doctest", "shop/prices.py::total"]);
    expect(targetConfig(method!, "shop/prices.py", [python])).toMatchObject({
      name: "Doctests in add",
      args: ["-m", "doctest", "shop/prices.py::Cart.add"],
    });
  });

  it("runs a module's doctests from its context menu unless it is a program", () => {
    const input = { path: "/p/shop/prices.py", root: "/p", configs: [python], content: MODULE };
    expect(produceFile(input as never, {} as never)?.config?.args).toEqual(["-m", "doctest", "shop/prices.py"]);
    const program = { ...input, content: `${MODULE}\n\nif __name__ == "__main__":\n    total([])\n` };
    expect(produceFile(program as never, {} as never)?.config?.kind).not.toBe("doctest");
    // `>>>` in a string that isn't a docstring: a script, run as one.
    const script = { ...input, content: 'USAGE = """\n>>> import tool\n"""\nprint(USAGE)\n' };
    expect(produceFile(script as never, {} as never)?.config?.kind).not.toBe("doctest");
  });
});

describe("python -m doctest", () => {
  const doctest: RunConfig = { ...python, id: "d", kind: "doctest", args: ["-m", "doctest", "-o", "ELLIPSIS", "a.py"] };

  it("runs through the IDE's reporter, one record per example", () => {
    expect(frameworkFor(doctest)).toBe("python-doctest");
    const launch = withTestReporting(doctest);
    expect(launch.args).toEqual([
      "-c",
      'import os; exec(os.environ.pop("OPENIDEA_DOCTEST_REPORTER"))',
      "-o",
      "ELLIPSIS",
      "a.py",
    ]);
    expect(launch.env.OPENIDEA_DOCTEST_REPORTER).toBe(REPORTER);
    const mark = "@@openidea:test@@";
    const results = new TestResults();
    results.apply(
      parseAll(
        createTestParser(doctest),
        [
          `${mark}{"path": ["a.py", "total", "total([])"], "status": "passed", "line": 11}`,
          `${mark}{"path": ["a.py", "total", "total([1])"], "status": "failed", "line": 13, "error": "Failed example:\\n    total([1])\\nExpected:\\n    2\\nGot:\\n    1"}`,
        ].join("\n"),
      ),
    );
    expect(results.counts()).toMatchObject({ passed: 1, failed: 1 });
    const failed = results.firstFailure()!;
    expect(failed.location).toEqual({ path: "a.py", line: 13, resolve: "path" });
    expect(failed.output).toContain("Got:");
  });

  it("reruns the objects whose examples failed", () => {
    expect(
      doctestRerunArgs(
        ["run", "python", "-m", "doctest", "-o", "ELLIPSIS", "-f", "shop/prices.py", "other.py"],
        [
          ["shop/prices.py", "total", "total([1])"],
          ["shop/prices.py", "Cart.add", "Cart().add(1)"],
          ["other.py", "other", "x"],
        ],
      ),
    ).toEqual([
      "run",
      "python",
      "-m",
      "doctest",
      "-o",
      "ELLIPSIS",
      "-f",
      "shop/prices.py::total",
      "shop/prices.py::Cart.add",
      "other.py",
    ]);
    // The module's own docstring runs the whole file, which covers its objects.
    expect(
      doctestRerunArgs(
        ["-m", "doctest", "shop/prices.py"],
        [
          ["shop/prices.py", "shop.prices", "total([1, 2])"],
          ["shop/prices.py", "total", "total([1])"],
        ],
      ),
    ).toEqual(["-m", "doctest", "shop/prices.py"]);
    // Imported from a source root: `src/shop/money.py` is `shop.money`.
    expect(
      doctestRerunArgs(["-m", "doctest", "src/shop/money.py"], [["src/shop/money.py", "shop.money", "x"]]),
    ).toEqual(["-m", "doctest", "src/shop/money.py"]);
  });

  it("has a run configuration type", () => {
    const params = { command: "uv", runnerArgs: "run python", target: "a.py::Cart b.py", options: "-o ELLIPSIS -f" };
    const line = doctestType.commandLine(params)!;
    expect(line).toEqual({
      command: "uv",
      args: ["run", "python", "-m", "doctest", "-o", "ELLIPSIS", "-f", "a.py::Cart", "b.py"],
    });
    expect(doctestType.paramsFrom!({ ...doctest, ...line })).toEqual(params);
  });
});
