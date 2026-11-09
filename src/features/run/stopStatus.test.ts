import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const runStop = vi.hoisted(() => vi.fn(async () => ({ status: "ok" as const, data: null })));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, runStop },
    call: async (p: Promise<{ status: "ok"; data: unknown }>) => (await p).data,
  };
});
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...real, notifications: () => ({ notify: () => undefined }) };
});

import { isLive, onRunExited, stopSession, useRun, type RunSession } from "./store";

const config: RunConfig = {
  id: "app",
  name: "app",
  kind: "spring-boot",
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
};

const session: RunSession = {
  id: "s1",
  config,
  runId: 7 as RunSession["runId"],
  status: "running",
  exitCode: null,
  startedAt: 0,
  endedAt: null,
  stdinClosed: false,
};

beforeEach(() => {
  runStop.mockClear();
  useRun.setState({ sessions: [session], activeSession: "s1" });
});

describe("Stop keeps the tab live until the process is gone", () => {
  it("a stopping run counts as live", () => {
    for (const status of ["starting", "running", "stopping"] as const) expect(isLive({ status }), status).toBe(true);
    for (const status of ["finished", "failed"] as const) expect(isLive({ status }), status).toBe(false);
  });

  it("stays stopping after the stop request and only finishes on the exit event", async () => {
    await stopSession("s1");
    expect(runStop).toHaveBeenCalledWith(session.runId);
    expect(useRun.getState().sessions[0]).toMatchObject({ status: "stopping", stopped: true });
    // The button stays Stop while the process shuts down: Run must not start again yet.
    expect(isLive(useRun.getState().sessions[0]!)).toBe(true);

    onRunExited(session.runId!, 130);
    await new Promise((r) => setTimeout(r, 10));
    expect(useRun.getState().sessions[0]?.status).toBe("finished");
    expect(isLive(useRun.getState().sessions[0]!)).toBe(false);
  });

  it("a second Stop while stopping asks the server to kill it", async () => {
    await stopSession("s1");
    await stopSession("s1");
    expect(runStop).toHaveBeenCalledTimes(2);
  });
});
