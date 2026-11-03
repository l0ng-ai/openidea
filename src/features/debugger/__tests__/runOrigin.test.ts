import { beforeEach, expect, it, vi } from "vitest";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  provideNotificationService,
  provideToolWindowService,
  useDebugRunSessions,
  type ToolWindowService,
} from "@/workbench/contributions";
import type { RunConfig } from "@/platform/ipc";
import { registerDebugActions } from "../actions";
import {
  adoptSession,
  appendConsole,
  handleDebugEvent,
  publishContext,
  rerunSession,
  resetSessions,
  startSession,
  stopSession,
  useDebug,
} from "../state";

const ipc = vi.hoisted(() => ({
  javaDebugServer: vi.fn(async () => ({ status: "ok", data: 5005 })),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugStop: vi.fn(async () => ({ status: "ok", data: null })),
  runStop: vi.fn(async () => ({ status: "ok", data: null })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

it("retains only configured debug roots for Services without changing live toolbar sessions", () => {
  adoptSession(1, { runConfig: config, process: 7, startedAt: 10 });
  adoptSession(2, { parent: 1, status: "paused" });
  adoptSession(3);
  publishContext();
  expect(useDebugRunSessions.getState().serviceSessions).toMatchObject([
    { id: 1, config, processId: 7, startedAt: 10, status: "paused" },
  ]);
  handleDebugEvent(1, { kind: "terminated" });
  expect(useDebugRunSessions.getState().sessions.map((s) => s.id)).toEqual([3]);
  expect(useDebugRunSessions.getState().serviceSessions).toMatchObject([{ id: 1, status: "terminated" }]);
});

it("does not republish service metadata when console output changes", () => {
  adoptSession(1, { runConfig: config });
  const summaries = useDebugRunSessions.getState().serviceSessions;
  expect(summaries).toHaveLength(1);
  appendConsole(1, "stdout", "application output\n");
  expect(useDebugRunSessions.getState().serviceSessions).toBe(summaries);
});

it("stops shared-process debugger roots without stopping their process until requested", async () => {
  adoptSession(1, { runConfig: config, process: 7 });
  await stopSession(1, { stopProcess: false });
  expect(ipc.debugStop).toHaveBeenCalledWith(1);
  expect(ipc.runStop).not.toHaveBeenCalled();
  await stopSession(1);
  expect(ipc.runStop).toHaveBeenCalledWith(7);
});

it("pins Show in Debug to the configured session and clears summaries with the project", () => {
  adoptSession(1, { runConfig: config });
  adoptSession(2, { runConfig: { ...config, id: "other" } });
  const summary = useDebugRunSessions.getState().serviceSessions[0]!;
  summary.show();
  expect(useDebug.getState().active).toBe(1);
  resetSessions();
  expect(useDebugRunSessions.getState().serviceSessions).toEqual([]);
  summary.show();
  expect(useDebug.getState().active).toBeNull();
});

it("removes terminated summaries when a subsequent debug start prunes their source", async () => {
  adoptSession(1, { runConfig: config });
  handleDebugEvent(1, { kind: "terminated" });
  await startSession(
    {
      name: "next",
      adapter: "js-debug",
      request: "launch",
      program: null,
      args: [],
      cwd: "/p",
      env: {},
      extraJson: null,
    },
    { runConfig: { ...config, id: "next" } },
  );
  expect(useDebugRunSessions.getState().serviceSessions.map((s) => s.id)).toEqual([42]);
});
const config: RunConfig = {
  id: "node:server",
  name: "server",
  kind: "node",
  command: "node",
  args: ["server.js"],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "js-debug",
};
beforeEach(() => {
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useDebugRunSessions.setState({ sessions: [] });
  useProject.setState({ project: { root: "/p" } as never });
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
  vi.clearAllMocks();
});

it("keeps the RunConfig through debug.startConfig and reruns through its debug preparation", async () => {
  const dispose = registerDebugActions();
  const restart = vi.fn();
  const unregister = registerActions([{ id: "run.debugConfig", title: "Debug", run: ({ arg }) => restart(arg) }]);
  try {
    await executeAction("debug.startConfig", config);
    const session = useDebug.getState().sessions[42]!;
    expect(session.runConfig).toEqual(config);
    expect(session.startedAt).toBeGreaterThan(0);
    expect(useDebugRunSessions.getState().sessions[0]?.configId).toBe(config.id);
    await rerunSession(42);
    expect(ipc.debugStop).toHaveBeenCalledWith(42);
    expect(restart).toHaveBeenCalledWith(config);
  } finally {
    dispose();
    unregister();
  }
});

it("preserves the source configuration for a separately built debug binary", async () => {
  const dispose = registerDebugActions();
  try {
    await executeAction("debug.startConfig", { config, origin: { ...config, id: "source:server" } });
    expect(useDebug.getState().sessions[42]?.runConfig?.id).toBe("source:server");
  } finally {
    dispose();
  }
});

it("keeps the originating JVM configuration when attaching to its build process", async () => {
  const dispose = registerDebugActions();
  try {
    await executeAction("debug.attach", {
      name: "server",
      module: "",
      hostName: "127.0.0.1",
      port: 5005,
      process: 7,
      runConfig: config,
    });
    expect(useDebug.getState().sessions[42]).toMatchObject({ runConfig: config, process: 7, launch: null });
    expect(useDebugRunSessions.getState().sessions[0]?.rerun).toBeTypeOf("function");
  } finally {
    dispose();
  }
});

it("exposes a paused child through its originating root rather than the active unrelated session", () => {
  adoptSession(1, { runConfig: config });
  adoptSession(2, { parent: 1, status: "paused", stoppedThread: 1 });
  adoptSession(3, { runConfig: { ...config, id: "other" } });
  useDebug.setState({ active: 3 });
  publishContext();
  const roots = useDebugRunSessions.getState().sessions;
  expect(roots.map((s) => [s.configId, s.paused])).toEqual([
    [config.id, true],
    ["other", false],
  ]);
  roots[0]!.resume();
  expect(useDebug.getState().active).toBe(2);
});
