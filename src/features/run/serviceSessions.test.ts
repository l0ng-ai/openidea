import { expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import type { DebugServiceSession } from "@/workbench/contributions";
import type { RunSession } from "./store";
import { currentServiceSession, serviceDebugger, serviceSessions, stopServiceSessions } from "./serviceSessions";

const stopRun = vi.hoisted(() => vi.fn());
vi.mock("./store", () => ({ stopSession: stopRun }));
const config = (id = "app"): RunConfig => ({
  id,
  name: "same name",
  kind: "spring-boot",
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "java-debug",
});
const run = (id: string, startedAt: number, extra: Partial<RunSession> = {}): RunSession => ({
  id,
  config: config(),
  startedAt,
  runId: 7,
  status: "running",
  endedAt: null,
  exitCode: null,
  stdinClosed: false,
  ...extra,
});
const debug = (id: number, startedAt: number, extra: Partial<DebugServiceSession> = {}): DebugServiceSession => ({
  id,
  config: config(),
  startedAt,
  status: "running",
  processId: null,
  stop: vi.fn(async () => {}),
  rerun: vi.fn(),
  show: vi.fn(),
  ...extra,
});

it("prefers a live debug launch to stale Run output and isolates equal names by config id", () => {
  const d = debug(1, 2);
  const sessions = serviceSessions(
    [run("old", 1, { status: "finished" })],
    [d, debug(2, 3, { config: config("other") })],
  );
  expect(currentServiceSession("app", sessions)?.debug).toEqual([d]);
  expect(currentServiceSession("other", sessions)?.debug[0]?.id).toBe(2);
});

it("keeps an older live instance ahead of a newer finished one and uses stable tie breaking", () => {
  const active = debug(1, 1);
  const sessions = serviceSessions([run("done", 10, { status: "finished" })], [active]);
  expect(currentServiceSession("app", sessions)?.debug).toEqual([active]);
  const tied = serviceSessions([run("a", 1)], [active]);
  expect(currentServiceSession("app", tied)?.debug).toEqual([active]);
  expect(currentServiceSession("app", [...tied].reverse())?.debug).toEqual([active]);
});

it("pairs all debugger roots with the same Run process without guessing by config id alone", () => {
  const r = run("maven", 1);
  const d = [debug(1, 2, { processId: 7 }), debug(2, 3, { processId: 7 })];
  const sessions = serviceSessions([r], [...d, debug(3, 4, { processId: 8 })]);
  expect(sessions).toHaveLength(2);
  expect(sessions[0]).toMatchObject({ run: r, debug: d, startedAt: 1 });
  expect(serviceDebugger(sessions[0])).toBe(d[1]);
  expect(serviceSessions([r], [debug(4, 5, { config: config("other"), processId: 7 })])).toHaveLength(2);
});

it("falls back to Run controls when its attached debugger has terminated", () => {
  const sessions = serviceSessions([run("maven", 1)], [debug(1, 2, { processId: 7, status: "terminated" })]);
  expect(serviceDebugger(sessions[0])).toBeUndefined();
  expect(currentServiceSession("app", sessions)?.run?.id).toBe("maven");
});

it("stops the displayed execution without stopping another parallel instance", async () => {
  const first = debug(1, 1);
  const latest = debug(2, 2);
  const selected = currentServiceSession("app", serviceSessions([], [first, latest]))!;
  await stopServiceSessions([selected]);
  expect(latest.stop).toHaveBeenCalledOnce();
  expect(first.stop).not.toHaveBeenCalled();
});

it("awaits shared debugger stops and terminates their owning process only once", async () => {
  stopRun.mockClear();
  const calls: string[] = [];
  const first = debug(1, 1, {
    processId: 7,
    stop: vi.fn(async (options) => {
      await Promise.resolve();
      calls.push(options?.stopProcess === false ? "detach first" : "stop process first");
    }),
  });
  const last = debug(2, 2, {
    processId: 7,
    stop: vi.fn(async (options) => {
      calls.push(options?.stopProcess === false ? "detach last" : "stop process last");
    }),
  });
  const targets = serviceSessions([run("maven", 0)], [first, last]);
  await stopServiceSessions([...targets, ...targets]);
  expect(calls).toEqual(["detach first", "stop process last"]);
  expect(stopRun).not.toHaveBeenCalled();
});

it("stops all group executions including unpaired Run and ignores finished roots", async () => {
  stopRun.mockClear();
  const done = debug(3, 1, { status: "terminated" });
  const running = debug(4, 2);
  await stopServiceSessions(serviceSessions([run("plain", 1)], [done, running]));
  expect(stopRun).toHaveBeenCalledWith("plain");
  expect(running.stop).toHaveBeenCalledOnce();
  expect(done.stop).not.toHaveBeenCalled();
});
