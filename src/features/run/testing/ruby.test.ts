import { describe, expect, it } from "vitest";
import { parseAll, withTestReporting, frameworkFor } from "./index";
import { TestResults, nodeStatus } from "./results";
import { RubyTestOutput, rubyParser } from "./ruby";

// Captured from `ruby -Ilib test/mixed_test.rb -v --seed 1` (Minitest 6.0.6).
const MINITEST = `Run options: -v --seed 1

# Running:

MixedTest#test_pass = 0.00 s = .
MixedTest#test_fail = 0.00 s = F
MixedTest#test_skip = 0.00 s = S
MixedTest#test_error = 0.00 s = E
MixedTest#test_prints = hello from test
0.00 s = .
Spec style#test_0001_works = 0.00 s = .
Outer::InnerTest#test_nested = 0.00 s = .

Finished in 0.000893s, 7838.7459 runs/s, 5599.1042 assertions/s.

  1) Failure:
MixedTest#test_fail [test/mixed_test.rb:5]:
Expected: 4
  Actual: 3

  2) Skipped:
MixedTest#test_skip [test/mixed_test.rb:7]:
later

  3) Error:
MixedTest#test_error:
RuntimeError: boom
    test/mixed_test.rb:6:in 'MixedTest#test_error'

7 runs, 5 assertions, 1 failures, 1 errors, 1 skips`;

describe("Minitest parser", () => {
  const events = parseAll(rubyParser(), MINITEST);
  const results = new TestResults();
  results.apply(events);

  it("reports every test under its class, with its status", () => {
    const status = (cls: string, name: string) => nodeStatus(results.get([cls, name].join("\u0000"))!);
    expect(results.roots.map((r) => r.name).sort()).toEqual(["MixedTest", "Outer::InnerTest", "Spec style"]);
    expect(status("MixedTest", "test_pass")).toBe("passed");
    expect(status("MixedTest", "test_fail")).toBe("failed");
    expect(status("MixedTest", "test_error")).toBe("failed");
    expect(status("MixedTest", "test_skip")).toBe("skipped");
    expect(status("MixedTest", "test_prints")).toBe("passed");
    expect(status("Spec style", "test_0001_works")).toBe("passed");
    expect(status("Outer::InnerTest", "test_nested")).toBe("passed");
  });

  it("keeps a test's own output with it, and the result printed after it", () => {
    expect(events).toContainEqual({ type: "output", path: ["MixedTest", "test_prints"], line: "hello from test" });
    expect(events.filter((e) => e.type === "result" && e.path[1] === "test_prints")).toHaveLength(1);
  });

  it("attaches the failure text and locates it", () => {
    const out = events
      .filter((e) => e.type === "output" && e.path[1] === "test_fail")
      .map((e) => (e as { line: string }).line);
    expect(out).toEqual(expect.arrayContaining(["Expected: 4", "  Actual: 3"]));
    expect(events).toContainEqual({
      type: "location",
      path: ["MixedTest", "test_fail"],
      location: { path: "test/mixed_test.rb", line: 5, resolve: "path" },
    });
    // An error has no location in its header: the first frame gives it.
    expect(events).toContainEqual({
      type: "location",
      path: ["MixedTest", "test_error"],
      location: { path: "test/mixed_test.rb", line: 6, resolve: "path" },
    });
  });

  it("locates every test by class and name, once, for jumping to its source", () => {
    const located = events.filter((e) => e.type === "location" && e.location.resolve === "rubyTest");
    expect(located).toHaveLength(7);
    expect(located).toContainEqual({
      type: "location",
      path: ["MixedTest", "test_pass"],
      location: { path: "test_pass", className: "MixedTest", resolve: "rubyTest" },
    });
    // The first location wins in the tree: passing tests have no other.
    expect(results.get(["MixedTest", "test_pass"].join("\u0000"))!.location?.resolve).toBe("rubyTest");
  });

  it("summarises the run", () => {
    expect(events.at(-1)).toEqual({ type: "summary", passed: 4, failed: 2, skipped: 1, durationMs: 0.893 });
  });
});

describe("Ruby test reporting", () => {
  const cfg = (kind: string, command: string, args: string[]) => ({ kind, command, args });

  it("asks Minitest for one line per test", () => {
    expect(withTestReporting(cfg("ruby", "ruby", ["-Ilib", "test/a_test.rb"])).args).toEqual([
      "-Ilib",
      "test/a_test.rb",
      "-v",
    ]);
    expect(withTestReporting(cfg("rake", "bundle", ["exec", "rake", "test"])).args).toEqual([
      "exec",
      "rake",
      "test",
      "TESTOPTS=-v",
    ]);
    expect(withTestReporting(cfg("ruby", "ruby", ["a_test.rb", "-v"])).args).toEqual(["a_test.rb", "-v"]);
    expect(withTestReporting(cfg("rake", "rake", ["test", "TESTOPTS=--seed 1"])).args).toEqual([
      "test",
      "TESTOPTS=--seed 1 -v",
    ]);
    expect(withTestReporting(cfg("rake", "rake", ["test", "TESTOPTS=--name=Foo#test_a"])).args).toEqual([
      "test",
      "TESTOPTS=--name=Foo#test_a -v",
    ]);
    // RSpec has no parser yet: untouched.
    expect(withTestReporting(cfg("rspec", "rspec", ["spec"])).args).toEqual(["spec"]);
  });

  it("is the framework of Ruby configurations", () => {
    expect(frameworkFor(cfg("ruby", "ruby", []))).toBe("ruby");
    expect(frameworkFor(cfg("rake", "bundle", ["exec", "rake", "test"]))).toBe("ruby");
  });
});

// Captured from a run with the IDE's reporter (Minitest 6.0.6): records end with their own newline, so the
// progress dots stay on one line once they are taken out.
const M = "@@OPENIDEA@@";
const F = "/p/test/mixed_test.rb";
const REPORTER_STREAM = [
  "# Running:",
  "",
  `${M}{"t":"start","c":"MixedTest","n":"test_pass","f":"${F}","l":4}`,
  `.${M}{"t":"result","c":"MixedTest","n":"test_pass","s":"passed","d":0.000063,"f":"${F}","l":4,"m":""}`,
  `${M}{"t":"start","c":"MixedTest","n":"test_fail","f":"${F}","l":5}`,
  `F${M}{"t":"result","c":"MixedTest","n":"test_fail","s":"failed","d":0.000054,"f":"${F}","l":5,"m":"Expected: 4\\n  Actual: 3"}`,
  `${M}{"t":"start","c":"MixedTest","n":"test_prints","f":"${F}","l":8}`,
  "hello from test",
  `.${M}{"t":"result","c":"MixedTest","n":"test_prints","s":"passed","d":0.000007,"f":"${F}","l":8,"m":""}`,
  `${M}{"t":"start","c":"MixedTest","n":"test_skip","f":"${F}","l":7}`,
  `S${M}{"t":"result","c":"MixedTest","n":"test_skip","s":"skipped","d":0.000006,"f":"${F}","l":7,"m":"later"}`,
  "",
  `${M}{"t":"summary","runs":4,"failures":1,"errors":0,"skips":1,"d":0.0011}`,
  "Finished in 0.001124s",
  "",
].join("\n");

describe("the IDE's Minitest reporter", () => {
  const collect = (chunks: string[]) => {
    const lines: string[] = [];
    const out = new RubyTestOutput((line) => lines.push(line));
    const text = chunks.map((c) => out.feed(c)).join("") + out.end();
    return { text, records: lines.filter((l) => l.includes(M)), lines };
  };

  it("takes the records out of the console, exactly as Minitest prints them without it", () => {
    const { text, records } = collect([REPORTER_STREAM]);
    expect(text).toBe("# Running:\n\n.Fhello from test\n.S\nFinished in 0.001124s\n");
    expect(records).toHaveLength(9);
    expect(records.every((r) => r.includes(M))).toBe(true);
  });

  it("is the same however the output is cut into chunks", () => {
    const whole = collect([REPORTER_STREAM]);
    const chars = collect(REPORTER_STREAM.split(""));
    const odd = collect(REPORTER_STREAM.match(/[\s\S]{1,7}/g)!);
    expect(chars).toEqual(whole);
    expect(odd).toEqual(whole);
  });

  it("drops a record cut off by the end of the process, not the text before it", () => {
    expect(collect([`abc${M}{"t":"sta`]).text).toBe("abc");
    expect(collect(["no marker @@OPEN"]).text).toBe("no marker @@OPEN\n");
  });

  describe("results", () => {
    const parser = rubyParser();
    const results = new TestResults();
    for (const l of collect([REPORTER_STREAM]).lines) results.apply(parser.feed(l));
    // The console's own text arrives too: the same results, printed.
    for (const l of ["MixedTest#test_pass = 0.00 s = .", "1 runs, 1 assertions, 0 failures, 0 errors, 0 skips"])
      results.apply(parser.feed(l));
    const node = (name: string) => results.get(["MixedTest", name].join("\u0000"))!;

    it("builds the tree with statuses, times and failure text", () => {
      expect(nodeStatus(node("test_pass"))).toBe("passed");
      expect(nodeStatus(node("test_fail"))).toBe("failed");
      expect(nodeStatus(node("test_skip"))).toBe("skipped");
      expect(node("test_fail").output).toEqual(["Expected: 4", "  Actual: 3"]);
      expect(node("test_pass").durationMs).toBeCloseTo(0.063, 3);
    });

    it("gives every test its real file and line, passed or not", () => {
      for (const [name, line] of [
        ["test_pass", 4],
        ["test_fail", 5],
        ["test_prints", 8],
        ["test_skip", 7],
      ] as const)
        expect(node(name).location).toEqual({ path: F, line, resolve: "path" });
    });

    it("summarises from the reporter, and ignores the repeated text", () => {
      expect(results.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
      expect(results.get("MixedTest")!.children).toHaveLength(4);
    });
  });

  it("a real location replaces the place to search for", () => {
    const results = new TestResults();
    results.apply(parseAll(rubyParser(), "MixedTest#test_pass = 0.00 s = ."));
    const id = ["MixedTest", "test_pass"].join("\u0000");
    expect(results.get(id)!.location?.resolve).toBe("rubyTest");
    results.apply([
      { type: "location", path: ["MixedTest", "test_pass"], location: { path: F, line: 4, resolve: "path" } },
    ]);
    expect(results.get(id)!.location).toEqual({ path: F, line: 4, resolve: "path" });
  });
});
