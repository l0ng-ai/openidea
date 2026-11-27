import { describe, expect, it } from "vitest";
import { createTestParser, frameworkFor, parseAll, withTestReporting } from "./index";
import { TestResults, type TestOutputParser } from "./index";
import { zigParser } from "./zig";

function results(parser: TestOutputParser, text: string) {
  const r = new TestResults();
  r.apply(parseAll(parser, text));
  return r;
}

function leaf(r: TestResults, ...path: string[]) {
  return r.get(path.join("\u0000"));
}

const FAILING_RUN = `1/3 calc.test.adds two numbers...OK
2/3 calc.test.fails on purpose...expected 7, found 5
FAIL (TestExpectedEqual)
/Users/me/.zvm/0.16.0/lib/std/testing.zig:118:17: 0x10262da43 in expectEqualInner__anon_36302 (test)
                return error.TestExpectedEqual;
                ^
/Users/me/.zvm/0.16.0/lib/std/testing.zig:83:5: 0x10262dae3 in expectEqual (test)
    return expectEqualInner(T, expected, actual);
    ^
/work/app/src/calc.zig:12:5: 0x10262db23 in test.fails on purpose (test)
    try std.testing.expectEqual(@as(u32, 7), add(2, 3));
    ^
3/3 calc.test.printing helper...boom
OK
2 passed; 0 skipped; 1 failed.
error: the following test command failed with exit code 1:
/Users/me/.cache/zig/o/91f9863b4e219205507fbe58005bc1c5/test --seed=0xebfccadb
`;

describe("zig test", () => {
  it("builds the module's tests with failure output and the error's location", () => {
    const r = results(zigParser(), FAILING_RUN);
    expect(r.roots.map((n) => n.name)).toEqual(["calc"]);
    expect(leaf(r, "calc", "adds two numbers")?.own).toBe("passed");
    expect(leaf(r, "calc", "printing helper")?.own).toBe("passed");
    expect(leaf(r, "calc", "printing helper")?.output).toEqual(["boom"]);

    const failed = leaf(r, "calc", "fails on purpose")!;
    expect(failed.own).toBe("failed");
    expect(failed.output[0]).toBe("expected 7, found 5");
    expect(failed.output).toContain("try std.testing.expectEqual(@as(u32, 7), add(2, 3));");
    expect(failed.location).toEqual({
      path: "/work/app/src/calc.zig",
      line: 12,
      col: 5,
      resolve: "path",
    });
    expect(r.summary).toEqual({ passed: 2, skipped: 0, failed: 1 });
    expect(r.counts()).toMatchObject({ passed: 2, failed: 1 });
  });

  it("parses a quiet passing run and a filtered single test", () => {
    const r = results(
      zigParser(),
      `1/3 tally.test.total adds the prices...OK
2/3 tally.test.total of nothing is zero...OK
3/3 tally.test.format pads the cents...OK
All 3 tests passed.
`,
    );
    expect(leaf(r, "tally", "total adds the prices")?.own).toBe("passed");
    expect(r.counts()).toMatchObject({ passed: 3, failed: 0 });

    const filtered = results(
      zigParser(),
      `1/1 calc.test.adds two numbers...OK
All 1 tests passed.
`,
    );
    expect(filtered.counts()).toMatchObject({ passed: 1 });
    // A filter matching nothing leaves no nodes but reports the counts.
    expect(results(zigParser(), "All 0 tests passed.\n").counts()).toMatchObject({ passed: 0 });
  });

  it("reports skips, and status printed after output without a newline", () => {
    const r = results(
      zigParser(),
      `1/2 calc.test.will skip...SKIP
2/2 calc.test.greets...helloOK
1 passed; 1 skipped; 0 failed.
`,
    );
    expect(leaf(r, "calc", "will skip")?.own).toBe("skipped");
    expect(leaf(r, "calc", "greets")?.own).toBe("passed");
    expect(leaf(r, "calc", "greets")?.output).toEqual(["hello"]);
    expect(r.summary).toEqual({ passed: 1, skipped: 1, failed: 0 });
  });

  it("parses zig build test failure blocks (the build runner's captured output)", () => {
    const r = results(
      zigParser(),
      `test
+- run test 2 pass, 1 fail (3 total)
error: 'tally.test.total of nothing is zero' failed:
       expected 1, found 0
       /Users/me/.zvm/0.16.0/lib/std/testing.zig:94:17: 0x102d48893 in expectEqualInner__func_1083 (test)
                       return error.TestExpectedEqual;
                       ^
       /Users/me/.zvm/0.16.0/lib/std/testing.zig:58:5: 0x102d48937 in expectEqual (test)
           return expectEqualInner(T, expected, actual);
           ^
       /work/app/src/tally.zig:22:5: 0x102d48977 in test.total of nothing is zero (test)
           try std.testing.expectEqual(@as(u32, 1), total(&.{}));
           ^
failed command: ./.zig-cache/o/b84ba4b8338e114a2e03f2758f6ca155/test --cache-dir=./.zig-cache --seed=0x7689fac0 --listen=-

Build Summary: 1/3 steps succeeded (1 failed); 2/3 tests passed (1 failed)
test transitive failure
+- run test 2 pass, 1 fail (3 total)
   +- compile test debug native success 790ms MaxRSS:249M
`,
    );
    // The build runner reports passing tests only as counts; failures get nodes.
    const failed = leaf(r, "tally", "total of nothing is zero")!;
    expect(failed.own).toBe("failed");
    expect(failed.output[0]).toBe("expected 1, found 0");
    expect(failed.output).toContain("try std.testing.expectEqual(@as(u32, 1), total(&.{}));");
    expect(failed.location).toEqual({ path: "/work/app/src/tally.zig", line: 22, col: 5, resolve: "path" });
    expect(r.counts()).toMatchObject({ passed: 2, failed: 1 });
  });

  it("parses a passing zig build test --summary all (counts only, no nodes)", () => {
    const r = results(
      zigParser(),
      `Build Summary: 3/3 steps succeeded; 3/3 tests passed
test success
+- run test 3 pass (3 total) 2ms MaxRSS:2M
   +- compile test Debug native cached 36ms MaxRSS:32M
`,
    );
    expect(r.roots).toEqual([]);
    expect(r.counts()).toMatchObject({ passed: 3, failed: 0 });
  });

  it("a failure block left open at the end of the output still gets its location", () => {
    const r = results(
      zigParser(),
      `error: 'calc.test.breaks' failed:
       /work/app/src/calc.zig:4:5: 0x102 in test.breaks (test)
`,
    );
    const failed = leaf(r, "calc", "breaks")!;
    expect(failed.own).toBe("failed");
    expect(failed.location).toEqual({ path: "/work/app/src/calc.zig", line: 4, col: 5, resolve: "path" });
  });
});

describe("zig framework selection", () => {
  const test = (args: string[]) => ({ kind: "zig", command: "zig", args }) as const;

  it("selects the zig parser for zig test configurations", () => {
    expect(frameworkFor(test(["build", "test"]))).toBe("zig");
    expect(frameworkFor(test(["test", "src/calc.zig", "--test-filter", "adds"]))).toBe("zig");
    const events = createTestParser(test(["test", "calc.zig"])).feed("1/1 calc.test.adds two numbers...OK");
    expect(events).toEqual([
      { type: "start", path: ["calc", "adds two numbers"] },
      { type: "result", path: ["calc", "adds two numbers"], status: "passed" },
    ]);
  });

  it("adds --summary all to zig build test runs so passing runs report counts", () => {
    expect(withTestReporting(test(["build", "test"]))).toMatchObject({ args: ["build", "test", "--summary", "all"] });
    expect(withTestReporting(test(["build", "test", "--summary", "none"]))).toMatchObject({
      args: ["build", "test", "--summary", "none"],
    });
    // A standalone `zig test` always prints per-test lines.
    expect(withTestReporting(test(["test", "calc.zig"]))).toMatchObject({ args: ["test", "calc.zig"] });
  });
});
