import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  nextRunId: 7,
  runStart: vi.fn(),
  runStop: vi.fn(async (_runId: unknown) => ({ status: "ok" as const, data: null })),
}));
ipc.runStart.mockImplementation(async () => ({
  status: "ok" as const,
  data: { id: ipc.nextRunId++, configId: "c", name: "c", pid: 1, running: true },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, runStart: ipc.runStart, runStop: ipc.runStop },
  };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import type { RunConfig, RunId } from "@/platform/ipc";
import { registerRunExecutor } from "@/workbench/contributions";
import { runWithExecutor } from "./executors";
import { BEFORE_STOP_TIMEOUT_MS, onRunExited, resetRuns, stopSession, useRun } from "./store";

const config: RunConfig = {
  id: "cargo:test",
  name: "cargo test",
  kind: "cargo",
  command: "cargo",
  args: ["test"],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
};

type BeforeStop = (runId: RunId) => Promise<void>;

/** Past the store's 30 ms wait for output still on the channel before an exit is applied. */
const EXIT_SETTLE_MS = 50;

let dispose: (() => void) | undefined;

function register(beforeStop?: BeforeStop) {
  dispose = registerRunExecutor({
    id: "fake",
    label: (n) => n,
    icon: "run",
    action: "fake.run",
    supports: () => true,
    prepare: async () => ({ launch: config, finished: () => undefined, beforeStop }),
  });
}

async function start(): Promise<string> {
  await runWithExecutor(config, "fake");
  return useRun.getState().sessions[0]!.id;
}

function session() {
  return useRun.getState().sessions[0]!;
}

/** A hook that settles only when the test says so. */
function controlledHook() {
  const settle: Array<() => void> = [];
  const hook = vi.fn<BeforeStop>(() => new Promise<void>((resolve) => settle.push(resolve)));
  return { hook, settle };
}

beforeEach(() => {
  ipc.nextRunId = 7;
  ipc.runStop.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  resetRuns();
  vi.clearAllTimers();
  vi.useRealTimers();
  dispose?.();
  dispose = undefined;
});

describe("an executor's beforeStop hook", () => {
  it("stop waits for beforeStop then sends the stop", async () => {
    const hook = vi.fn<BeforeStop>(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    register(hook);
    const id = await start();

    const stopped = stopSession(id);
    await vi.advanceTimersByTimeAsync(50);
    expect(ipc.runStop).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ status: "stopping", stopped: true });

    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
    expect(ipc.runStop).toHaveBeenCalledWith(7);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(7);
  });

  it("second stop while beforeStop is pending stops at once", async () => {
    const { hook } = controlledHook();
    register(hook);
    const id = await start();

    void stopSession(id);
    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("stop after the pending hook settles sends nothing more", async () => {
    const { hook, settle } = controlledHook();
    register(hook);
    const id = await start();

    const first = stopSession(id);
    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(1);

    // The first Stop's continuation must not turn the SIGINT in flight into a SIGKILL.
    settle[0]!();
    await first;
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BEFORE_STOP_TIMEOUT_MS);
    expect(ipc.runStop).toHaveBeenCalledTimes(1);

    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("beforeStop that never settles still stops after the cap", async () => {
    const { hook } = controlledHook();
    register(hook);
    const id = await start();

    const stopped = stopSession(id);
    await vi.advanceTimersByTimeAsync(BEFORE_STOP_TIMEOUT_MS - 1);
    expect(ipc.runStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
    expect(ipc.runStop).toHaveBeenCalledWith(7);
  });

  it("a rejected beforeStop still stops", async () => {
    register(vi.fn<BeforeStop>(() => Promise.reject(new Error("no listener"))));
    const id = await start();

    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
    expect(session().status).toBe("stopping");
  });

  it("a beforeStop that throws still stops", async () => {
    register(
      vi.fn<BeforeStop>(() => {
        throw new Error("boom");
      }),
    );
    const id = await start();

    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
  });

  it("runs without beforeStop stop as before", async () => {
    register();
    const id = await start();

    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(1);
    await stopSession(id);
    expect(ipc.runStop).toHaveBeenCalledTimes(2);
  });

  it("does not stop a program that exited while the hook was pending", async () => {
    const { hook, settle } = controlledHook();
    register(hook);
    const id = await start();

    const stopped = stopSession(id);
    onRunExited(7 as RunId, 0);
    await vi.advanceTimersByTimeAsync(EXIT_SETTLE_MS);
    expect(session().status).toBe("finished");

    settle[0]!();
    await stopped;
    expect(ipc.runStop).not.toHaveBeenCalled();
    expect(session().status).toBe("finished");
  });

  it("does not stop the new run of a tab that was rerun while the hook was pending", async () => {
    const { hook, settle } = controlledHook();
    register(hook);
    const id = await start();

    const stopped = stopSession(id);
    onRunExited(7 as RunId, 0);
    await vi.advanceTimersByTimeAsync(EXIT_SETTLE_MS);
    await runWithExecutor(config, "fake");
    expect(session()).toMatchObject({ id, runId: 8, status: "running" });

    settle[0]!();
    await stopped;
    expect(ipc.runStop).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ runId: 8, status: "running" });
  });
});
