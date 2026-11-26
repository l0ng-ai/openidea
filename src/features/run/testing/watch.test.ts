import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { jsParser, parseAll, TestResults } from "./index";
import { watchLaunch } from "./watch";

const cfg = (over: Partial<RunConfig>): RunConfig =>
  ({
    id: "t",
    name: "t",
    kind: "npm",
    command: "npm",
    args: ["run", "test"],
    env: {},
    isTest: true,
    ...over,
  }) as RunConfig;

const JEST_CYCLES = `PASS src/sum.test.js
  sum
    ✓ adds (3 ms)
    ✓ zero (1 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        0.861 s
Ran all test suites.

FAIL src/sum.test.js
  sum
    ✕ adds (4 ms)
    ✓ zero (1 ms)

  ● sum › adds

    expect(received).toBe(expected)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total
Time:        0.5 s
Ran all test suites.`;

const VITEST_CYCLES = ` DEV  v2.1.9 /p

 ✓ tests/cart.test.ts (5 tests | 1 skipped) 96ms

 Test Files  1 passed (1)
      Tests  4 passed | 1 skipped (5)
   Duration  1.11s

 PASS  Waiting for file changes...
 RERUN  src/money.ts x2

 ✓ tests/cart.test.ts (5 tests | 1 skipped) 38ms

 Test Files  1 passed (1)
      Tests  4 passed | 1 skipped (5)
   Duration  133ms

 PASS  Waiting for file changes...`;

describe("watch mode cycles", () => {
  it("replaces the tree with each Jest cycle", () => {
    const tests = new TestResults();
    tests.apply(parseAll(jsParser(true), JEST_CYCLES));
    expect(tests.roots.map((r) => r.name)).toEqual(["src/sum.test.js"]);
    expect(tests.roots[0]!.children[0]!.children.map((c) => [c.name, c.own])).toEqual([
      ["adds", "failed"],
      ["zero", "passed"],
    ]);
    expect(tests.counts()).toMatchObject({ passed: 1, failed: 1, total: 2 });
    expect(tests.finished).toBe(true);
  });

  it("ends each cycle once and starts the next one unfinished", () => {
    const parser = jsParser(true);
    const tests = new TestResults();
    const lines = JEST_CYCLES.split("\n");
    const firstEnd = lines.findIndex((l) => l.startsWith("Tests:"));
    for (const l of lines.slice(0, firstEnd + 3)) tests.apply(parser.feed(l));
    expect(tests.finished).toBe(true);
    tests.apply(parser.feed("FAIL src/sum.test.js"));
    expect(tests.finished).toBe(false);
    expect(parseAll(jsParser(true), JEST_CYCLES).filter((e) => e.type === "end")).toHaveLength(2);
  });

  it("replaces the tree with each Vitest cycle", () => {
    const events = parseAll(jsParser(true), VITEST_CYCLES);
    expect(events.filter((e) => e.type === "reset")).toHaveLength(1);
    const tests = new TestResults();
    tests.apply(events);
    expect(tests.roots).toHaveLength(1);
    expect(tests.summary).toMatchObject({ passed: 4, skipped: 1, durationMs: 133 });
  });

  it("keeps a single run's results without watch", () => {
    expect(parseAll(jsParser(), JEST_CYCLES).some((e) => e.type === "reset")).toBe(false);
  });
});

const script = (text: string, pre = false) => ({ text, pre });

describe("watchLaunch", () => {
  it("appends the watch flag to a package.json script", () => {
    expect(watchLaunch(cfg({}), script("tsc && jest", true))?.args).toEqual(["run", "test", "--", "--watchAll"]);
    expect(watchLaunch(cfg({ command: "pnpm" }), script("vitest --config v.ts"))?.args).toEqual([
      "run",
      "test",
      "--watch",
    ]);
  });

  it("starts `vitest watch` through the package manager for a script running `vitest run`", () => {
    const watched = watchLaunch(
      cfg({ args: ["run", "test", "--", "tests/a.test.ts"] }),
      script("CI=1 vitest run --dir src"),
    );
    expect(watched).toMatchObject({
      command: "npm",
      args: ["exec", "--", "vitest", "watch", "--dir", "src", "tests/a.test.ts"],
      env: { CI: "1" },
    });
    expect(watchLaunch(cfg({ command: "yarn" }), script("vitest run"))?.args).toEqual(["vitest", "watch"]);
    expect(watchLaunch(cfg({ command: "pnpm" }), script("vitest run"))?.args).toEqual(["exec", "vitest", "watch"]);
  });

  it("runs once when the watch flag would reach another tool or steps would be skipped", () => {
    expect(watchLaunch(cfg({}), script("jest && eslint ."))).toBeNull();
    expect(watchLaunch(cfg({}), script("tsc && vitest run"))).toBeNull();
    expect(watchLaunch(cfg({}), script("vitest run", true))).toBeNull();
    expect(watchLaunch(cfg({}), script("cross-env CI=1 vitest run"))).toBeNull();
  });

  it("changes the runner's own command line", () => {
    expect(
      watchLaunch(cfg({ kind: "node", command: "npx", args: ["vitest", "run", "a.test.ts"] }), null)?.args,
    ).toEqual(["vitest", "watch", "a.test.ts"]);
    expect(watchLaunch(cfg({ kind: "node", command: "npx", args: ["jest", "-t", "^x$"] }), null)?.args).toEqual([
      "jest",
      "-t",
      "^x$",
      "--watchAll",
    ]);
  });

  it("is null without Jest or Vitest", () => {
    expect(watchLaunch(cfg({}), script("mocha"))).toBeNull();
    expect(watchLaunch(cfg({}), null)).toBeNull();
    // `bun test` is Bun's own runner, not the `test` script.
    expect(watchLaunch(cfg({ kind: "bun", command: "bun", args: ["test"] }), script("vitest"))).toBeNull();
  });
});
