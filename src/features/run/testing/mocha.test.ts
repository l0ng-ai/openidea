import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { detectRunTargets, targetConfig } from "../targets";
import { createTestParser, frameworkFor, nodeOutput, parseAll, TestResults, withTestReporting } from "./index";
import { failedTestPaths, rerunFailedConfigs } from "./rerun";

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

/** `npm run test` whose script is `mocha` (detection records the runner). */
const script = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"], testRunner: "mocha" });

// `mocha` (10.8, spec reporter) with the IDE's hook, as printed.
const OUTPUT = String.raw`

  pricing
    withTax
      ✔ adds the rate
@@openidea:test@@{"path":["test/pricing.spec.js","pricing","withTax","adds the rate"],"status":"passed","ms":0,"line":6,"col":5}
    1) intentionally fails (set OPENIDEA_FAIL=1)
@@openidea:test@@{"path":["test/pricing.spec.js","pricing","intentionally fails (set OPENIDEA_FAIL=1)"],"status":"failed","ms":1,"line":25,"col":3,"error":"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n11 !== 11.5\n\n    at Context.<anonymous> (file:///work/shop/test/pricing.spec.js:27:12)"}
    - later
@@openidea:test@@{"path":["test/pricing.spec.js","pricing","later"],"status":"skipped","line":29,"col":3}

  1 passing (3ms)
  1 pending
  1 failing
`;

function results(text: string) {
  const r = new TestResults();
  r.apply(parseAll(createTestParser(script), text));
  return r;
}

describe("Mocha runs", () => {
  it("are recognised by the recorded runner or the command line", () => {
    expect(frameworkFor(script)).toBe("mocha");
    expect(frameworkFor(cfg({ id: "x", kind: "node", command: "npx", args: ["mocha", "--recursive"] }))).toBe("mocha");
    expect(frameworkFor(cfg({ id: "x", kind: "shell", command: "./node_modules/.bin/_mocha", args: [] }))).toBe(
      "mocha",
    );
    expect(frameworkFor(cfg({ id: "x", kind: "node", command: "node", args: ["mocha.config.js"] }))).not.toBe("mocha");
  });

  it("load the IDE's hook through NODE_OPTIONS, once", () => {
    const launched = withTestReporting({ ...script, env: { NODE_OPTIONS: "--enable-source-maps" } });
    const [own, hook] = launched.env.NODE_OPTIONS!.split(" ");
    expect(own).toBe("--enable-source-maps");
    expect(hook).toMatch(/^--import=data:text\/javascript;base64,/);
    expect(withTestReporting(launched).env).toEqual(launched.env);
    expect(launched.args).toEqual(script.args);
  });

  it("build the tree from the hook's records, with declaration lines and failures", () => {
    const r = results(OUTPUT);
    expect(r.counts()).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    const adds = r.get(["test/pricing.spec.js", "pricing", "withTax", "adds the rate"].join("\u0000"))!;
    expect(adds.location).toEqual({ path: "test/pricing.spec.js", line: 6, col: 5, resolve: "path" });
    expect(nodeOutput(r.firstFailure()!).join("\n")).toContain("11 !== 11.5");
  });

  it("rerun failed tests by file and full title with --grep", async () => {
    const [rerun] = await rerunFailedConfigs(
      { ...script, args: ["run", "test", "--", "--grep", "old"] },
      failedTestPaths(results(OUTPUT)),
    );
    expect(rerun!.args).toEqual([
      "run",
      "test",
      "--",
      "test/pricing.spec.js",
      "--grep",
      "^(?:pricing intentionally fails \\(set OPENIDEA_FAIL=1\\))$",
    ]);
  });
});

describe("Mocha gutter targets", () => {
  const src = [
    "describe('pricing', function () {", // 0
    "  specify('adds tax', function () {});", // 1
    "  context('bulk', function () {", // 2
    "    it('discounts', function () {});", // 3
    "  });",
    "});",
  ].join("\n");

  it("are found in test/ whatever the file's name, `specify` included", () => {
    expect(detectRunTargets(src, "test/pricing.js").map((t) => [t.line, t.kind, t.path.join("/")])).toEqual([
      [0, "suite", "pricing"],
      [1, "test", "pricing/adds tax"],
      [2, "suite", "pricing/bulk"],
      [3, "test", "pricing/bulk/discounts"],
    ]);
    expect(detectRunTargets(src, "lib/pricing.js")).toEqual([]);
  });

  it("run by file and full title", () => {
    const targets = detectRunTargets(src, "test/pricing.js");
    expect(targetConfig(targets[3]!, "test/pricing.js", [script], src)?.args).toEqual([
      "run",
      "test",
      "--",
      "test/pricing.js",
      "--grep",
      "^pricing bulk discounts$",
    ]);
  });
});
