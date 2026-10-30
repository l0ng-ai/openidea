import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import type { RunConfig } from "@/platform/ipc";
import { registerDebugActions } from "../actions";
import { useDebug } from "../state";

const ipc = vi.hoisted(() => ({
  javaResolveLaunch: vi.fn(),
  cancelRequest: vi.fn(async () => undefined),
  javaDebugServer: vi.fn(async () => ({ status: "ok", data: 5005 })),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  fsReadDir: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const notify = vi.fn();
const expire = vi.fn();
const config: RunConfig = {
  id: "application:Main",
  name: "Main",
  kind: "application",
  command: "java",
  args: ["-cp", "${classpath}", "Main"],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "java-debug",
};
let dispose: () => void;
let respond: (result: unknown) => void;
beforeEach(() => {
  vi.clearAllMocks();
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useProject.setState({ project: { root: "/p" } as never });
  provideNotificationService({ notify, expire });
  ipc.javaResolveLaunch.mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  dispose = registerDebugActions();
});
afterEach(() => dispose());

async function startAndStop() {
  const starting = executeAction("debug.startConfig", config);
  await vi.waitFor(() => expect(ipc.javaResolveLaunch).toHaveBeenCalledOnce());
  const notification = notify.mock.calls[0]![0];
  expect(notification).toMatchObject({ sticky: true, title: "Starting debugger for Main…" });
  expect(notification.actions[0].label).toBe("Stop");
  notification.actions[0].run();
  expect(ipc.cancelRequest).toHaveBeenCalledWith(ipc.javaResolveLaunch.mock.calls[0]![3]);
  expect(expire).toHaveBeenCalledWith(notification.key);
  return { starting };
}

function expectNoLaunch() {
  expect(ipc.javaDebugServer).not.toHaveBeenCalled();
  expect(ipc.debugStart).not.toHaveBeenCalled();
  expect(useDebug.getState().sessions).toEqual({});
  expect(notify).toHaveBeenCalledTimes(1);
}

it("Stop cancels the resolve request and ends silently without starting a session", async () => {
  const { starting } = await startAndStop();
  respond({ status: "error", error: { kind: "cancelled", message: "Cancelled" } });
  await starting;
  expectNoLaunch();
});

it("ignores a successful resolve arriving after Stop, including compile warnings", async () => {
  const { starting } = await startAndStop();
  respond({ status: "ok", data: { errorCount: 1 } });
  await starting;
  expectNoLaunch();
});

it("ignores a failed resolve arriving after Stop", async () => {
  const { starting } = await startAndStop();
  respond({ status: "error", error: { kind: "internal", message: "Build failed" } });
  await starting;
  expectNoLaunch();
});

it("still reports a real resolve failure and removes the starting notification", async () => {
  const starting = executeAction("debug.startConfig", config);
  await vi.waitFor(() => expect(ipc.javaResolveLaunch).toHaveBeenCalledOnce());
  respond({ status: "error", error: { kind: "internal", message: "Build failed" } });
  await starting;
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "error",
      title: "Cannot start debugging",
      body: "Build failed",
    }),
  );
  expect(expire).toHaveBeenCalledWith(notify.mock.calls[0]![0].key);
  expect(ipc.debugStart).not.toHaveBeenCalled();
});
