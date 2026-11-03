import { expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import type { DebugServiceSession } from "@/workbench/contributions";
import type { RunSession } from "./store";
import { currentServiceSession, serviceDebugger, serviceSessions, stopServiceSessions } from "./serviceSessions";

const { stopRun, waitForExit, getSession } = vi.hoisted(() => ({
  stopRun: vi.fn(),
  waitForExit: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("./store", () => ({
  stopSession: stopRun,
  waitForExit,
  useRun: { getState: () => ({ sessions: [getSession()].filter(Boolean) }) },
}));
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

it("awaits shared debugger stops without a retained Run and terminates their process only once", async () => {
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
  const targets = serviceSessions([], [first, last]);
  await stopServiceSessions([...targets, ...targets]);
  expect(calls).toEqual(["detach first", "stop process last"]);
  expect(stopRun).not.toHaveBeenCalled();
});

it("stops the owning Run before detaching shared roots so JDWP cannot trigger another attachment", async () => {
  stopRun.mockClear();
  let processAlive = true;
  let reattachments = 0;
  const calls: string[] = [];
  stopRun.mockImplementationOnce(async () => {
    calls.push("stop run");
  });
  let exit!: () => void;
  waitForExit.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        exit = () => {
          processAlive = false;
          resolve();
        };
      }),
  );
  getSession.mockImplementationOnce(() => run("maven", 0, { status: "finished" }));
  const roots = [1, 2].map((id) =>
    debug(id, id, {
      processId: 7,
      stop: vi.fn(async () => {
        await Promise.resolve();
        if (processAlive) reattachments++;
        calls.push(`detach ${id}`);
      }),
    }),
  );
  const targets = serviceSessions([run("maven", 0)], roots);
  const stopping = stopServiceSessions([...targets, ...targets]);
  await vi.waitFor(() => expect(stopRun).toHaveBeenCalledOnce());
  for (const root of roots) expect(root.stop).not.toHaveBeenCalled();
  exit();
  await stopping;
  expect(reattachments).toBe(0);
  expect(calls).toEqual(["stop run", "detach 1", "detach 2"]);
  expect(stopRun).toHaveBeenCalledExactlyOnceWith("maven");
  for (const root of roots) expect(root.stop).toHaveBeenCalledExactlyOnceWith({ stopProcess: false });
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

it("does not detach a JVM still running after the exit wait expires", async () => {
  getSession.mockReturnValueOnce(run("maven", 0));
  const root = debug(1, 1, { processId: 7 });
  await stopServiceSessions(serviceSessions([run("maven", 0)], [root]));
  expect(root.stop).not.toHaveBeenCalled();
});
