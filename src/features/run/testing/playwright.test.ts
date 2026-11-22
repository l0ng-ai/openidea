import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { testBasesFor } from "../context";
import { detectRunTargets, targetConfig } from "../targets";
import { createTestParser, frameworkFor, nodeOutput, parseAll, TestResults, withTestReporting } from "./index";
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

/** `npm run e2e` whose script is `playwright test` (detection records the runner). */
const script = cfg({ id: "npm:e2e", kind: "npm", command: "npm", args: ["run", "e2e"], testRunner: "playwright" });
/** The configuration detected for a `playwright.config.ts` no script runs. */
const npx = cfg({ id: "playwright", kind: "node", command: "npx", args: ["playwright", "test"] });

function results(text: string, config: RunConfig = script) {
  const r = new TestResults();
  r.apply(parseAll(createTestParser(config), text));
  return r;
}

const key = (...path: string[]) => path.join("\u0000");

// `npx playwright test --reporter=list` in a Windows console (no UTF-8 marks), as printed.
const WINDOWS = `
Running 5 tests using 1 worker

  ok 1 tests\\cart.spec.ts:4:3 › cart › adds items (2ms)
  ok 2 tests\\cart.spec.ts:8:5 › cart › totals › sums (0ms)
  x  3 tests\\cart.spec.ts:12:3 › cart › fails (1ms)
  -  4 tests\\cart.spec.ts:15:8 › cart › skipped one
hello from test
  ok 5 tests\\cart.spec.ts:18:1 › top level (0ms)


  1) tests\\cart.spec.ts:12:3 › cart › fails ───────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 1

      11 |   });
      12 |   test("fails", () => {
    > 13 |     expect(1).toBe(2);
         |               ^
      14 |   });
        at C:\\work\\shop\\tests\\cart.spec.ts:13:15

  1 failed
    tests\\cart.spec.ts:12:3 › cart › fails ───────────────────────────────────────
  1 skipped
  3 passed (563ms)
`;

// macOS / Linux, with projects and a retried test.
const PROJECTS = `
Running 4 tests using 2 workers

  ✓  1 [chromium] › e2e/home.spec.ts:3:5 › home › has title (1.2s)
  ✘  2 [firefox] › e2e/home.spec.ts:3:5 › home › has title (5.0s)
  ✓  3 [firefox] › e2e/home.spec.ts:3:5 › home › has title (retry #1) (980ms)
  ✘  4 [chromium] › e2e/home.spec.ts:9:5 › home › links @smoke (1.0m)

  1) [chromium] › e2e/home.spec.ts:9:5 › home › links @smoke ──────────────────────

    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()

  1 failed
    [chromium] › e2e/home.spec.ts:9:5 › home › links @smoke ────────────────────────
  1 flaky
    [firefox] › e2e/home.spec.ts:3:5 › home › has title ────────────────────────────
  1 passed (1.1m)
`;

describe("Playwright list reporter", () => {
  it("builds the tree from file, describe chain and title, with durations and locations", () => {
    const r = results(WINDOWS);
    expect(r.counts()).toMatchObject({ passed: 3, failed: 1, skipped: 1 });
    expect(r.roots.map((n) => n.name)).toEqual(["tests/cart.spec.ts"]);
    const sums = r.get(key("tests/cart.spec.ts", "cart", "totals", "sums"))!;
    expect(sums.own).toBe("passed");
    expect(sums.durationMs).toBe(0);
    expect(sums.location).toEqual({ path: "tests/cart.spec.ts", line: 8, col: 5, resolve: "path" });
    expect(r.get(key("tests/cart.spec.ts", "cart", "skipped one"))?.own).toBe("skipped");
    expect(r.get(key("tests/cart.spec.ts", "top level"))?.own).toBe("passed");
    expect(r.summary).toMatchObject({ passed: 3, failed: 1, skipped: 1, durationMs: 563 });
  });

  it("keeps a failure's details, up to the summary", () => {
    const r = results(WINDOWS);
    const failure = r.firstFailure()!;
    expect(failure.path).toEqual(["tests/cart.spec.ts", "cart", "fails"]);
    expect(failure.location).toMatchObject({ path: "tests/cart.spec.ts", line: 12 });
    const output = nodeOutput(failure).join("\n");
    expect(output).toContain("Expected: 2");
    expect(output).toContain("at C:\\work\\shop\\tests\\cart.spec.ts:13:15");
    expect(output).not.toContain("1 skipped");
  });

  it("groups by project; a test that passed only on a retry (flaky) stays failed", () => {
    const r = results(PROJECTS);
    expect(r.get(key("e2e/home.spec.ts", "[chromium]", "home", "has title"))?.own).toBe("passed");
    const firefox = r.get(key("e2e/home.spec.ts", "[firefox]", "home", "has title"))!;
    expect(firefox.own).toBe("failed");
    expect(firefox.durationMs).toBe(980);
    const links = r.get(key("e2e/home.spec.ts", "[chromium]", "home", "links @smoke"))!;
    expect(links.own).toBe("failed");
    expect(links.durationMs).toBe(60_000);
    expect(nodeOutput(links).join("\n")).toContain("Timed out 5000ms");
    expect(r.counts()).toMatchObject({ passed: 1, failed: 2 });
  });
});

describe("Playwright configurations", () => {
  it("are recognised by the recorded runner or the command line", () => {
    expect(frameworkFor(script)).toBe("playwright");
    expect(frameworkFor(npx)).toBe("playwright");
    expect(frameworkFor({ kind: "shell", command: "pnpm exec playwright test --ui", args: [] })).toBe("playwright");
    expect(frameworkFor({ kind: "npm", command: "npm", args: ["run", "test"] })).toBe("js");
  });

  it("report through the list reporter unless the configuration chose one", () => {
    expect(withTestReporting(script).args).toEqual(["run", "e2e", "--", "--reporter=list"]);
    expect(withTestReporting(npx).args).toEqual(["playwright", "test", "--reporter=list"]);
    const chosen = { ...npx, args: ["playwright", "test", "--reporter=dot"] };
    expect(withTestReporting(chosen)).toBe(chosen);
  });

  it("rerun failed tests by file and title, per project", async () => {
    const one = await rerunFailedConfigs(script, failedTestPaths(results(WINDOWS)));
    expect(one.map((c) => c.args)).toEqual([
      ["run", "e2e", "--", "tests/cart.spec.ts", "--grep", "(?:^| )(?:cart fails)(?: @\\S+)*$"],
    ]);
    expect(new RegExp(one[0]!.args.at(-1)!).test(" cart.spec.ts cart fails @slow")).toBe(true);
    expect(new RegExp(one[0]!.args.at(-1)!).test(" cart.spec.ts cart fails later")).toBe(false);

    const paths = [
      ["e2e/a.spec.ts", "[chromium]", "a", "one"],
      ["e2e/b.spec.ts", "[firefox]", "b.c", "two"],
    ];
    const split = await testsConfigs({ ...npx, args: ["playwright", "test", "--project=webkit"] }, paths, "2 tests");
    expect(split.map((c) => [c.name, c.args])).toEqual([
      [
        "2 tests (chromium)",
        ["playwright", "test", "e2e/a.spec.ts", "--grep", "(?:^| )(?:a one)(?: @\\S+)*$", "--project", "chromium"],
      ],
      [
        "2 tests (firefox)",
        ["playwright", "test", "e2e/b.spec.ts", "--grep", "(?:^| )(?:b\\.c two)(?: @\\S+)*$", "--project", "firefox"],
      ],
    ]);
  });
});

describe("Playwright gutter targets", () => {
  const spec = [
    'import { test, expect } from "@playwright/test";', // 0
    "",
    "test.describe('cart', () => {", // 2
    "  test.describe.serial('totals', () => {", // 3
    "    test('sums', async ({ page }) => {});", // 4
    "    test.fixme('rounds', async () => {});", // 5
    "  });",
    "  test.fail('known bug', async () => {", // 7
    "    await test.step('opens', async () => {});",
    "  });",
    "});",
  ].join("\n");

  it("finds test.describe blocks and modified tests, not steps", () => {
    expect(detectRunTargets(spec, "e2e/cart.spec.ts").map((t) => [t.line, t.kind, t.path.join("/")])).toEqual([
      [2, "suite", "cart"],
      [3, "suite", "cart/totals"],
      [4, "test", "cart/totals/sums"],
      [5, "test", "cart/totals/rounds"],
      [7, "test", "cart/known bug"],
    ]);
  });

  it("run a test or describe block by its declaration line", () => {
    const [cart, , sums] = detectRunTargets(spec, "e2e/cart.spec.ts");
    expect(targetConfig(sums!, "e2e/cart.spec.ts", [script], spec)?.args).toEqual([
      "run",
      "e2e",
      "--",
      "e2e/cart.spec.ts:5",
    ]);
    const web = { ...npx, cwd: "web", module: "web" };
    expect(targetConfig(cart!, "web/e2e/cart.spec.ts", [web], spec)?.args).toEqual([
      "playwright",
      "test",
      "e2e/cart.spec.ts:3",
    ]);
  });

  it("take node test configurations as bases only when they run Playwright", () => {
    // Jest as imported from JetBrains (`npx jest`): not a base for gutter runs, as before.
    const jest = cfg({ id: "jest", kind: "node", command: "npx", args: ["jest"] });
    expect(testBasesFor("src/cart.test.ts", [jest], "test('adds', () => {});")).toEqual([]);
    expect(testBasesFor("e2e/cart.spec.ts", [jest, npx], spec).map((c) => c.id)).toEqual(["playwright"]);
  });
  it("send specs to Playwright and other tests to the project's other runner", () => {
    const vitest = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"] });
    const configs = [vitest, npx];
    expect(testBasesFor("e2e/cart.spec.ts", configs, spec).map((c) => c.id)).toEqual(["playwright"]);
    const unit = "import { test } from 'vitest';\ntest('adds', () => {});";
    expect(testBasesFor("src/cart.test.ts", configs, unit).map((c) => c.id)).toEqual(["npm:test"]);
    expect(testBasesFor("src/cart.test.ts", configs).map((c) => c.id)).toEqual(["npm:test", "playwright"]);
  });
});
