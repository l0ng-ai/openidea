import { describe, expect, it } from "vitest";
import { createTestParser, frameworkFor, withTestReporting } from "./index";
import { phpunitArgs, phpunitFilter, phpunitParser, withTeamcity } from "./phpunit";
import { TestResults } from "./results";
import type { TestEvent } from "./types";

const run = (lines: string[]): TestEvent[] => {
  const parser = phpunitParser();
  return lines.flatMap((l) => parser.feed(l));
};

const SUITE = "App\\Tests\\CalcTest";

describe("phpunitParser", () => {
  it("reports passed, failed and skipped tests with locations", () => {
    const events = run([
      "PHPUnit 11.0.0 by Sebastian Bergmann and contributors.",
      "##teamcity[testSuiteStarted name='Unit' locationHint='php_qn:///app/phpunit.xml::\\Unit' flowId='1']",
      `##teamcity[testSuiteStarted name='${SUITE}' locationHint='php_qn:///app/tests/CalcTest.php::\\${SUITE}' flowId='1']`,
      "##teamcity[testStarted name='testAdd' locationHint='php_qn:///app/tests/CalcTest.php::\\App\\Tests\\CalcTest::testAdd' flowId='1']",
      "##teamcity[testFinished name='testAdd' duration='3' flowId='1']",
      "##teamcity[testStarted name='testSub' locationHint='php_qn:///app/tests/CalcTest.php::\\App\\Tests\\CalcTest::testSub' flowId='1']",
      "##teamcity[testFailed name='testSub' message='Failed asserting that 1 matches expected 2.' details=' /app/vendor/phpunit/Assert.php:100|n /app/tests/CalcTest.php:21|n' flowId='1']",
      "##teamcity[testFinished name='testSub' duration='1' flowId='1']",
      "##teamcity[testStarted name='testSkip' flowId='1']",
      "##teamcity[testIgnored name='testSkip' message='not yet' flowId='1']",
      "##teamcity[testFinished name='testSkip' duration='0' flowId='1']",
      `##teamcity[testSuiteFinished name='${SUITE}' flowId='1']`,
      "##teamcity[testSuiteFinished name='Unit' flowId='1']",
    ]);
    const add = ["Unit", SUITE, "testAdd"];
    const sub = ["Unit", SUITE, "testSub"];
    expect(events).toContainEqual({ type: "result", path: add, status: "passed", durationMs: 3 });
    expect(events).toContainEqual({ type: "result", path: sub, status: "failed" });
    expect(events).toContainEqual({ type: "result", path: ["Unit", SUITE, "testSkip"], status: "skipped" });
    // A failure points at the first frame outside vendor/.
    expect(events).toContainEqual({
      type: "location",
      path: sub,
      location: { path: "/app/tests/CalcTest.php", line: 21, resolve: "path" },
    });
    expect(events).toContainEqual({ type: "output", path: sub, line: "Failed asserting that 1 matches expected 2." });
    // The finish of a failed test doesn't turn it into a pass.
    expect(events.filter((e) => e.type === "result" && e.path.join() === sub.join())).toHaveLength(1);
  });

  it("nests data sets under their method", () => {
    const events = run([
      `##teamcity[testSuiteStarted name='${SUITE}']`,
      `##teamcity[testSuiteStarted name='${SUITE}::testAdd']`,
      "##teamcity[testStarted name='testAdd with data set #0']",
      "##teamcity[testFinished name='testAdd with data set #0' duration='1']",
      `##teamcity[testSuiteFinished name='${SUITE}::testAdd']`,
    ]);
    expect(events[0]).toEqual({ type: "start", path: [SUITE, "testAdd", "testAdd with data set #0"] });
  });

  it("unescapes TeamCity values", () => {
    const events = run([
      "##teamcity[testSuiteStarted name='S']",
      "##teamcity[testStarted name='t']",
      "##teamcity[testFailed name='t' message='a |'quoted|' |[x|] b' details='']",
    ]);
    expect(events).toContainEqual({ type: "output", path: ["S", "t"], line: "a 'quoted' [x] b" });
  });

  it("ignores everything else", () => {
    expect(run(["Time: 00:00.012, Memory: 8.00 MB", "OK (1 test, 1 assertion)", ""])).toEqual([]);
  });

  it("builds a tree", () => {
    const results = new TestResults();
    const parser = phpunitParser();
    for (const l of [
      "##teamcity[testSuiteStarted name='S']",
      "##teamcity[testStarted name='a']",
      "##teamcity[testFinished name='a' duration='1']",
      "##teamcity[testStarted name='b']",
      "##teamcity[testFailed name='b' message='x' details='']",
      "##teamcity[testFinished name='b' duration='1']",
    ])
      results.apply(parser.feed(l));
    expect(results.counts()).toMatchObject({ passed: 1, failed: 1 });
  });
});

describe("command lines", () => {
  it("puts --teamcity before any path, after the runner", () => {
    expect(withTeamcity(["tests/FooTest.php"])).toEqual(["--teamcity", "tests/FooTest.php"]);
    expect(withTeamcity(["vendor/bin/phpunit", "--stop-on-failure", "tests"])).toEqual([
      "vendor/bin/phpunit",
      "--teamcity",
      "--stop-on-failure",
      "tests",
    ]);
    expect(withTeamcity(["--testdox"])).toEqual(["--testdox"]);
    expect(withTeamcity(["--teamcity"])).toEqual(["--teamcity"]);
  });

  it("detects PHPUnit configurations", () => {
    expect(frameworkFor({ kind: "phpunit", command: "vendor/bin/phpunit", args: [] })).toBe("phpunit");
    expect(frameworkFor({ kind: "composer", command: "composer", args: ["run-script", "test"] })).toBe("auto");
    expect(frameworkFor({ kind: "shell", command: "php", args: ["vendor/bin/phpunit"] })).toBe("phpunit");
    expect(createTestParser({ kind: "phpunit", command: "phpunit", args: [] })).toBeDefined();
    expect(withTestReporting({ kind: "phpunit", command: "phpunit", args: ["tests"] }).args).toEqual([
      "--teamcity",
      "tests",
    ]);
  });

  it("replaces the target and filter, keeping options", () => {
    expect(phpunitArgs(["-c", "ci.xml", "tests"], { target: "tests/FooTest.php" })).toEqual([
      "-c",
      "ci.xml",
      "tests/FooTest.php",
    ]);
    expect(phpunitArgs(["--filter", "old", "--colors=never", "tests"], { filter: "/x/" })).toEqual([
      "--colors=never",
      "--filter",
      "/x/",
      "tests",
    ]);
    expect(phpunitArgs(["vendor/bin/phpunit", "tests"], { target: "a.php", filter: "/x/" })).toEqual([
      "vendor/bin/phpunit",
      "--filter",
      "/x/",
      "a.php",
    ]);
  });

  it("filters by class and method", () => {
    expect(phpunitFilter([["Unit", SUITE, "testAdd"]])).toBe(
      "/(App\\\\Tests\\\\CalcTest::testAdd( with data set .*)?)$/",
    );
    expect(phpunitFilter([["Unit", SUITE, "testAdd", "testAdd with data set #0"]])).toBe(
      "/(App\\\\Tests\\\\CalcTest::testAdd( with data set .*)?)$/",
    );
    expect(phpunitFilter([[SUITE]])).toBe("/(App\\\\Tests\\\\CalcTest::.*)$/");
  });
});
