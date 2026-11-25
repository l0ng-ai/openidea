import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addBreakpoint,
  flushBreakpoints,
  loadBreakpoints,
  removeAllBreakpoints,
  useBreakpoints,
} from "../breakpoints/store";
import {
  handleDebugEvent,
  pinSession,
  rerunSession,
  startPreparedSession,
  startSession,
  tabOrderOf,
  useDebug,
} from "../state";
import type { LaunchConfig, RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";

const ipc = vi.hoisted(() => ({
  debugSetBreakpoints: vi.fn(),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugStop: vi.fn(async () => ({ status: "ok", data: null })),
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
const runConfig = (id: string): RunConfig =>
  ({ id, name: "Same", kind: "shell", command: "true", args: [], cwd: null, env: {} }) as unknown as RunConfig;
const tabIds = () =>
  Object.values(useDebug.getState().sessions)
    .sort((a, b) => tabOrderOf(a) - tabOrderOf(b) || a.id - b.id)
    .map((s) => s.id);
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
  "reveals an in-place session in Services on suspend (%s)",
  async (reason) => {
    const show = vi.fn();
    provideToolWindowService({ show } as unknown as ToolWindowService);
    await startSession(config("launch"), { show: false });
    expect(show).not.toHaveBeenCalled();
    handleDebugEvent(42, { kind: "stopped", threadId: 1, reason, description: null, allThreadsStopped: true });
    // Services shows the session's debugger in place (#4773).
    expect(show).toHaveBeenCalledExactlyOnceWith("services");
    expect(useDebug.getState().active).toBe(42);
    expect(useDebug.getState().sessions[42]).toMatchObject({ status: "paused", selectedThread: 1 });
  },
);

it("reveals a session started elsewhere in the Debug tool window on suspend", async () => {
  const show = vi.fn();
  provideToolWindowService({ show } as unknown as ToolWindowService);
  await startSession(config("launch"));
  show.mockClear();
  handleDebugEvent(42, {
    kind: "stopped",
    threadId: 1,
    reason: "breakpoint",
    description: null,
    allThreadsStopped: true,
  });
  expect(show).toHaveBeenCalledExactlyOnceWith("debug");
});

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
  expect(tabIds().map((id) => useDebug.getState().sessions[id]!.name)).toEqual(["Server", "Client"]);

  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 4 });
  const started = startPreparedSession({ id: "other", name: "Other" } as never, async () => ({
    ...config("launch"),
    name: "Other",
  }));
  // No finished tab named "Other": the first finished one (Client) gives way.
  expect(tabIds().map((id) => useDebug.getState().sessions[id]!.name)).toEqual(["Server", "Other"]);
  await started;
  expect(tabIds().map((id) => useDebug.getState().sessions[id]!.name)).toEqual(["Server", "Other"]);
});

it("keeps a pinned finished tab; Rerun on it takes its place and keeps it pinned", async () => {
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 1 });
  await startSession({ ...config("launch"), name: "Server" });
  pinSession(1, true);
  handleDebugEvent(1, { kind: "terminated" });
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 2 });
  await startSession({ ...config("launch"), name: "Server" });
  const tabs = () =>
    tabIds().map((id) => {
      const s = useDebug.getState().sessions[id]!;
      return [s.id, s.status, !!s.pinned];
    });
  expect(tabs()).toEqual([
    [1, "terminated", true],
    [2, "running", false],
  ]);

  handleDebugEvent(2, { kind: "terminated" });
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 3 });
  await rerunSession(1);
  expect(tabs()).toEqual([
    [3, "running", true],
    [2, "terminated", false],
  ]);
});

it("keeps the reused slot while a prepared start builds", async () => {
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 1 }).mockResolvedValueOnce({ status: "ok", data: 2 });
  await startSession({ ...config("launch"), name: "Server" });
  await startSession({ ...config("launch"), name: "Client" });
  handleDebugEvent(2, { kind: "terminated" });

  let finishBuild!: () => void;
  const build = new Promise<void>((resolve) => (finishBuild = resolve));
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 3 });
  const started = startPreparedSession({ id: "client", name: "Client" } as never, async () => {
    await build;
    return { ...config("launch"), name: "Client" };
  });
  expect(tabIds().map((id) => useDebug.getState().sessions[id]!.name)).toEqual(["Server", "Client"]);

  finishBuild();
  await expect(started).resolves.toBe(3);
  expect(tabIds()).toEqual([1, 3]);
});

it("keeps a live tab in place when Rerun stops and replaces it", async () => {
  ipc.debugStart
    .mockResolvedValueOnce({ status: "ok", data: 1 })
    .mockResolvedValueOnce({ status: "ok", data: 2 })
    .mockResolvedValueOnce({ status: "ok", data: 3 })
    .mockResolvedValueOnce({ status: "ok", data: 4 });
  await startSession({ ...config("launch"), name: "First" });
  await startSession({ ...config("launch"), name: "Second" });
  await startSession({ ...config("launch"), name: "Third" });

  await rerunSession(2);
  expect(tabIds()).toEqual([1, 4, 3]);
});

it("prefers the same configuration over another selected tab with the same name", async () => {
  ipc.debugStart
    .mockResolvedValueOnce({ status: "ok", data: 1 })
    .mockResolvedValueOnce({ status: "ok", data: 2 })
    .mockResolvedValueOnce({ status: "ok", data: 3 });
  await startSession({ ...config("launch"), name: "Same" }, { runConfig: runConfig("a") });
  await startSession({ ...config("launch"), name: "Same" }, { runConfig: runConfig("b") });
  handleDebugEvent(1, { kind: "terminated" });
  handleDebugEvent(2, { kind: "terminated" });
  useDebug.setState({ active: 1 });

  await startSession({ ...config("launch"), name: "Same" }, { runConfig: runConfig("b") });
  expect(tabIds()).toEqual([1, 3]);
  expect(useDebug.getState().sessions[3]?.runConfig?.id).toBe("b");
});

it("keeps a rerun tab in place and selected while its adapter starts", async () => {
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 1 }).mockResolvedValueOnce({ status: "ok", data: 2 });
  await startSession({ ...config("launch"), name: "main.c" });
  await startSession({ ...config("launch"), name: "layout.c" });
  useDebug.setState({ active: 1 });

  let respond!: (r: { status: "ok"; data: number }) => void;
  ipc.debugStart.mockImplementationOnce(() => new Promise((resolve) => (respond = resolve)) as never);
  const rerun = rerunSession(1);
  await vi.advanceTimersByTimeAsync(0);
  handleDebugEvent(1, { kind: "terminated" });
  // Stopped, the old tab still holds its place and the selection.
  expect(tabIds()).toEqual([1, 2]);
  expect(useDebug.getState().active).toBe(1);

  // The adapter announces the new session before `debugStart` returns: it takes the tab at once.
  handleDebugEvent(3, { kind: "started", name: "main.c", adapter: "lldb", parent: null } as never);
  expect(tabIds()).toEqual([3, 2]);
  expect(useDebug.getState().active).toBe(3);

  respond({ status: "ok", data: 3 });
  await rerun;
  expect(tabIds()).toEqual([3, 2]);
  expect(useDebug.getState().active).toBe(3);
});
