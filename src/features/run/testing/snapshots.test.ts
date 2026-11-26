import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { jsParser } from "./js";
import { TestResults } from "./results";
import { isSnapshotFailure, snapshotFailures, updateSnapshotConfigs } from "./snapshots";
import jestOutput from "./fixtures/jest-snapshots.txt?raw";
import vitestOutput from "./fixtures/vitest-snapshots.txt?raw";
import jestObsolete from "./fixtures/jest-obsolete-snapshots.txt?raw";
import vitestObsolete from "./fixtures/vitest-obsolete-snapshots.txt?raw";

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
  ])("recognizes %s file and inline snapshot failures, not other failures", (_, output) => {
    const r = results(output);
    expect(names(r)).toEqual(["cart file snap", "cart other snap", "cart inline snap"]);
    const file = r.roots[0]!;
    expect(snapshotFailures([file])).toHaveLength(3);
    expect(isSnapshotFailure(file)).toBe(false);
    expect(isSnapshotFailure(file.children[0]!.children[3]!)).toBe(false);
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

describe("updateSnapshotConfigs", () => {
  const paths = [["src/a.test.ts", "cart", "file snap"]];

  it("reruns the chosen test with its name filter and -u", () => {
    const [c, ...rest] = updateSnapshotConfigs(cfg("npm", ["run", "test", "--", "-t", "old"]), paths);
    expect(rest).toEqual([]);
    expect(c!.name).toBe("Update Snapshots: test");
    expect(c!.args).toEqual(["run", "test", "--", "src/a.test.ts", "-t", "^(?:cart file snap)$", "-u"]);
    expect(updateSnapshotConfigs({ ...c!, args: ["vitest", "run"] }, paths)[0]!.name).toBe("Update Snapshots: test");
  });

  it("runs a whole file when the file node has no named tests", () => {
    const [c] = updateSnapshotConfigs(cfg("npx", ["vitest", "run"]), [["src/a.test.ts"]]);
    expect(c!.args).toEqual(["vitest", "run", "src/a.test.ts", "-u"]);
  });

  it("is unsupported outside Jest / Vitest", () => {
    expect(updateSnapshotConfigs(cfg("npx", ["playwright", "test"]), paths)).toEqual([]);
    expect(updateSnapshotConfigs(cfg("pytest", [], "pytest"), paths)).toEqual([]);
    expect(updateSnapshotConfigs(cfg("npm", []), [])).toEqual([]);
  });
});
