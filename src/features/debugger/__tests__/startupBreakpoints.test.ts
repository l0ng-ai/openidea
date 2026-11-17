import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addBreakpoint,
  flushBreakpoints,
  loadBreakpoints,
  removeAllBreakpoints,
  useBreakpoints,
} from "../breakpoints/store";
import { handleDebugEvent, pinSession, rerunSession, startPreparedSession, startSession, useDebug } from "../state";
import type { LaunchConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";

const ipc = vi.hoisted(() => ({
  debugSetBreakpoints: vi.fn(),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugCapabilities: vi.fn(async () => ({ status: "ok", data: {} })),
  debugExceptionFilters: vi.fn(async () => ({ status: "ok", data: [] })),
  debugThreads: vi.fn(async () => ({ status: "ok", data: [] })),
  debugStackTrace: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const config = (request: string): LaunchConfig => ({
  name: "Java",
  adapter: "java-debug",
  request,
  program: null,
  args: [],
  cwd: null,
  env: {},
  extraJson: null,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  useBreakpoints.setState({ root: "/p", byFile: {}, muted: false, status: {} });
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useProject.setState({ settings: null });
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
});
afterEach(() => vi.useRealTimers());

it.each([undefined, true, false])(
  "respects showOnStart for direct and prepared starts (show: %s)",
  async (foreground) => {
    for (const showOnStart of [true, false]) {
      useProject.setState({ settings: { run: { showOnStart } } as never });
      for (const prepared of [false, true]) {
        const show = vi.fn();
        provideToolWindowService({ show } as unknown as ToolWindowService);
        if (prepared) {
          await startPreparedSession({ id: "java", name: "Java" } as never, async () => config("launch"), {
            show: foreground,
          });
        } else await startSession(config("launch"), { show: foreground });
        if (showOnStart && foreground !== false) expect(show).toHaveBeenCalledWith("debug");
        else expect(show).not.toHaveBeenCalled();
      }
    }
  },
);

it.each(["breakpoint", "function breakpoint", "exception", "pause"])(
  "reveals an in-place session on suspend (%s)",
  async (reason) => {
    const show = vi.fn();
    provideToolWindowService({ show } as unknown as ToolWindowService);
    await startSession(config("launch"), { show: false });
    expect(show).not.toHaveBeenCalled();
    handleDebugEvent(42, { kind: "stopped", threadId: 1, reason, description: null, allThreadsStopped: true });
    expect(show).toHaveBeenCalledWith("debug");
    expect(useDebug.getState().active).toBe(42);
    expect(useDebug.getState().sessions[42]).toMatchObject({ status: "paused", selectedThread: 1 });
  },
);

it.each(["launch", "attach"])("awaits every file before %s can send configurationDone", async (request) => {
  const completed: string[] = [];
  const release: Array<() => void> = [];
  ipc.debugSetBreakpoints.mockImplementation(
    (path: string) =>
      new Promise((resolve) => {
        release.push(() => {
          completed.push(path);
          resolve({ status: "ok", data: [] });
        });
      }),
  );
  addBreakpoint("/p/Main.java", 4);
  addBreakpoint("/p/Other.java", 7);
  const starting = startSession(config(request));
  await vi.advanceTimersByTimeAsync(0);
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledTimes(2);
  expect(ipc.debugStart).not.toHaveBeenCalled();
  release[0]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(ipc.debugStart).not.toHaveBeenCalled();
  release[1]!();
  await starting;
  expect(completed).toEqual(["/p/Main.java", "/p/Other.java"]);
  expect(ipc.debugStart).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(120);
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledTimes(2);
});

it("drains an in-flight update and sends pending removals before startup", async () => {
  let release!: () => void;
  ipc.debugSetBreakpoints
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "ok", data: [] });
        }),
    )
    .mockResolvedValue({ status: "ok", data: [] });
  addBreakpoint("/p/Main.java", 4);
  await vi.advanceTimersByTimeAsync(120);
  removeAllBreakpoints();
  const starting = startSession(config("launch"));
  await vi.advanceTimersByTimeAsync(0);
  expect(ipc.debugStart).not.toHaveBeenCalled();
  release();
  await starting;
  expect(ipc.debugSetBreakpoints).toHaveBeenLastCalledWith("/p/Main.java", []);
  expect(ipc.debugStart).toHaveBeenCalledOnce();
});

it("flushes persisted breakpoints immediately after project loading", async () => {
  ipc.debugSetBreakpoints.mockResolvedValue({ status: "ok", data: [] });
  localStorage.setItem(
    "openidea.debugger.breakpoints:/p",
    JSON.stringify({ files: { "/p/Main.java": [{ line: 4 }] } }),
  );
  loadBreakpoints("/p");
  await startSession(config("launch"));
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledOnce();
  expect(ipc.debugSetBreakpoints.mock.invocationCallOrder[0]).toBeLessThan(ipc.debugStart.mock.invocationCallOrder[0]!);
});

it("flushes edits made while another file is still syncing", async () => {
  let release!: () => void;
  ipc.debugSetBreakpoints
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "ok", data: [] });
        }),
    )
    .mockResolvedValue({ status: "ok", data: [] });
  addBreakpoint("/p/Main.java", 4);
  const starting = startSession(config("launch"));
  await vi.advanceTimersByTimeAsync(0);
  addBreakpoint("/p/Other.java", 7);
  release();
  await starting;
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledTimes(2);
  expect(ipc.debugSetBreakpoints.mock.calls[1]![0]).toBe("/p/Other.java");
  expect(ipc.debugSetBreakpoints.mock.invocationCallOrder[1]).toBeLessThan(ipc.debugStart.mock.invocationCallOrder[0]!);
});

it("does not start if the initial breakpoint sync fails", async () => {
  ipc.debugSetBreakpoints.mockRejectedValueOnce(new Error("breakpoint sync failed"));
  addBreakpoint("/p/Main.java", 4);
  expect(await startSession(config("launch"))).toBeNull();
  expect(ipc.debugStart).not.toHaveBeenCalled();
});

it.each(["launch", "attach"])("shares the breakpoint drain between concurrent %s starts", async (request) => {
  let release!: () => void;
  ipc.debugSetBreakpoints.mockImplementation(() => {
    // Bound the broken loop so a regression fails instead of hanging the test runner.
    if (ipc.debugSetBreakpoints.mock.calls.length > 8) throw new Error("breakpoint flush did not settle");
    if (ipc.debugSetBreakpoints.mock.calls.length === 1)
      return new Promise((resolve) => {
        release = () => resolve({ status: "ok", data: [] });
      });
    return Promise.resolve({ status: "ok", data: [] });
  });
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 42 }).mockResolvedValueOnce({ status: "ok", data: 43 });
  addBreakpoint("/p/Main.java", 4);
  const starting = Promise.all([startSession(config(request)), startSession(config(request))]);
  await vi.advanceTimersByTimeAsync(0);
  expect(ipc.debugStart).not.toHaveBeenCalled();
  addBreakpoint("/p/Main.java", 7);
  release();
  expect(await starting).toEqual([42, 43]);
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledTimes(2);
  expect(ipc.debugSetBreakpoints.mock.calls[1]![1]).toMatchObject([{ line: 4 }, { line: 7 }]);
  await vi.advanceTimersByTimeAsync(120);
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledTimes(2);
});

it("does not resend unchanged breakpoints for concurrent flushes", async () => {
  ipc.debugSetBreakpoints.mockImplementation(async () => {
    if (ipc.debugSetBreakpoints.mock.calls.length > 8) throw new Error("breakpoint flush did not settle");
    return { status: "ok", data: [] };
  });
  addBreakpoint("/p/Main.java", 4);
  await Promise.all([flushBreakpoints(), flushBreakpoints(), flushBreakpoints()]);
  expect(ipc.debugSetBreakpoints).toHaveBeenCalledOnce();
});

it("releases a failed shared drain so a later start can retry", async () => {
  ipc.debugSetBreakpoints.mockRejectedValueOnce(new Error("breakpoint sync failed"));
  addBreakpoint("/p/Main.java", 4);
  expect(await Promise.all([startSession(config("launch")), startSession(config("attach"))])).toEqual([null, null]);
  expect(ipc.debugStart).not.toHaveBeenCalled();
  ipc.debugSetBreakpoints.mockResolvedValue({ status: "ok", data: [] });
  expect(await startSession(config("launch"))).toBe(42);
  expect(ipc.debugStart).toHaveBeenCalledOnce();
});

it("replaces finished tabs as soon as a prepared start begins", async () => {
  await startSession(config("launch"));
  handleDebugEvent(42, { kind: "terminated" });
  expect(useDebug.getState().sessions[42]?.status).toBe("terminated");
  let finishBuild!: () => void;
  const build = new Promise<void>((resolve) => (finishBuild = resolve));
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 43 });
  const started = startPreparedSession({ id: "java", name: "Java" } as never, async () => {
    await build;
    return config("launch");
  });
  const preparing = Object.values(useDebug.getState().sessions);
  expect(preparing).toHaveLength(1);
  expect(preparing[0]).toMatchObject({ name: "Java", status: "starting" });
  finishBuild();
  await expect(started).resolves.toBe(43);
  expect(Object.keys(useDebug.getState().sessions)).toEqual(["43"]);
});

it("replaces only the finished tab of the same name; other finished tabs stay", async () => {
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 1 }).mockResolvedValueOnce({ status: "ok", data: 2 });
  await startSession({ ...config("launch"), name: "Server" });
  await startSession({ ...config("launch"), name: "Client" });
  handleDebugEvent(1, { kind: "terminated" });
  handleDebugEvent(2, { kind: "terminated" });
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 3 });
  await startSession({ ...config("launch"), name: "Server" });
  expect(Object.values(useDebug.getState().sessions).map((s) => [s.name, s.status])).toEqual([
    ["Client", "terminated"],
    ["Server", "running"],
  ]);

  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 4 });
  const started = startPreparedSession({ id: "other", name: "Other" } as never, async () => ({
    ...config("launch"),
    name: "Other",
  }));
  // No finished tab named "Other": the first finished one (Client) gives way.
  expect(Object.values(useDebug.getState().sessions).map((s) => s.name)).toEqual(["Server", "Other"]);
  await started;
  expect(Object.values(useDebug.getState().sessions).map((s) => s.name)).toEqual(["Server", "Other"]);
});

it("keeps a pinned finished tab; Rerun on it takes its place and keeps it pinned", async () => {
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 1 });
  await startSession({ ...config("launch"), name: "Server" });
  pinSession(1, true);
  handleDebugEvent(1, { kind: "terminated" });
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 2 });
  await startSession({ ...config("launch"), name: "Server" });
  const tabs = () => Object.values(useDebug.getState().sessions).map((s) => [s.id, s.status, !!s.pinned]);
  expect(tabs()).toEqual([
    [1, "terminated", true],
    [2, "running", false],
  ]);

  handleDebugEvent(2, { kind: "terminated" });
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 3 });
  await rerunSession(1);
  expect(tabs()).toEqual([
    [2, "terminated", false],
    [3, "running", true],
  ]);
});
