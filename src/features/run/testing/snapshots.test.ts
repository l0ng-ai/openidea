import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { jsParser } from "./js";
import { TestResults } from "./results";
import { snapshotFailures, snapshotRunner, snapshotTestConfigs, snapshotUpdateArgs, targetNodes } from "./snapshots";
import jestOutput from "./fixtures/jest-snapshots.txt?raw";
import vitestOutput from "./fixtures/vitest-snapshots.txt?raw";
import jestObsolete from "./fixtures/jest-obsolete-snapshots.txt?raw";
import vitestObsolete from "./fixtures/vitest-obsolete-snapshots.txt?raw";
import jestResolves from "./fixtures/jest-resolves-snapshot.txt?raw";

function results(output: string): TestResults {
  const r = new TestResults();
  const parser = jsParser();
  for (const line of output.split("\n")) r.apply(parser.feed(line));
  return r;
}

const cfg = (command: string, args: string[], kind = "npm"): RunConfig => ({
  id: "npm:test",
  name: "test",
  kind,
  command,
  args,
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
});

const names = (r: TestResults) => snapshotFailures(r.roots).map((n) => n.path.slice(1).join(" "));

describe("snapshot mismatches", () => {
  it.each([
    ["Jest", jestOutput],
    ["Vitest", vitestOutput],
  ])("recognizes %s file and inline snapshot failures, not other failures", (runner, output) => {
    const r = results(output);
    expect(names(r)).toEqual(["cart file snap", "cart other snap", "cart inline snap"]);
    const file = r.roots[0]!;
    expect(snapshotFailures([file]).map(snapshotRunner)).toEqual(Array(3).fill(runner.toLowerCase()));
    expect(snapshotRunner(file)).toBeNull();
    expect(snapshotRunner(file.children[0]!.children[3]!)).toBeNull();
  });

  it("recognizes Jest's `.resolves` / `.rejects` snapshot matchers", () => {
    expect(names(results(jestResolves))).toEqual(["async snap"]);
    const line = (m: string) => results(`FAIL a.test.js\n  ● t\n\n    expect(received).${m}()\n`);
    expect(names(line("rejects.toThrowErrorMatchingInlineSnapshot"))).toEqual(["t"]);
    expect(names(line("resolves.toBe"))).toEqual([]);
  });

  it("finds the results of a gutter target: a test, or a suite with its tests", () => {
    const r = results(vitestOutput);
    expect(targetNodes(r.roots, { path: ["cart"], file: "a.test.js" }).map((n) => n.name)).toEqual(["cart"]);
    expect(targetNodes(r.roots, { path: ["cart", "plain fail"], file: "a.test.js" }).map((n) => n.name)).toEqual([
      "plain fail",
    ]);
    expect(targetNodes(r.roots, { path: ["cart"], file: "b.test.js" })).toEqual([]);
  });

  it.each([
    ["Jest", jestObsolete],
    ["Vitest", vitestObsolete],
  ])("ignores %s obsolete-snapshot warnings", (_, output) => {
    const r = results(output);
    expect(r.counts().failed).toBe(1);
    expect(names(r)).toEqual([]);
  });
});

describe("snapshot update runs", () => {
  const paths = [["src/a.test.ts", "cart", "file snap"]];

  it("run the chosen test with its name filter", () => {
    const [c, ...rest] = snapshotTestConfigs(cfg("npm", ["run", "test", "--", "-t", "old"]), paths, "file snap");
    expect(rest).toEqual([]);
    expect(c!.name).toBe("file snap");
    expect(c!.args).toEqual(["run", "test", "--", "src/a.test.ts", "-t", "^(?:cart file snap)$"]);
    const [file] = snapshotTestConfigs(cfg("npx", ["vitest", "run"]), [["src/a.test.ts"]], "a.test.ts");
    expect(file!.args).toEqual(["vitest", "run", "src/a.test.ts"]);
    const watched: RunConfig & { watch?: boolean } = { ...cfg("npm", ["run", "test"]), watch: true };
    expect(snapshotTestConfigs(watched, paths, "x")[0]).not.toHaveProperty("watch", true);
  });

  it("add -u; Jest also ignores every other test path, keeping other files' obsolete snapshots", () => {
    expect(snapshotUpdateArgs(cfg("npm", []), paths, false)).toEqual(["-u"]);
    const args = snapshotUpdateArgs(cfg("npm", []), [...paths, ["./src/b.test.ts"]], true);
    expect(args.slice(0, 2)).toEqual(["-u", "--testPathIgnorePatterns"]);
    const ignored = new RegExp(args[2]!);
    expect(ignored.test("/p/src/a.test.ts")).toBe(false);
    expect(ignored.test("C:\\p\\src\\b.test.ts")).toBe(false);
    expect(ignored.test("/p/src/c.test.ts")).toBe(true);
    expect(ignored.test("/p/src/xa.test.ts")).toBe(true);
    expect(ignored.test("/p/test/src/a.test.tsx")).toBe(true);
    expect(snapshotUpdateArgs(cfg("bun", ["test"], "bun"), paths, true)).toEqual(["-u"]);
  });

  it("are unsupported outside Jest / Vitest", () => {
    expect(snapshotTestConfigs(cfg("npx", ["playwright", "test"]), paths, "x")).toEqual([]);
    expect(snapshotTestConfigs(cfg("pytest", [], "pytest"), paths, "x")).toEqual([]);
    expect(snapshotTestConfigs(cfg("npm", []), [], "x")).toEqual([]);
  });
});
