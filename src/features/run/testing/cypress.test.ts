import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo, RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { testBasesFor, testConfigFor } from "../context";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { cypressType, prepareCypressLaunch } from "../cypressType";
import { detectRunTargets, targetConfig } from "../targets";
import { formParams } from "../types";
import { cypressSpecs } from "./cypress";
import {
  createTestParser,
  frameworkFor,
  nodeOutput,
  parseAll,
  TestResults,
  withTestReporting,
  type TestNode,
} from "./index";
import { failedTestPaths, rerunFailedConfigs } from "./rerun";

const installed = vi.hoisted(() => ({ files: {} as Record<string, string> }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: async (v: unknown) => v,
  commands: {
    fsReadText: async (path: string) => {
      if (path in installed.files) return installed.files[path];
      throw new Error("not found");
    },
  },
}));

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: over.kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
  ...over,
});

/** The configuration detected for a package with Cypress that no script runs. */
const npx = cfg({ id: "cypress", kind: "cypress", command: "npx", args: ["cypress", "run"] });
/** `npm run cy:run` whose script is `cypress run` (detection records the runner). */
const script = cfg({ id: "npm:cy:run", kind: "npm", command: "npm", args: ["run", "cy:run"], testRunner: "cypress" });

function results(text: string, config: RunConfig = npx) {
  const r = new TestResults();
  r.apply(parseAll(createTestParser(config), text));
  return r;
}

const key = (...path: string[]) => path.join("\u0000");

// `npx cypress run --browser chrome --reporter teamcity` with Cypress 16.4, as printed (tables shortened).
const RUN = `
================================================================================

  (Run Starting)

  │ Specs:          2 found (cart.cy.ts, nested/login.cy.js)                                       │
  │ Searched:       cypress/e2e/**/*.cy.{js,jsx,ts,tsx}                                            │

────────────────────────────────────────────────────────────────────────────────────────────────────

  Running:  cart.cy.ts                                                                      (1 of 2)
##teamcity[testSuiteStarted name='cart' flowId='43775']
##teamcity[testStarted name='adds an item' captureStandardOutput='true' flowId='43775']
##teamcity[testFinished name='adds an item' duration='117' flowId='43775']
##teamcity[testIgnored name='is skipped' message='is skipped' flowId='43775']
##teamcity[testStarted name='is skipped' captureStandardOutput='true' flowId='43775']
##teamcity[testSuiteStarted name='totals, with tax' flowId='43775']
##teamcity[testStarted name='sums |'quoted|' prices' captureStandardOutput='true' flowId='43775']
##teamcity[testFinished name='sums |'quoted|' prices' duration='25' flowId='43775']
##teamcity[testStarted name='fails on purpose' captureStandardOutput='true' flowId='43775']
##teamcity[testFailed name='fails on purpose' message='Timed out retrying after 4000ms: expected 3 to equal 4' details='AssertionError: Timed out retrying after 4000ms: expected 3 to equal 4|n    at Context.eval (webpack://cy/./cypress/e2e/cart.cy.ts:10:17)' captureStandardOutput='true' flowId='43775']
##teamcity[testFinished name='fails on purpose' duration='4201' flowId='43775']
##teamcity[testSuiteFinished name='totals, with tax' duration='4237' flowId='43775']
##teamcity[testSuiteFinished name='cart' duration='4410' flowId='43775']

  (Results)

  │ Tests:        4                                                                                │

────────────────────────────────────────────────────────────────────────────────────────────────────

  Running:  nested/login.cy.js                                                              (2 of 2)
##teamcity[testStarted name='top-level test' captureStandardOutput='true' flowId='43775']
##teamcity[testFinished name='top-level test' duration='45' flowId='43775']

  (Results)
`;

describe("Cypress teamcity reporter", () => {
  it("builds the tree from the spec, suites and tests, with statuses, durations and failures", () => {
    const r = results(RUN);
    expect(r.roots.map((n) => n.name)).toEqual(["cart.cy.ts", "nested/login.cy.js"]);
    const node = (...path: string[]) => r.get(key(...path))!;
    expect(node("cart.cy.ts", "cart", "adds an item")).toMatchObject({ own: "passed", durationMs: 117 });
    expect(node("cart.cy.ts", "cart", "is skipped").own).toBe("skipped");
    expect(node("cart.cy.ts", "cart", "totals, with tax", "sums 'quoted' prices").own).toBe("passed");
    const failed = node("cart.cy.ts", "cart", "totals, with tax", "fails on purpose");
    expect(failed).toMatchObject({ own: "failed", durationMs: 4201 });
    expect(nodeOutput(failed)).toEqual([
      "AssertionError: Timed out retrying after 4000ms: expected 3 to equal 4",
      "    at Context.eval (webpack://cy/./cypress/e2e/cart.cy.ts:10:17)",
    ]);
    expect(node("nested/login.cy.js", "top-level test").own).toBe("passed");
    // Cypress prints no line: the test is found in its spec by its titles.
    expect(failed.location).toEqual({
      path: "cart.cy.ts",
      resolve: "path",
      test: ["cart", "totals, with tax", "fails on purpose"],
    });
  });

  it("names specs by the --spec paths they were run as, and joins wrapped names", () => {
    const run = cfg({ ...npx, args: ["cypress", "run", "--spec", "cypress/e2e/cart.cy.ts,**/nested/login.cy.js"] });
    expect(cypressSpecs(run.args)).toEqual(["cypress/e2e/cart.cy.ts", "**/nested/login.cy.js"]);
    expect(results(RUN, run).roots.map((n) => n.name)).toEqual(["cypress/e2e/cart.cy.ts", "nested/login.cy.js"]);
    const wrapped = results(
      [
        "  Running:  some/very/long/folder/structure/for/checking/wrapping/an-extremely-l            (2 of 2)",
        "            ong-spec-file-name-for-wrapping.cy.js                                                   ",
        "##teamcity[testStarted name='deep' captureStandardOutput='true' flowId='41517']",
        "##teamcity[testFinished name='deep' duration='24' flowId='41517']",
      ].join("\n"),
    );
    expect(wrapped.roots.map((n) => n.name)).toEqual([
      "some/very/long/folder/structure/for/checking/wrapping/an-extremely-long-spec-file-name-for-wrapping.cy.js",
    ]);
  });
});

// Failing hooks (\`beforeEach\`, \`before\`, \`afterEach\`, \`after\`) with Cypress 16.4, as printed.
const HOOKS = `
  Running:  hooks.cy.js                                                                     (1 of 1)
##teamcity[testSuiteStarted name='each' flowId='14448']
##teamcity[testStarted name='outside' captureStandardOutput='true' flowId='14448']
##teamcity[testFinished name='outside' duration='25' flowId='14448']
##teamcity[testSuiteStarted name='inner' flowId='14448']
##teamcity[testStarted name='first' captureStandardOutput='true' flowId='14448']
##teamcity[testFailed name='"before each" hook for "first"' message='expected 1 to equal 2|n|nBecause this error occurred during a \`before each\` hook we are skipping the remaining tests in the current suite: \`inner\`' details='AssertionError: expected 1 to equal 2|n|nBecause this error occurred during a \`before each\` hook we are skipping the remaining tests in the current suite: \`inner\`|n    at Context.eval (webpack://hk/./cypress/e2e/hooks.cy.js:3:36)' captureStandardOutput='true' flowId='14448']
##teamcity[testFinished name='first' duration='9' flowId='14448']
##teamcity[testSuiteFinished name='inner' duration='50' flowId='14448']
##teamcity[testSuiteFinished name='each' duration='79' flowId='14448']
##teamcity[testSuiteStarted name='all' flowId='14448']
##teamcity[testFailed name='"before all" hook for "one"' message='expected 1 to equal 3|n|nBecause this error occurred during a \`before all\` hook we are skipping the remaining tests in the current suite: \`all\`' details='AssertionError: expected 1 to equal 3|n|nBecause this error occurred during a \`before all\` hook we are skipping the remaining tests in the current suite: \`all\`|n    at Context.eval (webpack://hk/./cypress/e2e/hooks.cy.js:10:30)' captureStandardOutput='true' flowId='14448']
##teamcity[testFinished name='one' duration='7' flowId='14448']
##teamcity[testSuiteFinished name='all' duration='15' flowId='14448']
##teamcity[testSuiteStarted name='after' flowId='14448']
##teamcity[testStarted name='runs' captureStandardOutput='true' flowId='14448']
##teamcity[testFailed name='"after each" hook for "runs"' message='expected 1 to equal 4|n|nBecause this error occurred during a \`after each\` hook we are skipping the remaining tests in the current suite: \`after\`' details='AssertionError: expected 1 to equal 4|n|nBecause this error occurred during a \`after each\` hook we are skipping the remaining tests in the current suite: \`after\`|n    at Context.eval (webpack://hk/./cypress/e2e/hooks.cy.js:15:33)' captureStandardOutput='true' flowId='14448']
##teamcity[testFinished name='runs' duration='1' flowId='14448']
##teamcity[testSuiteFinished name='after' duration='25' flowId='14448']
##teamcity[testSuiteStarted name='afterAll' flowId='14448']
##teamcity[testStarted name='only' captureStandardOutput='true' flowId='14448']
##teamcity[testFailed name='"after all" hook for "only"' message='expected 1 to equal 5|n|nBecause this error occurred during a \`after all\` hook we are skipping the remaining tests in the current suite: \`afterAll\`' details='AssertionError: expected 1 to equal 5|n|nBecause this error occurred during a \`after all\` hook we are skipping the remaining tests in the current suite: \`afterAll\`|n    at Context.eval (webpack://hk/./cypress/e2e/hooks.cy.js:20:29)' captureStandardOutput='true' flowId='14448']
##teamcity[testFinished name='only' duration='1' flowId='14448']
##teamcity[testSuiteFinished name='afterAll' duration='7' flowId='14448']
`;

describe("Cypress hook failures", () => {
  it("fail the test an each hook ran for, and the suite of an all hook", () => {
    const r = results(HOOKS);
    const own = (...path: string[]) => r.get(key("hooks.cy.js", ...path))?.own;
    expect(own("each", "outside")).toBe("passed");
    expect(own("each", "inner", "first")).toBe("failed");
    expect(nodeOutput(r.get(key("hooks.cy.js", "each", "inner", "first"))!)[0]).toBe(
      "AssertionError: expected 1 to equal 2",
    );
    expect(own("all")).toBe("failed");
    expect(own("after", "runs")).toBe("failed");
    expect(own("afterAll")).toBe("failed");
    // No node carries a hook's title.
    const names: string[] = [];
    const visit = (n: TestNode) => {
      names.push(n.name);
      n.children.forEach(visit);
    };
    r.roots.forEach(visit);
    expect(names.filter((n) => /" hook/.test(n))).toEqual([]);
  });

  it("rerun the test or the suite, whose titles @cypress/grep matches", async () => {
    const paths = failedTestPaths(results(HOOKS));
    expect(paths.map((p) => p.join(" › "))).toEqual([
      "hooks.cy.js › each › inner › first",
      "hooks.cy.js › all",
      "hooks.cy.js › after › runs",
      "hooks.cy.js › afterAll",
    ]);
    const [rerun] = await rerunFailedConfigs(npx, paths);
    expect(rerun!.env.CYPRESS_grep).toBe("each inner first; all; after runs; afterAll");
  });
});

describe("Cypress configurations", () => {
  it("are recognised by their type, the recorded runner or the command line", () => {
    expect(frameworkFor(npx)).toBe("cypress");
    expect(frameworkFor(script)).toBe("cypress");
    expect(frameworkFor(cfg({ id: "x", kind: "shell", command: "npx", args: ["cypress", "run"] }))).toBe("cypress");
    expect(frameworkFor(cfg({ id: "open", kind: "npm", command: "npm", args: ["run", "cy:open"] }))).toBe("js");
  });

  it("report through the teamcity reporter unless the configuration chose one", () => {
    expect(withTestReporting(npx).args).toEqual(["cypress", "run", "--reporter", "teamcity"]);
    expect(withTestReporting(script).args).toEqual(["run", "cy:run", "--", "--reporter", "teamcity"]);
    const own = { ...npx, args: ["cypress", "run", "-r", "junit"] };
    expect(withTestReporting(own).args).toEqual(own.args);
  });

  it("choose the browser and the testing type in their form", () => {
    const params = { packageDir: "web", testingType: "component", browser: "firefox", spec: "src/**/*.cy.tsx" };
    const line = cypressType.commandLine({ ...params, options: "--headed" })!;
    expect(line).toEqual({
      command: "npx",
      args: ["cypress", "run", "--component", "--browser", "firefox", "--spec", "src/**/*.cy.tsx", "--headed"],
      cwd: "web",
    });
    expect(cypressType.paramsFrom!({ ...npx, ...line })).toEqual({ ...params, options: "--headed" });
    // The detected configuration opens in the form as it is.
    expect(formParams(npx, cypressType)).toEqual({
      packageDir: "",
      testingType: "e2e",
      browser: "",
      spec: "",
      options: "",
    });
  });
});

describe("Cypress gutter targets", () => {
  const spec = [
    'describe("cart", () => {', // 0
    '  it("adds an item", () => {});', // 1
    '  context("totals, with tax", () => {', // 2
    "    specify(\"sums 'quoted' prices\", () => {});", // 3
    '    it.only("fails on purpose", () => {});', // 4
    "  });",
    "});",
  ].join("\n");

  it("find describe / context blocks and it / specify tests in *.cy.* files", () => {
    expect(detectRunTargets(spec, "cypress/e2e/cart.cy.ts").map((t) => [t.line, t.kind, t.path.join("/")])).toEqual([
      [0, "suite", "cart"],
      [1, "test", "cart/adds an item"],
      [2, "suite", "cart/totals, with tax"],
      [3, "test", "cart/totals, with tax/sums 'quoted' prices"],
      [4, "test", "cart/totals, with tax/fails on purpose"],
    ]);
  });

  it("run a spec with --spec, and a test or suite by its full title", () => {
    const [cart, , , , fails] = detectRunTargets(spec, "cypress/e2e/cart.cy.ts");
    expect(testConfigFor("cypress/e2e/cart.cy.ts", [script], undefined, spec)?.args).toEqual([
      "run",
      "cy:run",
      "--",
      "--spec",
      "cypress/e2e/cart.cy.ts",
    ]);
    const test = targetConfig(fails!, "cypress/e2e/cart.cy.ts", [npx], spec)!;
    expect(test.args).toEqual(["cypress", "run", "--spec", "cypress/e2e/cart.cy.ts"]);
    expect(test.env).toEqual({
      CYPRESS_grep: "cart totals, with tax fails on purpose",
      CYPRESS_grepOmitFiltered: "true",
    });
    expect(test.params?.spec).toBe("cypress/e2e/cart.cy.ts");
    const web = { ...npx, cwd: "web", module: "web" };
    const suite = targetConfig(cart!, "web/cypress/e2e/cart.cy.ts", [web], spec)!;
    expect(suite.args).toEqual(["cypress", "run", "--spec", "cypress/e2e/cart.cy.ts"]);
    expect(suite.env.CYPRESS_grep).toBe("cart");
  });

  it("run component specs as component tests, end-to-end specs end to end", () => {
    const mount = 'it("renders", () => { cy.mount(<Button />); });';
    expect(testConfigFor("src/Button.cy.tsx", [npx], undefined, mount)?.args).toEqual([
      "cypress",
      "run",
      "--component",
      "--spec",
      "src/Button.cy.tsx",
    ]);
    const component = { ...npx, args: ["cypress", "run", "--component", "--browser", "chrome"] };
    expect(testConfigFor("cypress/e2e/cart.cy.ts", [component], undefined, spec)?.args).toEqual([
      "cypress",
      "run",
      "--browser",
      "chrome",
      "--spec",
      "cypress/e2e/cart.cy.ts",
    ]);
  });

  it("never send other tests to Cypress, even when its configuration is the closest one", () => {
    // Vitest at the workspace root; `apps/web` depends on Cypress and has no test script.
    const vitest = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"] });
    const web = { ...npx, id: "cypress:apps/web", cwd: "apps/web", module: "apps/web" };
    const ids = (relPath: string, content: string) => testBasesFor(relPath, [vitest, web], content).map((c) => c.id);
    expect(ids("apps/web/src/util.test.ts", "test('adds', () => {});")).toEqual(["npm:test"]);
    expect(
      testConfigFor("apps/web/src/util.test.ts", [vitest, web], undefined, "test('adds', () => {});")?.args,
    ).toEqual(["run", "test", "--", "apps/web/src/util.test.ts"]);
    expect(ids("apps/web/cypress/e2e/cart.cy.ts", spec)).toEqual(["cypress:apps/web"]);
    // And the other way round: a spec runs on Cypress at the root, not on a closer Vitest.
    const app = { ...vitest, id: "npm:apps/web:test", cwd: "apps/web", module: "apps/web" };
    expect(ids("apps/web/src/Button.cy.tsx", spec)).toEqual(["cypress:apps/web"]);
    expect(testBasesFor("apps/web/src/Button.cy.tsx", [app, npx], spec).map((c) => c.id)).toEqual(["cypress"]);
    expect(testBasesFor("apps/web/src/util.test.ts", [app, npx], spec).map((c) => c.id)).toEqual(["npm:apps/web:test"]);
  });

  it("send specs to Cypress and other tests to the project's other runner", () => {
    const vitest = cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"] });
    const configs = [vitest, npx];
    expect(testBasesFor("cypress/e2e/cart.cy.ts", configs, spec).map((c) => c.id)).toEqual(["cypress"]);
    expect(testBasesFor("src/cart.test.ts", configs, "test('adds', () => {});").map((c) => c.id)).toEqual(["npm:test"]);
  });
});

describe("Cypress Rerun Failed Tests", () => {
  it("runs the failed tests' specs, selecting them by full title", async () => {
    const r = results(RUN);
    const [rerun] = await rerunFailedConfigs({ ...npx, env: { FOO: "1" } }, failedTestPaths(r));
    expect(rerun!.args).toEqual(["cypress", "run", "--spec", "**/cart.cy.ts"]);
    expect(rerun!.env).toEqual({
      FOO: "1",
      CYPRESS_grep: "cart totals, with tax fails on purpose",
      CYPRESS_grepOmitFiltered: "true",
    });
    // The rerun's tree keeps the names of the first run.
    expect(results(RUN, rerun).roots[0]!.name).toBe("cart.cy.ts");
  });

  it("pass the selection as --expose to Cypress 15.10 and later, where @cypress/grep 7 reads it", async () => {
    useProject.setState({
      project: { root: "/p", name: "p", trusted: true, isGit: false, settings: {} as ProjectInfo["settings"] },
    });
    const notify = vi.fn();
    provideNotificationService({ notify } as unknown as NotificationService);
    const selected = { ...script, args: ["run", "cy:run", "--", "--spec", "a.cy.ts"], env: { CYPRESS_grep: "a b" } };
    // No grep plugin: the whole spec runs, and a notification says so.
    installed.files["/p/node_modules/cypress/package.json"] = '{"version":"16.4.0"}';
    installed.files["/p/package.json"] = '{"devDependencies":{"cypress":"^16.0.0"}}';
    expect(await prepareCypressLaunch(selected)).toEqual(selected);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ key: "cypress-grep", title: "Cypress ran the whole spec file" });
    notify.mockClear();
    // A workspace member: the plugin and Cypress are found in the folders above it.
    installed.files["/p/package.json"] = '{"devDependencies":{"cypress":"^16.0.0","@cypress/grep":"^7.0.0"}}';
    expect((await prepareCypressLaunch({ ...selected, cwd: "web" })).args).toEqual([
      ...selected.args,
      "--expose",
      '{"grep":"a b","grepOmitFiltered":true}',
    ]);
    installed.files["/p/node_modules/cypress/package.json"] = '{"version":"15.9.1"}';
    expect(await prepareCypressLaunch(selected)).toEqual(selected);
    // Whole specs need no selection.
    expect(await prepareCypressLaunch({ ...selected, env: {} })).toEqual({ ...selected, env: {} });
    expect(notify).not.toHaveBeenCalled();
  });
});
