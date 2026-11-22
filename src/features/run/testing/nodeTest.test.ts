import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { detectRunTargets, targetConfig } from "../targets";
import { createTestParser, frameworkFor, nodeOutput, parseAll, TestResults, withTestReporting } from "./index";
import { withNodeTestNamePattern } from "./nodeTest";
import { RecordsOutput } from "./records";
import { failedTestPaths, rerunFailedConfigs, testsConfigs } from "./rerun";

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: over.kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: "js-debug",
  ...over,
});

/** `npm run test` whose script is `node --test` (detection records the runner). */
const script = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"], testRunner: "node-test" });

// `node --test` (Node 22.23) with the IDE's reporter next to `spec`, as printed.
const OUTPUT = String.raw`hello from test
▶ cart
  ✔ adds items (0.4259ms)
@@openidea:test@@{"path":["test/cart.test.mjs","cart","adds items"],"status":"passed","ms":0.4259,"line":5,"col":3}
  ▶ totals
    ✔ sums (0.1656ms)
@@openidea:test@@{"path":["test/cart.test.mjs","cart","totals","sums"],"status":"passed","ms":0.1656,"line":7,"col":5}
  ✔ totals (0.6471ms)
@@openidea:test@@{"path":["test/cart.test.mjs","cart","totals"],"status":"passed","ms":0.6471,"line":6,"col":3}
  ✖ fails (0.5311ms)
@@openidea:test@@{"path":["test/cart.test.mjs","cart","fails"],"status":"failed","ms":0.5311,"line":9,"col":3,"error":"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at TestContext.<anonymous> (file:///work/shop/test/cart.test.mjs:9:30)"}
  ﹣ skipped one (0.057ms) # SKIP
@@openidea:test@@{"path":["test/cart.test.mjs","cart","skipped one"],"status":"skipped","ms":0.057,"line":10,"col":6}
✖ cart (2.3737ms)
@@openidea:test@@{"path":["test/cart.test.mjs","cart"],"status":"failed","ms":2.3737,"line":4,"col":1}
✔ top level (0.3078ms)
@@openidea:test@@{"path":["test/cart.test.mjs","top level"],"status":"passed","ms":0.3078,"line":14,"col":1}
✖ test/broken.test.mjs (52.1ms)
@@openidea:test@@{"path":["test/broken.test.mjs"],"status":"failed","ms":52.1,"error":"'test failed'"}
ℹ tests 6
ℹ pass 3
ℹ fail 2`;

function results(text: string) {
  const r = new TestResults();
  r.apply(parseAll(createTestParser(script), text));
  return r;
}

const key = (...path: string[]) => path.join("\u0000");

describe("node:test reporter records", () => {
  it("build the tree from file and describe chain, with durations and locations", () => {
    const r = results(OUTPUT);
    expect(r.roots.map((n) => n.name)).toEqual(["test/cart.test.mjs", "test/broken.test.mjs"]);
    expect(r.counts()).toMatchObject({ passed: 3, failed: 2, skipped: 1 });
    const sums = r.get(key("test/cart.test.mjs", "cart", "totals", "sums"))!;
    expect(sums.own).toBe("passed");
    expect(sums.durationMs).toBe(0.1656);
    expect(sums.location).toEqual({ path: "test/cart.test.mjs", line: 7, col: 5, resolve: "path" });
    expect(r.get(key("test/cart.test.mjs", "cart", "skipped one"))?.own).toBe("skipped");
  });

  it("keep a failure's error with the test, and a file that failed to load", () => {
    const r = results(OUTPUT);
    const fails = r.get(key("test/cart.test.mjs", "cart", "fails"))!;
    expect(nodeOutput(fails).join("\n")).toContain("1 !== 2");
    expect(r.get("test/broken.test.mjs")?.own).toBe("failed");
    expect(failedTestPaths(r)).toEqual([["test/cart.test.mjs", "cart", "fails"], ["test/broken.test.mjs"]]);
  });

  it("are hidden from the console", () => {
    const fed: string[] = [];
    const console = new RecordsOutput((line) => fed.push(line)).feed(OUTPUT + "\n");
    expect(console).not.toContain("@@openidea");
    expect(console).toContain("  ✔ adds items (0.4259ms)\n");
    expect(fed.filter((l) => l.startsWith("@@openidea"))).toHaveLength(8);
  });
});

describe("node:test configurations", () => {
  it("are recognised by the recorded runner or Node's own --test", () => {
    expect(frameworkFor(script)).toBe("node-test");
    expect(frameworkFor(cfg({ id: "n", kind: "node", command: "node", args: ["--test"] }))).toBe("node-test");
    const flags = ["--experimental-strip-types", "--test", "src/"];
    expect(frameworkFor(cfg({ id: "n", kind: "node", command: "/usr/bin/node", args: flags }))).toBe("node-test");
    expect(frameworkFor(cfg({ id: "n", kind: "node", command: "node", args: ["server.js", "--test"] }))).not.toBe(
      "node-test",
    );
  });

  it("report through the IDE's reporter next to spec, once, keeping the user's NODE_OPTIONS", () => {
    const launched = withTestReporting({ ...script, env: { NODE_OPTIONS: "--max-old-space-size=4096" } });
    const options = launched.env.NODE_OPTIONS!.split(" ");
    expect(options.slice(0, 3)).toEqual([
      "--max-old-space-size=4096",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
    ]);
    expect(options[3]).toMatch(/^--test-reporter=data:text\/javascript;base64,/);
    expect(options[4]).toBe("--test-reporter-destination=stdout");
    expect(withTestReporting(launched).env).toEqual(launched.env);
    const own = { ...script, env: { NODE_OPTIONS: "--test-reporter=dot" } };
    expect(withTestReporting(own).env).toEqual(own.env);
  });

  it("select tests by full name in NODE_OPTIONS, quoted for Node and replacing an earlier filter", () => {
    const env = withNodeTestNamePattern({ NODE_OPTIONS: '--a --test-name-pattern="^x y$" --b' }, '^say "hi" \\d$');
    expect(env.NODE_OPTIONS).toBe('--a --b --test-name-pattern="^say \\"hi\\" \\\\d$"');
  });

  it("rerun failed tests by file and name", async () => {
    const [rerun] = await rerunFailedConfigs(script, failedTestPaths(results(OUTPUT)));
    expect(rerun!.args).toEqual(["run", "test", "--", "test/cart.test.mjs", "test/broken.test.mjs"]);
    expect(rerun!.env.NODE_OPTIONS).toBe('--test-name-pattern="^(?:cart fails)$"');
    const direct = cfg({ id: "node", kind: "node", command: "node", args: ["--test"] });
    const [selected] = await testsConfigs(direct, [["test/a.test.mjs", "a.b", "c"]], "c");
    expect(selected!.args).toEqual(["--test", "test/a.test.mjs"]);
    expect(selected!.env.NODE_OPTIONS).toBe('--test-name-pattern="^(?:a\\\\.b c)$"');
  });

  it("run a gutter target by its file and full name", () => {
    const src = "import { describe, it } from 'node:test';\ndescribe('cart', () => {\n  it('adds', () => {});\n});";
    const [suite, test] = detectRunTargets(src, "test/cart.test.mjs");
    const one = targetConfig(test!, "test/cart.test.mjs", [script], src)!;
    expect(one.args).toEqual(["run", "test", "--", "test/cart.test.mjs"]);
    expect(one.env.NODE_OPTIONS).toBe('--test-name-pattern="^cart adds$"');
    expect(targetConfig(suite!, "test/cart.test.mjs", [script], src)!.env.NODE_OPTIONS).toBe(
      '--test-name-pattern="^cart"',
    );
  });
});
