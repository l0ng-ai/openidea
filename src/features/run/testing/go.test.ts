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
