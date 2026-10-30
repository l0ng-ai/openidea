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
import { adoptSession, publishContext, rerunSession, useDebug } from "../state";

const ipc = vi.hoisted(() => ({
  javaDebugServer: vi.fn(async () => ({ status: "ok", data: 5005 })),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugStop: vi.fn(async () => ({ status: "ok", data: null })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
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
