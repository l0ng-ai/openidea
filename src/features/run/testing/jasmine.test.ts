import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { detectRunTargets, specsInSpecDirectory, targetConfig } from "../targets";
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

/** `npm run test` whose script is `jasmine` (detection records the runner). */
const script = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"], testRunner: "jasmine" });

// `jasmine` (5.13, default reporter) with the IDE's hook, as printed (`fixtures/jasmine-app`, OPENIDEA_FAIL=1).
const OUTPUT = String.raw`Started
.@@openidea:test@@{"path":["spec/cartSpec.js","cart","total","is zero for an empty cart"],"status":"passed","ms":1,"line":5,"col":5}
F@@openidea:test@@{"path":["spec/cartSpec.js","cart","intentionally fails (set OPENIDEA_FAIL=1)"],"status":"failed","ms":1,"line":24,"col":3,"error":"Expected 6 to be 7.\n    at <Jasmine>\n    at UserContext.<anonymous> (file:///work/shop/spec/cartSpec.js:26:48)\n    at <Jasmine>"}
*@@openidea:test@@{"path":["spec/cartSpec.js","cart","later"],"status":"skipped","ms":0,"line":29,"col":3}


Failures:
1) cart intentionally fails (set OPENIDEA_FAIL=1)
  Message:
    Expected 6 to be 7.

3 specs, 1 failure, 1 pending spec
Finished in 0.006 seconds
`;

function results(text: string) {
  const r = new TestResults();
  r.apply(parseAll(createTestParser(script), text));
  return r;
}

describe("Jasmine runs", () => {
  it("are recognised by the recorded runner or the command line", () => {
    expect(frameworkFor(script)).toBe("jasmine");
    expect(frameworkFor(cfg({ id: "x", kind: "node", command: "npx", args: ["jasmine", "spec/cartSpec.js"] }))).toBe(
      "jasmine",
    );
    expect(
      frameworkFor(cfg({ id: "x", kind: "node", command: "node", args: ["node_modules/jasmine/bin/jasmine.js"] })),
    ).toBe("jasmine");
    expect(frameworkFor(cfg({ id: "x", kind: "node", command: "npx", args: ["jasmine-browser-runner"] }))).not.toBe(
      "jasmine",
    );
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
    const zero = r.get(["spec/cartSpec.js", "cart", "total", "is zero for an empty cart"].join("\u0000"))!;
    expect(zero.location).toEqual({ path: "spec/cartSpec.js", line: 5, col: 5, resolve: "path" });
    expect(nodeOutput(r.firstFailure()!).join("\n")).toContain("Expected 6 to be 7.");
  });

  it("rerun failed specs by file and full name with --filter=", async () => {
    const [rerun] = await rerunFailedConfigs(
      { ...script, args: ["run", "test", "--", "--filter=old"] },
      failedTestPaths(results(OUTPUT)),
    );
    expect(rerun!.args).toEqual([
      "run",
      "test",
      "--",
      "spec/cartSpec.js",
      "--filter=^(?:cart intentionally fails \\(set OPENIDEA_FAIL=1\\))(?: |$)",
    ]);
  });

  it("rerun a suite whose afterAll failed by its specs", async () => {
    // The hook's record for an `afterAll` failure, after the suite's specs passed.
    const afterAll = String.raw`@@openidea:test@@{"path":["spec/cartSpec.js","cart","total","sums"],"status":"passed","ms":0,"line":3,"col":5}
@@openidea:test@@{"path":["spec/cartSpec.js","cart"],"status":"failed","ms":1,"error":"Error: afterAll broke"}`;
    const paths = failedTestPaths(results(afterAll));
    expect(paths).toEqual([["spec/cartSpec.js", "cart"]]);
    const [rerun] = await rerunFailedConfigs(script, paths);
    const filter = new RegExp(rerun!.args.at(-1)!.slice("--filter=".length));
    expect(filter.test("cart total sums")).toBe(true);
    expect(filter.test("cartography maps")).toBe(false);
  });
});

describe("Jasmine gutter targets", () => {
  const src = [
    "describe('cart', () => {", // 0
    "  fit('adds', () => {});", // 1
    "  xdescribe('later', () => {", // 2
    "    xit('removes', () => {});", // 3
    "  });",
    "  fdescribe('total', () => {", // 5
    "    it('sums', () => {});", // 6
    "  });",
    "});",
  ].join("\n");

  it("are found in spec/ whatever the file's name in Jasmine projects, focused and excluded ones included", () => {
    expect(specsInSpecDirectory([script])).toBe(true);
    expect(
      detectRunTargets(src, "spec/cartSpec.js", false, false, true).map((t) => [t.line, t.kind, t.path.join("/")]),
    ).toEqual([
      [0, "suite", "cart"],
      [1, "test", "cart/adds"],
      [2, "suite", "cart/later"],
      [3, "test", "cart/later/removes"],
      [5, "suite", "cart/total"],
      [6, "test", "cart/total/sums"],
    ]);
    expect(detectRunTargets(src, "lib/cartSpec.js", false, false, true)).toEqual([]);
  });

  it("are not looked for in spec/ of a Jest or Vitest project", () => {
    const vitest = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"] });
    expect(specsInSpecDirectory([vitest])).toBe(false);
    expect(detectRunTargets(src, "spec/cartSpec.js")).toEqual([]);
  });

  it("run by file and full name", () => {
    const targets = detectRunTargets(src, "spec/cartSpec.js", false, false, true);
    expect(targetConfig(targets[5]!, "spec/cartSpec.js", [script], src)?.args).toEqual([
      "run",
      "test",
      "--",
      "spec/cartSpec.js",
      "--filter=^cart total sums$",
    ]);
  });
});
