import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const h = vi.hoisted(() => ({
  attached: [] as number[],
  onLine: null as ((line: string) => void) | null,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const ipc = await orig<typeof import("@/platform/ipc")>();
  return {
    ...ipc,
    commands: { ...ipc.commands, debugFreePort: () => Promise.resolve({ status: "ok", data: 50123 }) },
    call: async () => 50123,
  };
});
vi.mock("@/platform/actions", async (orig) => ({
  ...(await orig<typeof import("@/platform/actions")>()),
  executeAction: async (id: string, arg: { port: number }) => {
    if (id === "debug.attach") h.attached.push(arg.port);
    return true;
  },
}));
vi.mock("./store", async (orig) => ({
  ...(await orig<typeof import("./store")>()),
  startRun: async (_config: RunConfig, _reuse: unknown, _base: unknown, options: { onLine: (l: string) => void }) => {
    h.onLine = options.onLine;
    return { id: "s1" };
  },
}));

import { debugWithAgent, isTestForkBanner } from "./javaDebug";

const mavenTest: RunConfig = {
  id: "t",
  name: "SolutionTest.test_numSquares",
  kind: "maven",
  command: "mvn",
  args: ["test", "-Dtest=SolutionTest#test_numSquares"],
  cwd: "",
  env: {},
  isTest: true,
} as unknown as RunConfig;

beforeEach(() => {
  h.attached = [];
  h.onLine = null;
});

describe("Maven test debugging", () => {
  it("recognizes the banner Surefire prints before it starts the fork, coloured or not", () => {
    expect(isTestForkBanner("[INFO]  T E S T S")).toBe(true);
    expect(isTestForkBanner("[\x1b[1;34mINFO\x1b[m]  T E S T S")).toBe(true);
    expect(isTestForkBanner(" T E S T S")).toBe(true);
    expect(isTestForkBanner("[INFO] Tests run: 1, Failures: 0")).toBe(false);
  });

  it("attaches to the pinned port when the fork starts, not while Maven still compiles", async () => {
    await debugWithAgent(mavenTest);
    expect(h.attached).toEqual([]);
    h.onLine!("[INFO] --- compiler:3.15.0:testCompile (default-testCompile) @ leetcode-java ---");
    expect(h.attached).toEqual([]);
    h.onLine!("[INFO] -------------------------------------------------------");
    h.onLine!("[INFO]  T E S T S");
    expect(h.attached).toEqual([50123]);
    // The fork's own line, released once the tests run, doesn't attach twice.
    h.onLine!("Listening for transport dt_socket at address: 50123");
    expect(h.attached).toEqual([50123]);
  });
});
