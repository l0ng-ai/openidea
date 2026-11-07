import { describe, expect, it } from "vitest";
import { GoTestOutput, goJsonEvent, goParser } from "./go";
import { TestResults } from "./results";
import { withTestReporting } from "./index";
import { findOutputLinks } from "../links";

const record = (Package: string, Action: string, Test?: string, rest = {}) =>
  JSON.stringify({ Package, Action, ...(Test ? { Test } : {}), ...rest });

describe("Go JSON tests", () => {
  it("streams interleaved packages and subtests with exact counts and locations", () => {
    const parser = goParser();
    const results = new TestResults();
    const lines = [
      record("one", "run", "TestPass"),
      record("two", "run", "TestFail"),
      record("one", "run", "TestPass/child"),
      record("one", "pass", "TestPass/child", { Elapsed: 0.002 }),
      record("two", "output", "TestFail", { Output: "    nested/main_test.go:12:7: fixture failure\n" }),
      record("two", "fail", "TestFail", { Elapsed: 0.01 }),
      record("two", "fail"),
      record("one", "pass", "TestPass"),
      record("one", "skip", "TestSkip"),
      record("one", "pass"),
    ];
    lines.forEach((line) => results.apply(parser.feed(line)));
    results.finish(1);
    expect(results.counts()).toMatchObject({ passed: 1, failed: 1, skipped: 1, running: 0, total: 3 });
    expect(results.roots.map((n) => n.name)).toEqual(["one", "two"]);
    expect(results.get("two\0TestFail")?.location).toEqual({
      path: "nested/main_test.go",
      line: 12,
      col: 7,
      resolve: "name",
    });
    expect(results.get("one\0TestPass\0child")?.durationMs).toBe(2);
    expect(parser.feed(record("two", "fail", "TestFail"))).toEqual([]);
  });

  it("reports compiler failures and packages without tests", () => {
    const parser = goParser();
    const results = new TestResults();
    results.apply(
      parser.feed(
        JSON.stringify({ ImportPath: "broken", Action: "build-output", Output: "./main.go:3:1: undefined: missing\n" }),
      ),
    );
    results.apply(parser.feed(JSON.stringify({ ImportPath: "broken", Action: "build-fail" })));
    results.apply(parser.feed(record("empty", "skip")));
    expect(results.counts()).toMatchObject({ failed: 1, skipped: 1 });
    expect(results.roots[0]?.output).toContain("./main.go:3:1: undefined: missing");
  });

  it("counts repeated test results once per start and preserves a failed attempt", () => {
    const parser = goParser();
    const results = new TestResults();
    const lines = [
      record("p", "run", "TestRepeated"),
      record("p", "fail", "TestRepeated"),
      record("p", "run", "TestRepeated"),
      record("p", "pass", "TestRepeated"),
      record("p", "pass", "TestRepeated"),
      record("p", "fail"),
    ];
    lines.forEach((line) => results.apply(parser.feed(line)));
    expect(results.counts()).toMatchObject({ passed: 1, failed: 1, running: 0, total: 2 });
    expect(results.get("p\0TestRepeated")?.own).toBe("failed");
  });

  it("completes benchmark measurements and explicit bench events in interleaved packages", () => {
    const parser = goParser();
    const results = new TestResults();
    const lines = [
      record("one", "run", "BenchmarkQuiet"),
      record("two", "run", "BenchmarkLogged"),
      record("one", "output", "BenchmarkQuiet", { Output: "BenchmarkQuiet-4  \t  1\t  214 ns/op\n" }),
      record("two", "output", "BenchmarkLogged", { Output: "    bench_test.go:4: logged\n" }),
      record("two", "bench", "BenchmarkLogged-4"),
      record("one", "output", undefined, { Output: "BenchmarkQuiet-8  \t  1\t  210 ns/op\n" }),
      record("one", "run", "BenchmarkFails"),
      record("one", "output", "BenchmarkFails", { Output: "BenchmarkFails-4  \t  1\t  220 ns/op\n" }),
      record("one", "fail", "BenchmarkFails-8"),
      record("one", "fail"),
      record("two", "pass"),
    ];
    lines.forEach((line) => results.apply(parser.feed(line)));
    expect(results.counts()).toMatchObject({ passed: 2, failed: 1, running: 0, total: 3 });
    expect(results.get("one\0BenchmarkQuiet")?.own).toBe("passed");
    expect(results.get("one\0BenchmarkFails")?.own).toBe("failed");
    expect(results.get("two\0BenchmarkLogged")?.own).toBe("passed");
  });

  it("maps benchmark measurements without a Test field to the actual nested benchmark name", () => {
    const parser = goParser();
    const results = new TestResults();
    const lines = [
      record("p", "run", "BenchmarkNested"),
      record("p", "run", "BenchmarkNested/deep-2"),
      record("p", "output", undefined, { Output: "BenchmarkNested/deep-2  \t  1\t  214 ns/op\n" }),
      record("p", "output", undefined, { Output: "BenchmarkNested/deep-2-4  \t  1\t  210 ns/op\n" }),
      record("p", "pass"),
    ];
    lines.forEach((line) => results.apply(parser.feed(line)));
    expect(results.counts()).toMatchObject({ passed: 1, failed: 0, running: 0, total: 1 });
    expect(results.get("p\0BenchmarkNested")?.children.map((node) => node.name)).toEqual(["deep-2"]);
    expect(results.get("p\0BenchmarkNested\0deep-2")?.own).toBe("passed");
  });

  it("ignores malformed metadata and negative durations without throwing", () => {
    for (const line of [
      "{",
      "null",
      "[]",
      '{"Action":"pass","Package":5}',
      '{"Action":"output","Package":"p","Output":{}}',
      '{"Action":"unknown","Package":"p"}',
    ]) {
      expect(goJsonEvent(line)).toBeNull();
      expect(goParser().feed(line)).toEqual([]);
    }
    expect(goParser().feed(record("p", "pass", "TestOne", { Elapsed: -1 }))[0]).toMatchObject({
      durationMs: undefined,
    });
  });

  it("decodes chunked and long JSON output into clickable console text", () => {
    const parser = goParser();
    const results = new TestResults();
    const output = new GoTestOutput((line) => results.apply(parser.feed(line)));
    const line = record("p", "output", "TestFail", {
      Output: "    main_test.go:6: failure " + "x".repeat(9000) + "\n",
    });
    expect(output.feed(line.slice(0, 22))).toBe("");
    const text = output.feed(line.slice(22) + "\n" + record("p", "fail", "TestFail"));
    expect(text).toContain("main_test.go:6: failure");
    expect(text).not.toContain('"Action"');
    expect(findOutputLinks(text.slice(0, 100)).some((link) => link.kind === "file")).toBe(true);
    expect(output.end()).toBe("");
    expect(results.counts().failed).toBe(1);
  });

  it("forces JSON before program arguments and keeps the binary arguments untouched", () => {
    const config = {
      kind: "go",
      command: "go",
      args: ["test", "-json=false", "-tags", "demo", ".", "-args", "-json=false"],
    };
    expect(withTestReporting(config).args).toEqual(["test", "-json", "-tags", "demo", ".", "-args", "-json=false"]);
  });
});
