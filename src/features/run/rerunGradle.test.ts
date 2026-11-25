import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { resetRuns, rerunFailed, runSelectedTests, runtime, startRun, useRun } from "./store";

const classModules = vi.hoisted(() =>
  vi.fn(async (cls: string) => ({ "com.a.AlphaTest": ["alpha"], "com.b.BetaTest": ["beta"] })[cls] ?? []),
);
vi.mock("@/platform/javaLaunch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/javaLaunch")>()),
  classModules,
}));
vi.mock("./dialogs", () => ({
  confirmRerun: vi.fn(async () => true),
  confirmTerminate: vi.fn(async () => true),
  promptValue: vi.fn(),
  RunDialogsOverlay: () => null,
}));

const rootTests: RunConfig = {
  id: "gradle:test",
  name: "gradle test",
  kind: "gradle",
  command: "./gradlew",
  args: ["test"],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
};

beforeEach(() => {
  resetRuns();
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});

const failedRootRun = async () => {
  const session = (await startRun(rootTests))!;
  runtime(session.id)!.tests!.apply([
    { type: "result", path: ["com.a.AlphaTest", "one"], status: "failed" },
    { type: "result", path: ["com.b.BetaTest", "two"], status: "failed" },
  ]);
  useRun.setState({
    sessions: useRun.getState().sessions.map((s) => (s.id === session.id ? { ...s, status: "finished" } : s)),
  });
  return session;
};

const lastArgs = () => useRun.getState().sessions.at(-1)!.config.args;

describe("Gradle reruns after a run of the root test task", () => {
  it("Rerun Failed Tests runs each test in its own subproject's test task", async () => {
    const session = await failedRootRun();
    expect(await rerunFailed(session.id)).toBe(true);
    await vi.waitFor(() =>
      expect(lastArgs()).toEqual([
        ":alpha:test",
        "--tests",
        "com.a.AlphaTest.one",
        ":beta:test",
        "--tests",
        "com.b.BetaTest.two",
        "--continue",
      ]),
    );
  });

  it("running a selection from the tree does the same", async () => {
    const session = await failedRootRun();
    const beta = runtime(session.id)!.tests!.node(["com.b.BetaTest", "two"]);
    expect(await runSelectedTests(session.id, [beta.id], false)).toBe(true);
    expect(lastArgs()).toEqual([":beta:test", "--tests", "com.b.BetaTest.two"]);
  });

  it("keeps today's command line when a class is not found", async () => {
    classModules.mockResolvedValueOnce([]);
    const session = await failedRootRun();
    expect(await rerunFailed(session.id)).toBe(true);
    await vi.waitFor(() =>
      expect(lastArgs()).toEqual(["test", "--tests", "com.a.AlphaTest.one", "--tests", "com.b.BetaTest.two"]),
    );
  });
});
