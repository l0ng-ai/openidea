import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { detectRunTargets, jsNamePattern, targetConfig } from "./targets";

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: over.kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
  ...over,
});

const pick = (ts: ReturnType<typeof detectRunTargets>) => ts.map((t) => [t.line, t.kind, t.path.join("/")]);

describe("detectRunTargets", () => {
  it("rust: main, #[test] fns with module path, test modules", () => {
    const src = [
      "fn main() {}", // 0
      "#[cfg(test)]",
      "mod tests {", // 2
      "    use super::*;",
      "    #[test]",
      '    fn adds() { let s = "}"; }', // 5
      "    #[tokio::test]",
      "    #[ignore]",
      "    async fn async_one() {}", // 8
      "    fn helper() {}",
      "}",
      "fn after() {}",
    ].join("\n");
    expect(pick(detectRunTargets(src, "src/main.rs"))).toEqual([
      [0, "main", ""],
      [2, "suite", "tests"],
      [5, "test", "tests/adds"],
      [8, "test", "tests/async_one"],
    ]);
    expect(pick(detectRunTargets("#[test]\nfn x() {}", "crates/a/src/foo/bar.rs"))).toEqual([[1, "test", "foo/bar/x"]]);
    expect(detectRunTargets("fn main() {}", "src/lib.rs")).toEqual([]);
  });

  it("js/ts: describe chains and test names", () => {
    const src = [
      "describe('math', () => {",
      "  it('adds', () => {});",
      '  describe("nested", () => {',
      "    test.each([[1]])('n=%i', () => {});",
      "  });",
      "  test.skip(`subs`, () => {});",
      "});",
      "const item = items.find((x) => x);",
      "test('top', () => {});",
    ].join("\n");
    const ts = detectRunTargets(src, "src/math.test.ts");
    expect(pick(ts)).toEqual([
      [0, "suite", "math"],
      [1, "test", "math/adds"],
      [2, "suite", "math/nested"],
      [3, "test", "math/nested/n=%i"],
      [5, "test", "math/subs"],
      [8, "test", "top"],
    ]);
    expect(ts[3]!.parameterized).toBe(true);
    expect(jsNamePattern(ts[1]!)).toBe("^math adds$");
    expect(jsNamePattern(ts[3]!)).toBe("^math nested n=.*$");
    expect(jsNamePattern(ts[0]!)).toBe("^math");
    expect(detectRunTargets("test('x', () => {})", "src/math.ts")).toEqual([]);
  });

  it("python: test functions, Test classes, __main__", () => {
    const src = [
      "class TestCalc:",
      "    def test_add(self):",
      "        pass",
      "def test_top():",
      "    pass",
      "class Helper:",
      "    def test_no(self): pass",
      'if __name__ == "__main__":',
    ].join("\n");
    expect(pick(detectRunTargets(src, "tests/test_calc.py"))).toEqual([
      [0, "suite", "TestCalc"],
      [1, "test", "TestCalc/test_add"],
      [3, "test", "test_top"],
      [7, "main", ""],
    ]);
  });

  it("go and jvm", () => {
    expect(
      pick(detectRunTargets("package x\n\nfunc TestAdd(t *testing.T) {}\nfunc helper() {}", "pkg/add_test.go")),
    ).toEqual([[2, "test", "TestAdd"]]);
    expect(pick(detectRunTargets("package main\nfunc main() {}", "cmd/app/main.go"))).toEqual([[1, "main", ""]]);
    // Subtests: literal names, map-keyed tables; a one-line test has none.
    const go = [
      "package x",
      "func TestOne(t *testing.T) {}",
      "func TestMap(t *testing.T) {",
      "\tcases := map[string]struct{ in int }{",
      '\t\t"small n": {in: 1},',
      "\t}",
      "\tfor name, tc := range cases {",
      "\t\tt.Run(name, func(t *testing.T) { _ = tc })",
      "\t}",
      '\tt.Run("a\\"b", nil)',
      "}",
    ].join("\n");
    expect(pick(detectRunTargets(go, "x_test.go"))).toEqual([
      [1, "test", "TestOne"],
      [2, "test", "TestMap"],
      [4, "test", "TestMap/small_n"],
      [9, "test", 'TestMap/a"b'],
    ]);
    const kt = ["class CalcTest {", "  @Test", "  fun `adds numbers`() {}", "  @Test fun subs() {}", "}"].join("\n");
    expect(pick(detectRunTargets(kt, "src/test/kotlin/CalcTest.kt"))).toEqual([
      [0, "suite", "CalcTest"],
      [2, "test", "CalcTest/adds numbers"],
      [3, "test", "CalcTest/subs"],
    ]);
  });
});

describe("targetConfig", () => {
  const configs = [
    cfg({ id: "cargo:test", kind: "cargo", args: ["test"] }),
    cfg({ id: "npm:test", kind: "npm", command: "pnpm", args: ["run", "test"] }),
    cfg({ id: "pytest", kind: "pytest", command: "pytest", args: [] }),
    cfg({ id: "go:test", kind: "go", command: "go", args: ["test", "./..."] }),
    cfg({ id: "gradle:test", kind: "gradle", command: "./gradlew", args: ["test"] }),
  ];
  const first = (src: string, rel: string, i = 0) =>
    targetConfig(detectRunTargets(src, rel).filter((t) => t.kind !== "suite")[i]!, rel, configs)!;

  it("derives per-framework filters", () => {
    expect(first("mod tests {\n#[test]\nfn adds() {}\n}", "src/lib.rs").args).toEqual([
      "test",
      "--",
      "tests::adds",
      "--exact",
    ]);
    expect(first("#[test]\nfn it_works() {}", "tests/api.rs").args).toEqual([
      "test",
      "--test",
      "api",
      "--",
      "it_works",
      "--exact",
    ]);
    expect(first("describe('m', () => {\n  it('adds', () => {});\n});", "src/a.test.ts").args).toEqual([
      "run",
      "test",
      "--",
      "src/a.test.ts",
      "-t",
      "^m adds$",
    ]);
    expect(first("class TestC:\n    def test_a(self): pass", "tests/test_c.py").args).toEqual([
      "tests/test_c.py::TestC::test_a",
    ]);
    expect(first("func TestAdd(t *testing.T) {}", "pkg/add_test.go").args).toEqual([
      "test",
      "./pkg",
      "-run",
      "^TestAdd$",
    ]);
    expect(first("class FooTest {\n  @Test\n  void bar() {}\n}", "src/test/java/FooTest.java").args).toEqual([
      "test",
      "--tests",
      "FooTest.bar",
    ]);
  });

  it("names configs after the target and keeps ids stable", () => {
    const c = first("mod tests {\n#[test]\nfn adds() {}\n}", "src/lib.rs");
    expect(c.name).toBe("adds");
    expect(c.id).toBe("context:target:cargo:test:src/lib.rs:tests/adds");
  });
});

describe("Go test targets", () => {
  it("detects benchmark, fuzz and example functions and runs a benchmark without tests", () => {
    const text =
      "package main\nfunc main() {}\nfunc BenchmarkWork(b *testing.B) {}\nfunc FuzzInput(f *testing.F) {}\nfunc Example() {}\n// func TestComment(t *testing.T) {}";
    const targets = detectRunTargets(text, "work_test.go");
    expect(targets.map((t) => t.name)).toEqual(["main", "BenchmarkWork", "FuzzInput", "Example"]);
    const base = cfg({ id: "go:test", kind: "go", args: ["test", "-tags", "demo", "./...", "-args", "-test.short"] });
    const config = targetConfig(targets[1]!, "work_test.go", [base], text)!;
    expect(config.args).toEqual([
      "test",
      "-tags",
      "demo",
      ".",
      "-run",
      "^$",
      "-bench",
      "^BenchmarkWork$",
      "-args",
      "-test.short",
    ]);
  });
  it("uses the module and overrides a saved filter before binary arguments", () => {
    const base = cfg({
      id: "go:typed",
      kind: "go",
      cwd: "runtime",
      args: ["test", "-tags", "demo", "-run", "Old", ".", "-args", "-test.short"],
      params: {
        goKind: "test",
        module: "app",
        scope: "package",
        target: ".",
        pattern: "Old",
        programArgs: "-test.short",
      },
    });
    const text = 'package calc\nfunc TestNew(t *testing.T) {\n t.Run("child case", func(t *testing.T) {})\n}';
    const targets = detectRunTargets(text, "app/calc_test.go");
    const config = targetConfig(targets[1]!, "app/calc_test.go", [base], text, base)!;
    expect(config.args).toEqual([
      "test",
      "-tags",
      "demo",
      ".",
      "-run",
      "^TestNew$/^child_case$",
      "-args",
      "-test.short",
    ]);
    expect(config.params).toMatchObject({
      module: "app",
      scope: "directory",
      target: ".",
      pattern: "^TestNew$/^child_case$",
    });
  });
});
