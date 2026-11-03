import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/projectRoots", () => ({
  currentRoots: () => [
    { path: "lib", kind: "source", detectedFrom: null },
    { path: "test", kind: "test", detectedFrom: null },
    { path: "", kind: "source", detectedFrom: null },
  ],
}));

import { produceContext, type ToolEnv } from "./producers";

const env: ToolEnv = {
  tool: (n) => (n === "ruby" ? { path: "/bin/ruby", version: null } : null),
  compileDir: "/tmp/openidea-run",
};
const input = (path: string) => ({ path, root: "/work/app", configs: [], content: undefined, line: undefined });

describe("Ruby file run", () => {
  it("puts Sources roots on the load path", () => {
    const p = produceContext(input("/work/app/test/integration/a_test.rb"), env);
    expect(p?.config?.args).toEqual(["-Ilib", "test/integration/a_test.rb"]);
  });

  it("adds none for files outside the project", () => {
    const p = produceContext(input("/elsewhere/a.rb"), env);
    expect(p?.config?.args).toEqual(["a.rb"]);
  });
});
