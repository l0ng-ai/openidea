import { describe, expect, it } from "vitest";
import {
  cargoParser,
  createTestParser,
  frameworkFor,
  goParser,
  jsParser,
  jvmParser,
  nodeOutput,
  nodeStatus,
  parseAll,
  parseDuration,
  pytestParser,
  TestResults,
  type TestOutputParser,
} from "./index";
import { moveToReportedClasses } from "./jvm";

function results(parser: TestOutputParser, text: string) {
  const r = new TestResults();
  r.apply(parseAll(parser, text));
  return r;
}

function leaf(r: TestResults, ...path: string[]) {
  return r.get(path.join("\u0000"));
}

describe("parseDuration", () => {
  it("parses common forms", () => {
    expect(parseDuration("(3 ms)")).toBe(3);
    expect(parseDuration("1.2 s")).toBe(1200);
    expect(parseDuration("0.00s")).toBe(0);
    expect(parseDuration("12ms")).toBe(12);
    expect(parseDuration("1m 3s")).toBe(63_000);
    expect(parseDuration("0.05 sec")).toBe(50);
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration("soon")).toBeUndefined();
  });
});

describe("cargo test", () => {
  const fixture = `   Compiling app v0.1.0 (/p/app)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 0.52s
     Running unittests src/lib.rs (target/debug/deps/app-1a2b3c)

running 3 tests
test tests::adds ... ok
test tests::slow ... ignored, needs network
test tests::subtracts ... FAILED

failures:

---- tests::subtracts stdout ----

thread 'tests::subtracts' panicked at src/lib.rs:20:9:
assertion \`left == right\` failed
  left: 1
 right: 2
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::subtracts

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/api.rs (target/debug/deps/api-9f8e7d)

running 1 test
test health ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

  it("builds a tree per test binary and module", () => {
    const r = results(cargoParser(), fixture);
    expect(r.roots.map((n) => n.name)).toEqual(["src/lib.rs", "tests/api.rs"]);
    expect(leaf(r, "src/lib.rs", "tests", "adds")?.own).toBe("passed");
    expect(leaf(r, "src/lib.rs", "tests", "slow")?.own).toBe("skipped");
    expect(leaf(r, "tests/api.rs", "health")?.own).toBe("passed");
    expect(nodeStatus(r.roots[0]!)).toBe("failed");
    expect(nodeStatus(r.roots[1]!)).toBe("passed");
  });

  it("captures failure output and panic location", () => {
    const r = results(cargoParser(), fixture);
    const failed = leaf(r, "src/lib.rs", "tests", "subtracts")!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toEqual({ path: "src/lib.rs", line: 20, col: 9, resolve: "path" });
    expect(failed.output.join("\n")).toContain("left: 1");
    expect(r.firstFailure()?.id).toBe(failed.id);
  });

  it("accumulates summaries across binaries", () => {
    const r = results(cargoParser(), fixture);
    expect(r.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, durationMs: 10 });
    expect(r.counts()).toMatchObject({ passed: 2, failed: 1, skipped: 1, total: 4 });
  });

  it("supports the pre-1.73 panic format", () => {
    const r = results(
      cargoParser(),
      `test it_fails ... FAILED\n---- it_fails stdout ----\nthread 'it_fails' panicked at 'boom', src/main.rs:3:5\n`,
    );
    expect(leaf(r, "it_fails")?.location).toMatchObject({ path: "src/main.rs", line: 3, col: 5 });
  });

  it("parses nextest", () => {
    const r = results(
      cargoParser(),
      `        PASS [   0.004s] app tests::adds
        FAIL [   0.120s] app tests::subtracts
     Summary [   0.130s] 2 tests run: 1 passed, 1 failed, 0 skipped`,
    );
    expect(leaf(r, "app", "tests", "adds")).toMatchObject({ own: "passed", durationMs: 4 });
    expect(leaf(r, "app", "tests", "subtracts")?.own).toBe("failed");
    expect(r.summary).toMatchObject({ passed: 1, failed: 1, durationMs: 130 });
  });
});

describe("jest", () => {
  const verbose = `PASS src/math.test.ts
  math
    ✓ adds (2 ms)
    nested
      ✓ deep (1 ms)
  ✓ top level

FAIL src/order.test.ts (5.2 s)
  orders
    ✓ lists (3 ms)
    ✕ creates (12 ms)
    ○ skipped later

  ● orders › creates

    expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 1

      at Object.<anonymous> (node_modules/expect/build/index.js:1:1)
      at Object.<anonymous> (src/order.test.ts:14:21)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 skipped, 4 passed, 6 total
Snapshots:   0 total
Time:        6.1 s
`;

  it("nests describe blocks by indentation", () => {
    const r = results(jsParser(), verbose);
    expect(leaf(r, "src/math.test.ts", "math", "adds")).toMatchObject({ own: "passed", durationMs: 2 });
    expect(leaf(r, "src/math.test.ts", "math", "nested", "deep")?.own).toBe("passed");
    expect(leaf(r, "src/math.test.ts", "top level")?.own).toBe("passed");
    expect(leaf(r, "src/order.test.ts", "orders", "skipped later")?.own).toBe("skipped");
    expect(nodeStatus(r.get("src/order.test.ts")!)).toBe("failed");
  });

  it("links failures to the first project stack frame", () => {
    const r = results(jsParser(), verbose);
    const failed = leaf(r, "src/order.test.ts", "orders", "creates")!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toEqual({ path: "src/order.test.ts", line: 14, col: 21, resolve: "path" });
    expect(failed.output.some((l) => l.includes("Expected: 2"))).toBe(true);
  });

  it("reads the summary", () => {
    const r = results(jsParser(), verbose);
    expect(r.summary).toMatchObject({ passed: 4, failed: 1, skipped: 1, durationMs: 6100 });
  });

  it("creates failed tests from non-verbose output", () => {
    const r = results(
      jsParser(),
      `PASS src/a.test.js
FAIL src/b.test.js
  ● suite › broken

    boom

      at Object.<anonymous> (src/b.test.js:3:9)
`,
    );
    expect(r.get("src/a.test.js")?.own).toBe("passed");
    expect(leaf(r, "src/b.test.js", "suite", "broken")?.location?.line).toBe(3);
  });
});

describe("vitest", () => {
  const fixture = ` RUN  v3.2.4 /p/web

 ✓ src/a.test.ts (2 tests) 3ms
 ❯ src/b.test.ts (2 tests | 1 failed) 7ms
   ✓ cart > adds item 1ms
   × cart > removes item 4ms
     → expected 1 to be 0

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/b.test.ts > cart > removes item
AssertionError: expected 1 to be 0 // Object.is equality
 ❯ src/b.test.ts:12:17
     10|   it("removes item", () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)
   Start at  10:00:00
   Duration  412ms
`;

  it("builds file and test nodes", () => {
    const r = results(jsParser(), fixture);
    expect(r.get("src/a.test.ts")).toMatchObject({ own: "passed", durationMs: 3 });
    expect(leaf(r, "src/b.test.ts", "cart", "adds item")?.own).toBe("passed");
    expect(leaf(r, "src/b.test.ts", "cart", "removes item")).toMatchObject({ own: "failed", durationMs: 4 });
    expect(nodeStatus(r.get("src/b.test.ts")!)).toBe("failed");
  });

  it("keeps the summary out of a failure's output", () => {
    const output = leaf(results(jsParser(), fixture), "src/b.test.ts", "cart", "removes item")!.output;
    expect(output[0]).toBe("AssertionError: expected 1 to be 0 // Object.is equality");
    expect(output.some((l) => l.includes("Test Files") || l.includes("⎯"))).toBe(false);
  });

  it("links the failure location", () => {
    const r = results(jsParser(), fixture);
    expect(leaf(r, "src/b.test.ts", "cart", "removes item")?.location).toEqual({
      path: "src/b.test.ts",
      line: 12,
      col: 17,
      resolve: "path",
    });
  });

  it("reads counts and duration", () => {
    const r = results(jsParser(), fixture);
    expect(r.summary).toMatchObject({ passed: 3, failed: 1, durationMs: 412 });
    expect(r.counts()).toMatchObject({ passed: 3, failed: 1 });
  });

  it("gives each test its console output, and a group that of its tests", () => {
    const r = results(
      jsParser(),
      `stdout | src/a.test.ts
file level log

stdout | src/a.test.ts > cart > adds
adding item

stderr | src/a.test.ts > cart > adds
warn: low stock

stdout | src/a.test.ts > top
top line 1
top line 2

 ✓ src/a.test.ts > cart > adds 1ms
 ✓ src/a.test.ts > top 0ms
`,
    );
    const adds = leaf(r, "src/a.test.ts", "cart", "adds")!;
    expect(adds).toMatchObject({ own: "passed", output: ["adding item", "warn: low stock"] });
    expect(leaf(r, "src/a.test.ts", "top")?.output).toEqual(["top line 1", "top line 2"]);
    expect(nodeOutput(r.get("src/a.test.ts")!)).toEqual([
      "file level log",
      "adding item",
      "warn: low stock",
      "top line 1",
      "top line 2",
    ]);
  });

  it("nests the default reporter's failed tests under their suites", () => {
    const r = results(
      jsParser(),
      ` ❯ tests/cart.test.ts (5 tests | 1 failed) 12ms
   ❯ Cart (4)
     × intentionally fails 10ms
   × top level fails 1ms

 FAIL  tests/cart.test.ts > Cart > intentionally fails
AssertionError: x
`,
    );
    expect(leaf(r, "tests/cart.test.ts", "Cart", "intentionally fails")).toMatchObject({
      own: "failed",
      durationMs: 10,
    });
    expect(leaf(r, "tests/cart.test.ts", "intentionally fails")).toBeUndefined();
    expect(leaf(r, "tests/cart.test.ts", "top level fails")?.own).toBe("failed");
    expect(r.counts().failed).toBe(2);
  });

  it("handles flat verbose lines", () => {
    const r = results(jsParser(), ` ✓ src/x.test.ts > group > works 2ms\n ↓ src/x.test.ts > group > later`);
    expect(leaf(r, "src/x.test.ts", "group", "works")?.own).toBe("passed");
    expect(leaf(r, "src/x.test.ts", "group", "later")?.own).toBe("skipped");
  });
});

describe("pytest", () => {
  const verbose = `============================= test session starts ==============================
platform darwin -- Python 3.12.1, pytest-8.3.2
collected 4 items

tests/test_math.py::test_add PASSED                                      [ 25%]
tests/test_math.py::test_sub FAILED                                      [ 50%]
tests/test_math.py::TestDiv::test_zero[1] SKIPPED (no zero)              [ 75%]
tests/test_math.py::TestDiv::test_ok PASSED                              [100%]

=================================== FAILURES ===================================
___________________________________ test_sub ___________________________________

    def test_sub():
>       assert 1 - 1 == 1
E       assert 0 == 1

tests/test_math.py:7: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_sub - assert 0 == 1
=============== 1 failed, 2 passed, 1 skipped in 0.12s ===============
`;

  it("parses verbose node ids into a tree", () => {
    const r = results(pytestParser(), verbose);
    expect(leaf(r, "tests/test_math.py", "test_add")?.own).toBe("passed");
    expect(leaf(r, "tests/test_math.py", "TestDiv", "test_zero[1]")?.own).toBe("skipped");
    expect(leaf(r, "tests/test_math.py", "TestDiv", "test_ok")?.own).toBe("passed");
    expect(nodeStatus(r.get("tests/test_math.py")!)).toBe("failed");
  });

  it("attaches failure sections and locations", () => {
    const r = results(pytestParser(), verbose);
    const failed = leaf(r, "tests/test_math.py", "test_sub")!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toEqual({ path: "tests/test_math.py", line: 7, resolve: "path" });
    expect(failed.output.some((l) => l.includes("assert 0 == 1"))).toBe(true);
  });

  it("reads the final summary", () => {
    const r = results(pytestParser(), verbose);
    expect(r.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, durationMs: 120 });
  });

  it("resolves non-verbose failures from the short summary", () => {
    const plain = `tests/test_math.py .F.                                                   [100%]

=================================== FAILURES ===================================
_______________________________ TestDiv.test_ok ________________________________

tests/test_math.py:21: ZeroDivisionError
=========================== short test summary info ============================
FAILED tests/test_math.py::TestDiv::test_ok - ZeroDivisionError
========================= 1 failed, 2 passed in 0.05s =========================
`;
    const r = results(pytestParser(), plain);
    const failed = leaf(r, "tests/test_math.py", "TestDiv", "test_ok")!;
    expect(failed.own).toBe("failed");
    expect(failed.location?.line).toBe(21);
    expect(r.roots.map((n) => n.name)).toEqual(["tests/test_math.py"]);
    expect(r.counts()).toMatchObject({ passed: 2, failed: 1 });
  });
});

describe("go test", () => {
  const fixture = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
    math_test.go:12: expected 0, got 1
--- FAIL: TestSub (0.01s)
=== RUN   TestTable
=== RUN   TestTable/zero
=== RUN   TestTable/one
--- PASS: TestTable (0.00s)
    --- PASS: TestTable/zero (0.00s)
    --- SKIP: TestTable/one (0.00s)
FAIL
FAIL	example.com/calc	0.004s
ok  	example.com/util	(cached)
?   	example.com/cmd	[no test files]
`;

  it("groups tests and subtests under their package", () => {
    const r = results(goParser(), fixture);
    expect(r.roots.map((n) => n.name)).toEqual(["example.com/calc", "example.com/util"]);
    expect(leaf(r, "example.com/calc", "TestAdd")?.own).toBe("passed");
    expect(leaf(r, "example.com/calc", "TestSub")).toMatchObject({ own: "failed", durationMs: 10 });
    expect(leaf(r, "example.com/calc", "TestTable", "zero")?.own).toBe("passed");
    expect(leaf(r, "example.com/calc", "TestTable", "one")?.own).toBe("skipped");
    expect(r.get("example.com/util")?.own).toBe("passed");
  });

  it("captures the failure location", () => {
    const r = results(goParser(), fixture);
    expect(leaf(r, "example.com/calc", "TestSub")?.location).toEqual({
      path: "math_test.go",
      line: 12,
      resolve: "name",
    });
  });

  it("handles non-verbose output (failure lines after the result)", () => {
    const r = results(
      goParser(),
      `--- FAIL: TestSub (0.00s)\n    math_test.go:9: nope\nFAIL\nFAIL\texample.com/calc\t0.002s\n`,
    );
    expect(leaf(r, "example.com/calc", "TestSub")?.location?.line).toBe(9);
  });
});

describe("gradle / maven", () => {
  it("parses gradle test logging", () => {
    const r = results(
      jvmParser(),
      `> Task :test

OrderControllerTest > shouldListOrders() PASSED

OrderControllerTest > shouldCreateOrder() FAILED
    org.opentest4j.AssertionFailedError at OrderControllerTest.kt:22

OrderControllerTest > Paging > firstPage() SKIPPED

3 tests completed, 1 failed, 1 skipped
`,
    );
    expect(leaf(r, "OrderControllerTest", "shouldListOrders")?.own).toBe("passed");
    expect(leaf(r, "OrderControllerTest", "shouldCreateOrder")?.location).toEqual({
      path: "OrderControllerTest.kt",
      line: 22,
      resolve: "name",
    });
    expect(leaf(r, "OrderControllerTest", "Paging", "firstPage")?.own).toBe("skipped");
    expect(r.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
  });

  it("moves gradle's console results to the reported classes", () => {
    const r = results(
      jvmParser(),
      `OrderTest > creates order() FAILED
    org.opentest4j.AssertionFailedError at OrderTest.kt:22
`,
    );
    r.apply([
      { type: "result", path: ["com.acme.OrderTest", "lists"], status: "passed" },
      { type: "result", path: ["com.acme.OrderTest", "creates order"], status: "failed" },
      { type: "result", path: ["com.acme.UserTest", "loads"], status: "passed" },
      { type: "result", path: ["com.other.UserTest", "loads"], status: "passed" },
    ]);
    moveToReportedClasses(r, ["com.acme.OrderTest", "com.acme.UserTest", "com.other.UserTest"]);
    expect(r.roots.map((n) => n.name)).toEqual(["com.acme.OrderTest", "com.acme.UserTest", "com.other.UserTest"]);
    const failed = leaf(r, "com.acme.OrderTest", "creates order")!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toMatchObject({ path: "OrderTest.kt", line: 22 });
    expect(failed.output).not.toEqual([]);
    expect(r.counts()).toMatchObject({ passed: 3, failed: 1 });
    expect(r.get("OrderTest")).toBeUndefined();
  });

  it("reports each test from the gradle init script's service messages", () => {
    const parser = jvmParser();
    const r = results(
      parser,
      `> Task :test
##teamcity[testStarted name='addsZero()' className='demo.CalcTest']
##teamcity[testStdOut name='addsZero()' className='demo.CalcTest' out='adding zero|n']
##teamcity[testFinished name='addsZero()' className='demo.CalcTest' duration='11']
##teamcity[testStarted name='fails()' className='demo.CalcTest']
##teamcity[testFailed name='fails()' className='demo.CalcTest' message='boom' details='org.opentest4j.AssertionFailedError: boom|n\tat app//org.junit.jupiter.api.AssertEquals.failNotEqual(AssertEquals.java:197)|n\tat app//demo.CalcTest.fails(CalcTest.java:21)|n']
##teamcity[testFinished name='fails()' className='demo.CalcTest' duration='4']
CalcTest > fails() FAILED
    org.opentest4j.AssertionFailedError at CalcTest.java:21
##teamcity[testStarted name='add(int)|[1|]' className='demo.ParamTest']
##teamcity[testFailed name='add(int)|[1|]' className='demo.ParamTest' message='no' details='no']
##teamcity[testFinished name='add(int)|[1|]' className='demo.ParamTest' duration='1']
##teamcity[testStarted name='add(int)|[2|]' className='demo.ParamTest']
##teamcity[testFinished name='add(int)|[2|]' className='demo.ParamTest' duration='1']
##teamcity[testStarted name='later()' className='demo.ParamTest']
##teamcity[testIgnored name='later()' className='demo.ParamTest']
##teamcity[testFinished name='later()' className='demo.ParamTest' duration='0']
`,
    );
    // Named like the XML reports, and not repeated under Gradle's simple class name.
    expect(r.roots.map((n) => n.name)).toEqual(["demo.CalcTest", "demo.ParamTest"]);
    expect(leaf(r, "demo.CalcTest", "addsZero")).toMatchObject({
      own: "passed",
      durationMs: 11,
      output: ["adding zero"],
    });
    const failed = leaf(r, "demo.CalcTest", "fails")!;
    expect(failed.own).toBe("failed");
    expect(failed.output[0]).toBe("org.opentest4j.AssertionFailedError: boom");
    expect(failed.location).toMatchObject({ path: "demo/CalcTest.java", line: 21, className: "demo.CalcTest" });
    expect(leaf(r, "demo.ParamTest", "add")?.own).toBe("failed");
    expect(leaf(r, "demo.ParamTest", "later")?.own).toBe("skipped");
    expect(r.hasResult(["demo.CalcTest", "fails"])).toBe(true);
    expect(r.hasResult(["demo.CalcTest", "other"])).toBe(false);
  });

  it("shows a test as running from its start", () => {
    const r = new TestResults();
    r.apply(jvmParser().feed("##teamcity[testStarted name='slow()' className='demo.SlowTest']"));
    expect(leaf(r, "demo.SlowTest", "slow")?.own).toBe("running");
    expect(r.hasResult(["demo.SlowTest", "slow"])).toBe(false);
  });

  it("parses surefire reports", () => {
    const r = results(
      jvmParser(),
      `[INFO] Running com.acme.OrderTest
[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.05 s <<< FAILURE! -- in com.acme.OrderTest
[ERROR] com.acme.OrderTest.shouldTotal -- Time elapsed: 0.01 s <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <3> but was: <2>
	at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:151)
	at com.acme.OrderTest.shouldTotal(OrderTest.java:31)

[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s -- in com.acme.UserTest
[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0
`,
    );
    expect(nodeStatus(r.get("com.acme.OrderTest")!)).toBe("failed");
    // Resolved by the frame's class (package directory + file), not by a bare file name.
    expect(leaf(r, "com.acme.OrderTest", "shouldTotal")?.location).toEqual({
      path: "com/acme/OrderTest.java",
      line: 31,
      resolve: "name",
      className: "com.acme.OrderTest",
    });
    expect(r.get("com.acme.UserTest")?.own).toBe("passed");
    expect(r.summary).toMatchObject({ passed: 2, failed: 1 });
  });

  it("locates a TestNG failure in the test, past TestNG's own frames", () => {
    const r = results(
      jvmParser(),
      `[INFO] Running com.acme.PriceTest
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.2 s <<< FAILURE! -- in com.acme.PriceTest
[ERROR] com.acme.PriceTest.rounds -- Time elapsed: 0.01 s <<< FAILURE!
java.lang.AssertionError: expected [3] but found [2]
	at org.testng.Assert.fail(Assert.java:111)
	at org.testng.Assert.assertEquals(Assert.java:1080)
	at com.acme.PriceTest.rounds(PriceTest.java:12)
`,
    );
    expect(leaf(r, "com.acme.PriceTest", "rounds")?.location).toMatchObject({
      path: "com/acme/PriceTest.java",
      line: 12,
    });
  });
});

describe("parser selection", () => {
  const cfg = (kind: string, command: string, args: string[] = []) => ({ kind, command, args });
  it("maps config kinds and commands to frameworks", () => {
    expect(frameworkFor(cfg("cargo", "cargo", ["test"]))).toBe("cargo");
    expect(frameworkFor(cfg("npm", "pnpm", ["run", "test"]))).toBe("js");
    expect(frameworkFor(cfg("pytest", "uv", ["run", "pytest"]))).toBe("pytest");
    expect(frameworkFor(cfg("django-test", ".venv/bin/python", ["manage.py", "test"]))).toBe("unittest");
    expect(frameworkFor(cfg("shell", "python3 manage.py test polls"))).toBe("unittest");
    expect(frameworkFor(cfg("python", ".venv/bin/python", ["manage.py", "test"]))).toBe("unittest");
    expect(frameworkFor(cfg("python", ".venv/bin/python", ["-m", "pytest"]))).toBe("pytest");
    expect(frameworkFor(cfg("go", "go", ["test", "./..."]))).toBe("go");
    expect(frameworkFor(cfg("gradle", "./gradlew", ["test"]))).toBe("jvm");
    expect(frameworkFor(cfg("shell", "npx vitest run"))).toBe("js");
    expect(frameworkFor(cfg("make", "make", ["test"]))).toBe("auto");
  });

  it("the combined parser understands any supported format", () => {
    const r = results(
      createTestParser(cfg("make", "make", ["test"])),
      "test a ... ok\n--- PASS: TestB (0.00s)\nok  \tpkg\t0.1s\ntest_c (app.tests.CTests.test_c) ... ok\n" +
        "Finished (0.5s)\ncompile (gcc.exe)",
    );
    expect(leaf(r, "a")?.own).toBe("passed");
    expect(leaf(r, "app.tests", "CTests", "test_c")?.own).toBe("passed");
    // Lines of other tools that only look like a unittest header make no tests.
    expect(r.roots.map((n) => n.name)).not.toContain("0");
    expect(r.roots.map((n) => n.name)).not.toContain("gcc");
    expect(leaf(r, "pkg", "TestB")?.own).toBe("passed");
  });
});

describe("TestResults", () => {
  it("marks unfinished tests when the process ends", () => {
    const r = new TestResults();
    r.apply([{ type: "start", path: ["s", "a"] }]);
    expect(nodeStatus(r.get("s")!)).toBe("running");
    r.finish(1);
    expect(r.get("s\u0000a")?.own).toBe("skipped");
  });
});
