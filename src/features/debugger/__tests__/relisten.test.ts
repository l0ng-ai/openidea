import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { LaunchConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { adoptSession, handleDebugEvent, startSession, useDebug } from "../state";

const ipc = vi.hoisted(() => ({
  debugStart: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const attach: LaunchConfig = {
  name: "AppKt",
  adapter: "kotlin-debug-adapter",
  request: "attach",
  program: null,
  args: [],
  cwd: "/p",
  env: {},
  extraJson: JSON.stringify({ hostName: "127.0.0.1", port: 35549 }),
};
const notify = vi.fn();

beforeEach(() => {
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useProject.setState({ project: { root: "/p" } as never });
  provideNotificationService({ notify });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
  vi.clearAllMocks();
  // The adapter's session announces itself, then the attach fails: the JVM is gone.
  ipc.debugStart.mockImplementation(async () => {
    handleDebugEvent(43, { kind: "started", name: "AppKt", adapter: "kotlin-debug-adapter", parent: null });
    return { status: "error", error: { kind: "internal", message: "attach failed: Internal error.", data: null } };
  });
});

/** A finished session that debugged a JVM of run 7. */
function finished(endedAgoMs: number) {
  adoptSession(1, { name: "AppKt", process: 7 });
  handleDebugEvent(1, { kind: "terminated" });
  useDebug.setState((s) => ({
    sessions: { ...s.sessions, 1: { ...s.sessions[1]!, endedAt: Date.now() - endedAgoMs } },
  }));
}

it("ignores a failed attach to the port a JVM announced as its debugger detached", async () => {
  finished(100);
  expect(await startSession(attach, { process: 7, rerunnable: false })).toBeNull();
  expect(notify).not.toHaveBeenCalled();
  const { sessions, active } = useDebug.getState();
  expect(Object.keys(sessions)).toEqual(["1"]);
  expect(active).toBe(1);
});

it("reports a failed attach to a JVM of another run, or long after the last session ended", async () => {
  finished(100);
  await startSession(attach, { process: 8, rerunnable: false });
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot start debugger for AppKt" }));

  notify.mockClear();
  useDebug.setState({ sessions: {}, active: null, console: {} });
  finished(60_000);
  await startSession(attach, { process: 7, rerunnable: false });
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot start debugger for AppKt" }));
  expect(useDebug.getState().sessions[1]).toBeUndefined();
});

it("replaces the finished session once an attach soon after it succeeds", async () => {
  finished(100);
  ipc.debugStart.mockResolvedValueOnce({ status: "ok", data: 44 });
  expect(await startSession(attach, { process: 7, rerunnable: false })).toBe(44);
  expect(Object.keys(useDebug.getState().sessions)).toEqual(["44"]);
  expect(notify).not.toHaveBeenCalled();
});
