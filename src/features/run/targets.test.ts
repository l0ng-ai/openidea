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

  it("python: unittest TestCase subclasses in tests.py (Django's default test module)", () => {
    const src = [
      "from django.test import TestCase",
      "class QuestionTests(TestCase):",
      "    def test_recent(self):",
      "        pass",
      "class Helper(Mixin):",
      "    def test_no(self): pass",
    ].join("\n");
    expect(pick(detectRunTargets(src, "polls/tests.py", true))).toEqual([
      [1, "suite", "QuestionTests"],
      [2, "test", "QuestionTests/test_recent"],
    ]);
    expect(pick(detectRunTargets(src, "polls/models.py", true))).toEqual([]);
    // Outside Django projects `tests.py` is a script: no test targets.
    expect(pick(detectRunTargets(src, "polls/tests.py"))).toEqual([]);
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
      "src/a.test.ts",
      "-t",
      "^m adds$",
    ]);
    expect(first("class TestC:\n    def test_a(self): pass", "tests/test_c.py").args).toEqual([
      "tests/test_c.py::TestC::test_a",
    ]);
    // pytest also collects TestCase subclasses.
    expect(first("class QTests(TestCase):\n    def test_a(self): pass", "app/test_q.py").args).toEqual([
      "app/test_q.py::QTests::test_a",
    ]);
    const django = [cfg({ id: "django:test", kind: "django-test", command: "python3", args: ["manage.py", "test"] })];
    const test = detectRunTargets("class QTests(TestCase):\n    def test_a(self): pass", "polls/tests.py", true)[1]!;
    expect(targetConfig(test, "polls/tests.py", django)!.args).toEqual([
      "manage.py",
      "test",
      "polls.tests.QTests.test_a",
    ]);
    // A module-level function or a plain class: unittest's loader would call it, so no Django run.
    const fn = detectRunTargets("def test_top():\n    pass", "polls/tests.py", true)[0]!;
    expect(targetConfig(fn, "polls/tests.py", django)).toBeNull();
    // Relative to the working directory, where manage.py is.
    const nested = [{ ...django[0]!, cwd: "backend" }];
    expect(targetConfig(test, "backend/polls/tests/test_q.py", nested)!.args).toEqual([
      "manage.py",
      "test",
      "polls.tests.test_q.QTests.test_a",
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
      args: [
        "test",
        "-tags",
        "demo",
        "-run",
        "Old",
        ".",
        "-args",
        "-test.run=Old",
        "-test.bench",
        "OldBench",
        "-test.short",
      ],
      params: {
        goKind: "test",
        module: "app",
        scope: "package",
        target: ".",
        pattern: "Old",
        programArgs: "-test.run=Old -test.bench OldBench -test.short",
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
      programArgs: "-test.short",
    });
  });
});

describe("php (PHPUnit)", () => {
  const src = [
    "<?php", // 0
    "namespace App\\Tests;",
    "use PHPUnit\\Framework\\TestCase;",
    "final class CalcTest extends TestCase", // 3
    "{",
    "    public function testAdd(): void {}", // 5
    "    #[Test]",
    "    public function subtracts(): void {}", // 7
    "    /** @test */",
    "    public function multiplies(): void {}", // 9
    "    public function helper(): void {}",
    "    private function testHidden(): void {}",
    "}",
    "class Helper {}",
    "    public function testNotInTestClass() {}",
  ].join("\n");

  it("finds test classes and test methods", () => {
    expect(pick(detectRunTargets(src, "tests/CalcTest.php"))).toEqual([
      [3, "suite", "CalcTest"],
      [5, "test", "CalcTest/testAdd"],
      [7, "test", "CalcTest/subtracts"],
      [9, "test", "CalcTest/multiplies"],
    ]);
  });

  it("ignores files that are not tests", () => {
    expect(detectRunTargets(src, "src/Calc.php")).toEqual([]);
  });

  it("runs a method with --filter ahead of the file", () => {
    const phpunit = cfg({ id: "phpunit", kind: "phpunit", command: "vendor/bin/phpunit" });
    const target = detectRunTargets(src, "tests/CalcTest.php")[1]!;
    const run = targetConfig(target, "tests/CalcTest.php", [phpunit], src);
    expect(run?.args).toEqual(["--filter", "/(CalcTest::testAdd( with data set .*)?)$/", "tests/CalcTest.php"]);
    expect(run?.command).toBe("vendor/bin/phpunit");
  });
});

describe("php (Pest)", () => {
  const src = [
    "<?php", // 0
    "",
    "test('adds numbers', function () {", // 2
    "    expect(1 + 1)->toBe(2);",
    "});",
    "",
    'it("handles \\"quoted\\" names", fn () => true);', // 6
    "",
    "describe('division', function () {", // 8
    "    it('divides', function () {", // 9
    "        expect(4 / 2)->toBe(2);",
    "    });",
    "",
    "    describe('by zero', function () {", // 13
    "        test('throws', fn () => true);", // 14
    "    });",
    "});",
    "",
    "it('doubles', function (int $n) {", // 18
    "    expect($n * 2)->toBe($n + $n);",
    "})->with([1, 2, 3]);",
    "// it('is commented out')",
  ].join("\n");
  const pest = cfg({ id: "phpunit", kind: "phpunit", command: "vendor/bin/pest" });
  const run = (line: number) => {
    const target = detectRunTargets(src, "tests/Unit/MathTest.php").find((t) => t.line === line)!;
    return targetConfig(target, "tests/Unit/MathTest.php", [pest], src);
  };

  it("finds tests and describe blocks with the names Pest gives them", () => {
    expect(pick(detectRunTargets(src, "tests/Unit/MathTest.php"))).toEqual([
      [2, "test", "adds numbers"],
      [6, "test", 'it handles "quoted" names'],
      [8, "suite", "division"],
      [9, "test", "division/it divides"],
      [13, "suite", "division/by zero"],
      [14, "test", "division/by zero/throws"],
      [18, "test", "it doubles"],
    ]);
    expect(detectRunTargets(src, "tests/Unit/MathTest.php")[3]).toMatchObject({
      name: "division → it divides",
      pest: true,
    });
  });

  it("ignores files that are not tests", () => {
    expect(detectRunTargets(src, "src/Math.php")).toEqual([]);
  });

  it("runs one test by the name Pest matches, data sets included", () => {
    expect(run(2)?.args).toEqual(["--filter", "/::adds numbers( with data set .*)?$/", "tests/Unit/MathTest.php"]);
    expect(run(14)?.args).toEqual([
      "--filter",
      "/::`division` → `by zero` → throws( with data set .*)?$/",
      "tests/Unit/MathTest.php",
    ]);
    expect(run(18)?.args[1]).toBe("/::it doubles( with data set .*)?$/");
    expect(run(18)?.command).toBe("vendor/bin/pest");
  });

  it("runs every test of a describe block", () => {
    expect(run(8)?.args[1]).toBe("/::`division` → /");
    expect(run(13)?.args[1]).toBe("/::`division` → `by zero` → /");
  });

  it("keeps PHPUnit classes in the same file", () => {
    const mixed = [
      "<?php",
      "final class CalcTest extends TestCase",
      "{",
      "    public function testAdd() {}",
      "}",
      "test('x', fn () => 1);",
    ];
    expect(pick(detectRunTargets(mixed.join("\n"), "tests/CalcTest.php"))).toEqual([
      [1, "suite", "CalcTest"],
      [3, "test", "CalcTest/testAdd"],
      [5, "test", "x"],
    ]);
  });
});

describe("Go declaration and callback scopes", () => {
  it("finds aliased, dot-imported and multiline testing declarations", () => {
    const text = [
      "package p",
      'import check "testing"',
      "func TestAlias(",
      "  subject *check.T,",
      ") {",
      '  subject.Run("outer", func(child *check.T) {',
      "    child.Run(`nested/leaf case`, func(last *check.T) {})",
      "  })",
      '  subject.Run("sibling", func(child *check.T) {})',
      "}",
      "func BenchmarkAlias(b *check.B) {}",
      "func FuzzAlias(f *check.F) {}",
      "func Example() {}",
      "func TestMain(m *check.M) {}",
      "func Testlower(t *check.T) {}",
      "func (s Suite) TestMethod(t *check.T) {}",
    ].join("\n");
    expect(detectRunTargets(text, "alias_test.go").map((target) => target.path)).toEqual([
      ["TestAlias"],
      ["TestAlias", "outer"],
      ["TestAlias", "outer", "nested", "leaf_case"],
      ["TestAlias", "sibling"],
      ["BenchmarkAlias"],
      ["FuzzAlias"],
      ["Example"],
    ]);
    expect(
      detectRunTargets('package p\nimport . "testing"\nfunc TestDot(t *T) {}', "dot_test.go").map(
        (target) => target.path,
      ),
    ).toEqual([["TestDot"]]);
  });

  it("ignores comments, strings, methods and unrelated Run receivers", () => {
    const text = [
      "package p",
      "/* func TestComment(t *testing.T) {} */",
      "var fake = `",
      "func TestString(t *testing.T) {}",
      "//go:generate fake",
      "`",
      "func TestReal(t *testing.T) {",
      '  // t.Run("comment", nil)',
      '  _ = `t.Run("string", nil) }`',
      '  other.Run("unrelated", nil)',
      '  t.Run("a\\x20b", func(sub *testing.T) {',
      '    sub.Run("quote\\\"brace}", nil)',
      "  })",
      "}",
      "//go:generate real",
    ].join("\n");
    expect(detectRunTargets(text, "real_test.go").map((target) => [target.line, target.path])).toEqual([
      [6, ["TestReal"]],
      [10, ["TestReal", "a_b"]],
      [11, ["TestReal", "a_b", 'quote"brace}']],
      [14, ["14"]],
    ]);
  });

  it("keeps nested benchmark paths and tolerates incomplete source", () => {
    const text =
      'package p\nfunc BenchmarkWork(b *testing.B) { b.Run("group", func(inner *testing.B) { inner.Run("leaf", nil) }) }';
    expect(detectRunTargets(text, "bench_test.go").map((target) => target.path)).toEqual([
      ["BenchmarkWork"],
      ["BenchmarkWork", "group"],
      ["BenchmarkWork", "group", "leaf"],
    ]);
    expect(() =>
      detectRunTargets('func TestBroken(t *testing.T) { t.Run("\\UFFFFFFFF", nil) }', "broken_test.go"),
    ).not.toThrow();
  });
});
