import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/projectRoots", () => ({
  currentRoots: () => [
    { path: "lib", kind: "source", detectedFrom: null },
    { path: "test", kind: "test", detectedFrom: null },
    { path: "spec", kind: "test", detectedFrom: null },
    { path: "", kind: "source", detectedFrom: null },
  ],
}));

import type { RunConfig } from "@/platform/ipc";
import { produceContext, produceDirectory, produceFile, type ToolEnv } from "./producers";

const env: ToolEnv = {
  tool: (n) => (n === "ruby" ? { path: "/bin/ruby", version: null } : null),
  compileDir: "/tmp/openidea-run",
};
const input = (path: string) => ({ path, root: "/work/app", configs: [], content: undefined, line: undefined });

describe("Ruby file run", () => {
  it("puts Sources roots on the load path", () => {
    const p = produceContext(input("/work/app/test/integration/a_test.rb"), env);
    expect(p?.config?.args).toEqual(["-Ilib", "test/integration/a_test.rb"]);
    expect(p?.config?.debugAdapter).toBe("rdbg");
  });

  it("adds none for files outside the project", () => {
    const p = produceContext(input("/elsewhere/a.rb"), env);
    expect(p?.config?.args).toEqual(["a.rb"]);
  });
});

describe("Ruby directory run", () => {
  const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
    name: over.id,
    command: "bundle",
    args: [],
    cwd: null,
    env: {},
    detected: true,
    isTest: true,
    debugAdapter: null,
    ...over,
  });
  const dir = (path: string, configs: RunConfig[]) =>
    produceDirectory({ path: `/work/app/${path}`, root: "/work/app", configs });

  it("RSpec on a nested folder", () => {
    const p = dir("spec/models/user", [cfg({ id: "rspec", kind: "rspec", args: ["exec", "rspec"] })]);
    expect(p?.config?.args).toEqual(["exec", "rspec", "spec/models/user"]);
    expect(p?.name).toBe("Tests in 'user'");
  });

  it("rake test with a TEST glob", () => {
    const p = dir("test/unit", [cfg({ id: "rake:test", kind: "rake", args: ["exec", "rake", "test"] })]);
    expect(p?.config?.args).toEqual(["exec", "rake", "test", "TEST=test/unit/**/*_test.rb,test/unit/**/test_*.rb"]);
  });

  it("the Minitest runner with Sources roots and the folder", () => {
    const base = cfg({ id: "minitest", kind: "ruby", args: ["exec", "ruby", "-Itest", "-e", "SCRIPT", "test"] });
    const p = dir("test/unit", [base]);
    expect(p?.config?.args).toEqual(["exec", "ruby", "-Itest", "-Ilib", "-e", "SCRIPT", "test/unit"]);
  });

  it("the test root itself", () => {
    const p = dir("test", [cfg({ id: "rspec", kind: "rspec", args: ["exec", "rspec"] })]);
    expect(p?.config?.args).toEqual(["exec", "rspec", "test"]);
  });

  it("nothing for non-test folders or projects without a Ruby runner", () => {
    expect(dir("lib/unit", [cfg({ id: "rspec", kind: "rspec" })])).toBeNull();
    expect(dir("other/unit", [cfg({ id: "rspec", kind: "rspec" })])).toBeNull();
    expect(dir("test/unit", [])).toBeNull();
  });
});

describe("Ruby test files", () => {
  const rake = {
    id: "rake:test",
    name: "rake test",
    kind: "rake",
    command: "bundle",
    args: ["exec", "rake", "test"],
    cwd: null,
    env: {},
    detected: true,
    isTest: true,
    debugAdapter: null,
  } as RunConfig;
  const minitest = {
    ...rake,
    id: "minitest",
    name: "minitest",
    kind: "ruby",
    command: "ruby",
    args: ["-Ilib", "-Itest", "-e", "RUNNER", "test"],
  } as RunConfig;
  const file = (path: string, configs: RunConfig[]) =>
    produceFile({ path: `/work/app/${path}`, root: "/work/app", configs, content: "" }, env);

  it("test_*.rb is a test file: rake test with TEST=<file>, reported per test", () => {
    const p = file("test/unit/test_decide.rb", [rake]);
    expect(p?.config).toMatchObject({ isTest: true, args: ["exec", "rake", "test", "TEST=test/unit/test_decide.rb"] });
  });

  it("without a rake test task the detected Minitest runner loads the file", () => {
    const p = file("test/unit/test_decide.rb", [minitest]);
    expect(p?.config).toMatchObject({
      isTest: true,
      kind: "ruby",
      args: ["-Ilib", "-Itest", "-e", "RUNNER", "test/unit/test_decide.rb"],
    });
  });

  it("other scripts stay plain runs", () => {
    expect(file("lib/tool.rb", [rake])?.config?.isTest).toBe(false);
  });
});
