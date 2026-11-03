import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addBreakpoint, loadBreakpoints, removeAllBreakpoints, useBreakpoints } from "../breakpoints/store";
import { startSession, useDebug } from "../state";
import type { LaunchConfig } from "@/platform/ipc";
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
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
});
afterEach(() => vi.useRealTimers());

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
