import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, RunConfig } from "@/platform/ipc";

const ipc = vi.hoisted(() => ({
  prepare: vi.fn(),
  collect: vi.fn(),
  gc: vi.fn(),
}));

vi.mock("@/platform/ipc", () => ({
  call: async <T>(p: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>) => {
    const r = await p;
    if (r.status === "error") throw new Error(String(r.error));
    return r.data;
  },
  commands: {
    profilerPrepare: ipc.prepare,
    profilerCollect: ipc.collect,
    profilerGcBeforeStop: ipc.gc,
  },
  isTauri: () => true,
}));

vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: vi.fn() }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

import { LIVE_NOT_COLLECTED, LIVE_NOT_STOPPED, profilerExecutor } from "./executor";
import { resetProfiler, useProfiler } from "./store";

const config: RunConfig = {
  id: "c",
  name: "App",
  kind: "application",
  command: "java",
  args: ["-cp", "x", "A"],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
};

const profile = { profiler: "async-profiler", unit: "bytes", mode: "liveObjects" } as unknown as Profile;
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });

beforeEach(() => {
  resetProfiler();
  ipc.prepare.mockReset();
  ipc.collect.mockReset();
  ipc.gc.mockReset();
  ipc.prepare.mockImplementation(() => ok({ status: "ready", launch: config, spec: { id: "s" } }));
  ipc.collect.mockImplementation(() => ok(profile));
});

async function snapshotOf(mode: "cpu" | "allocations" | "liveObjects", collected: number | null, stopped: boolean) {
  const launch = await profilerExecutor(mode).prepare(config);
  if (collected !== null) {
    ipc.gc.mockImplementation(() => ok(collected));
    await launch!.beforeStop!(1 as never);
  }
  const before = useProfiler.getState().snapshots.length;
  launch!.finished({ exitCode: 0, stopped });
  await vi.waitFor(() => expect(useProfiler.getState().snapshots).toHaveLength(before + 1));
  return useProfiler.getState().snapshots[0]!;
}

describe("profiler executors", () => {
  it("describes the three modes", () => {
    expect(
      (["cpu", "allocations", "liveObjects"] as const).map((m) => {
        const e = profilerExecutor(m);
        return [e.id, e.label("App"), e.action, e.order];
      }),
    ).toEqual([
      ["profiler", "Profile 'App'", "run.profile", 20],
      ["profilerAllocations", "Profile 'App' Allocations", "run.profileAllocations", 21],
      ["profilerLiveObjects", "Profile 'App' Live Objects", "run.profileLiveObjects", 22],
    ]);
  });

  it("prepare sends the executor's mode", async () => {
    for (const mode of ["cpu", "allocations", "liveObjects"] as const) {
      await profilerExecutor(mode).prepare(config);
      expect(ipc.prepare).toHaveBeenLastCalledWith(config, mode);
    }
  });

  it("only live objects has beforeStop", async () => {
    const has = async (mode: "cpu" | "allocations" | "liveObjects") =>
      typeof (await profilerExecutor(mode).prepare(config))!.beforeStop;
    expect(await has("cpu")).toBe("undefined");
    expect(await has("allocations")).toBe("undefined");
    expect(await has("liveObjects")).toBe("function");
  });

  it("live snapshot of a run that ended by itself carries the notice", async () => {
    const s = await snapshotOf("liveObjects", null, false);
    expect(s.notice).toBe(LIVE_NOT_STOPPED);
    expect(ipc.gc).not.toHaveBeenCalled();
  });

  it("live snapshot without a collected JVM carries the notice", async () => {
    const s = await snapshotOf("liveObjects", 0, true);
    expect(s.notice).toBe(LIVE_NOT_COLLECTED);
  });

  it("a failed GC request counts as no collection", async () => {
    const launch = await profilerExecutor("liveObjects").prepare(config);
    ipc.gc.mockImplementation(() => Promise.resolve({ status: "error", error: "boom" }));
    await launch!.beforeStop!(1 as never);
    launch!.finished({ exitCode: 0, stopped: true });
    await vi.waitFor(() => expect(useProfiler.getState().snapshots).toHaveLength(1));
    expect(useProfiler.getState().snapshots[0]?.notice).toBe(LIVE_NOT_COLLECTED);
  });

  it("live snapshot after GC has no notice", async () => {
    const s = await snapshotOf("liveObjects", 1, true);
    expect(s.notice).toBeNull();
    expect(ipc.gc).toHaveBeenCalledWith(1);
  });

  it("beforeStop works detached from the launch object", async () => {
    const launch = await profilerExecutor("liveObjects").prepare(config);
    const { beforeStop, finished } = launch!;
    ipc.gc.mockImplementation(() => ok(2));
    await beforeStop!(1 as never);
    finished({ exitCode: 0, stopped: true });
    await vi.waitFor(() => expect(useProfiler.getState().snapshots).toHaveLength(1));
    expect(useProfiler.getState().snapshots[0]?.notice).toBeNull();
  });

  it("each launch remembers its own collection", async () => {
    const first = await profilerExecutor("liveObjects").prepare(config);
    ipc.gc.mockImplementation(() => ok(1));
    await first!.beforeStop!(1 as never);
    const second = await profilerExecutor("liveObjects").prepare(config);
    second!.finished({ exitCode: 0, stopped: true });
    await vi.waitFor(() => expect(useProfiler.getState().snapshots).toHaveLength(1));
    expect(useProfiler.getState().snapshots[0]?.notice).toBe(LIVE_NOT_COLLECTED);
  });

  it("allocation snapshot has no notice", async () => {
    const s = await snapshotOf("allocations", null, true);
    expect(s.notice).toBeNull();
    const cpu = await snapshotOf("cpu", null, false);
    expect(cpu.notice).toBeNull();
  });
});
