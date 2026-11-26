import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn(async (_config: RunConfig) => ({ status: "ok", data: 1 })),
  runStop: vi.fn(async () => ({ status: "ok", data: null })),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import type { TestEvent } from "./testing";
import {
  canUpdateSnapshots,
  rerunConfig,
  resetRuns,
  runtime,
  snapshotFailuresAt,
  startRun,
  updateSnapshots,
  useRun,
} from "./store";

const SEP = "\u0000";
const npm = (id: string): RunConfig => ({
  id,
  name: id,
  kind: "npm",
  command: "npm",
  args: ["run", "test"],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
});
const total = ["a.test.ts", "cart", "total"];
const count = ["a.test.ts", "cart", "count"];
const jestFailures: TestEvent[] = [
  { type: "result", path: total, status: "failed" },
  { type: "output", path: total, line: "    expect(received).toMatchSnapshot()" },
  { type: "result", path: count, status: "failed" },
  { type: "output", path: count, line: "    expect(received).toBe(expected)" },
];

/** A finished run of `config` whose test tree holds `events` (pinned: later runs open their own tabs). */
async function finishedRun(config: RunConfig, events: TestEvent[], startedAt: number) {
  const session = (await startRun(config, undefined, undefined, { prepared: true }))!;
  runtime(session.id)!.tests!.apply(events);
  useRun.setState((s) => ({
    sessions: s.sessions.map((x) => (x.id === session.id ? { ...x, status: "finished", startedAt, pinned: true } : x)),
  }));
  return session.id;
}

const session = (id: string) => useRun.getState().sessions.find((s) => s.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn(), hide: vi.fn() } as unknown as ToolWindowService);
});
afterEach(() => resetRuns());

it("launches the chosen snapshot mismatches with -u, and the tab's Rerun runs them without it", async () => {
  const base = npm("npm:test");
  const id = await finishedRun(base, jestFailures, 1);
  expect(canUpdateSnapshots(id, [count.join(SEP)])).toBe(false);
  expect(await updateSnapshots(id, ["a.test.ts"])).toBe(true);
  await vi.waitFor(() => expect(ipc.runStart).toHaveBeenCalledTimes(2));
  const launched = ipc.runStart.mock.calls[1]![0];
  expect(launched.args).toEqual([
    "run",
    "test",
    "--",
    "a.test.ts",
    "-t",
    "^(?:cart total)$",
    "-u",
    "--testPathIgnorePatterns",
    "^(?!.*(?:^|[\\\\/])(?:a\\.test\\.ts)$)",
  ]);
  await vi.waitFor(() => expect(session(id).config.args).not.toContain("-u"));
  expect(session(id).config.args).toEqual(["run", "test", "--", "a.test.ts", "-t", "^(?:cart total)$"]);
  expect(session(id).config.name).toBe("total");
  expect(session(id).baseConfig).toEqual(base);
  expect(rerunConfig(session(id)).args).not.toContain("-u");
  expect(useRun.getState().sessions).toHaveLength(1);
});

it("offers the gutter's Update Snapshot only from the newest finished run of the target", async () => {
  const older = await finishedRun(npm("npm:a"), jestFailures, 1);
  const suite = { path: ["cart"], file: "a.test.ts" };
  expect(snapshotFailuresAt(suite)).toEqual({ sessionId: older, nodeIds: [total.join(SEP)] });
  expect(snapshotFailuresAt({ path: ["cart", "count"], file: "a.test.ts" })).toBeNull();
  // A newer run of other tests doesn't hide it.
  await finishedRun(npm("npm:b"), [{ type: "result", path: ["b.test.ts", "x"], status: "passed" }], 2);
  expect(snapshotFailuresAt(suite)?.sessionId).toBe(older);
  // A newer run where the snapshot passed makes the older failure stale.
  await finishedRun(npm("npm:c"), [{ type: "result", path: total, status: "passed" }], 3);
  expect(snapshotFailuresAt(suite)).toBeNull();
});
