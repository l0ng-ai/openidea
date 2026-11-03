import { describe, expect, it } from "vitest";
import { parseAll, withTestReporting, frameworkFor } from "./index";
import { TestResults, nodeStatus } from "./results";
import { rubyParser } from "./ruby";

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
      "TESTOPTS=--seed 1",
    ]);
    // RSpec has no parser yet: untouched.
    expect(withTestReporting(cfg("rspec", "rspec", ["spec"])).args).toEqual(["spec"]);
  });

  it("is the framework of Ruby configurations", () => {
    expect(frameworkFor(cfg("ruby", "ruby", []))).toBe("ruby");
    expect(frameworkFor(cfg("rake", "bundle", ["exec", "rake", "test"]))).toBe("ruby");
  });
});
