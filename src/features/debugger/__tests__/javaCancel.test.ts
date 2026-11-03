import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { provideNotificationService, useDebugRunSessions } from "@/workbench/contributions";
import type { RunConfig } from "@/platform/ipc";
import { registerDebugActions } from "../actions";
import { useDebug } from "../state";

const ipc = vi.hoisted(() => ({
  javaResolveLaunch: vi.fn(),
  cancelRequest: vi.fn(async () => undefined),
  javaDebugServer: vi.fn(async () => ({ status: "ok", data: 5005 })),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugStop: vi.fn(async () => ({ status: "ok", data: null })),
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
  module: "",
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
  const session = Object.values(useDebug.getState().sessions)[0]!;
  expect(session).toMatchObject({ name: "Main", status: "starting", runConfig: config });
  expect(
    useDebug
      .getState()
      .console[session.id]?.map((l) => l.text)
      .join("\n"),
  ).toContain("Building and resolving the classpath of Main…");
  expect(useDebugRunSessions.getState().sessions[0]?.configId).toBe(config.id);
  await executeAction("debug.stop");
  expect(ipc.cancelRequest).toHaveBeenCalledWith(ipc.javaResolveLaunch.mock.calls[0]![3]);
  expect(useDebug.getState().sessions[session.id]?.status).toBe("terminated");
  expect(useDebugRunSessions.getState().sessions).toEqual([]);
  return { starting };
}

function expectNoLaunch() {
  expect(ipc.javaDebugServer).not.toHaveBeenCalled();
  expect(ipc.debugStart).not.toHaveBeenCalled();
  expect(Object.values(useDebug.getState().sessions).every((s) => s.status === "terminated")).toBe(true);
  expect(notify).not.toHaveBeenCalled();
}

it("Stop cancels the resolve request and ends the preparation session without starting DAP", async () => {
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

it("still reports a real resolve failure in the preparation console", async () => {
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
  expect(
    Object.values(useDebug.getState().console)
      .flat()
      .map((line) => line.text)
      .join("\n"),
  ).toContain("Build failed");
  expect(ipc.debugStart).not.toHaveBeenCalled();
});

it.each([
  "jdtls: Given URI does not belong to any Java project.",
  "jdtls: Launch configuration 1793460461218 references non-existing project parent.",
])("explains how to import a module when Debug fails with %s", async (message) => {
  const starting = executeAction("debug.startConfig", { ...config, module: "web" });
  await vi.waitFor(() => expect(ipc.javaResolveLaunch).toHaveBeenCalledOnce());
  respond({ status: "error", error: { kind: "protocol", message } });
  await starting;
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Cannot start debugging",
      body: expect.stringContaining("Java module 'web' is not imported."),
    }),
  );
  expect(
    Object.values(useDebug.getState().console)
      .flat()
      .map((line) => line.text)
      .join("\n"),
  ).toContain("open its folder as a project");
  expect(ipc.javaDebugServer).not.toHaveBeenCalled();
  expect(ipc.debugStart).not.toHaveBeenCalled();
});

it("keeps progress and the originating configuration when DAP takes over", async () => {
  const starting = executeAction("debug.startConfig", config);
  await vi.waitFor(() => expect(ipc.javaResolveLaunch).toHaveBeenCalledOnce());
  respond({
    status: "ok",
    data: {
      build: "succeeded",
      errorCount: 0,
      errors: [],
      hints: [],
      classPaths: ["/p/target/classes"],
      modulePaths: [],
      pathListSeparator: ":",
      javaExec: "java",
    },
  });
  await starting;
  expect(Object.keys(useDebug.getState().sessions)).toEqual(["42"]);
  expect(useDebug.getState().sessions[42]).toMatchObject({ status: "running", runConfig: config });
  expect(
    useDebug
      .getState()
      .console[42]?.map((line) => line.text)
      .join("\n"),
  ).toContain("Building and resolving the classpath of Main…");
});

it.each(["success", "failure"])("handles a late DAP %s after preparation was cancelled", async (outcome) => {
  let fail!: (error: Error) => void;
  let finish!: (value: { status: "ok"; data: number }) => void;
  ipc.debugStart.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const starting = executeAction("debug.startConfig", config);
  await vi.waitFor(() => expect(ipc.javaResolveLaunch).toHaveBeenCalledOnce());
  respond({
    status: "ok",
    data: {
      build: "succeeded",
      errorCount: 0,
      errors: [],
      hints: [],
      classPaths: ["/p/target/classes"],
      modulePaths: [],
      pathListSeparator: ":",
      javaExec: "java",
    },
  });
  await vi.waitFor(() => expect(ipc.debugStart).toHaveBeenCalledOnce());
  await executeAction("debug.stop");
  if (outcome === "success") finish({ status: "ok", data: 42 });
  else fail(new Error("Adapter start failed"));
  await starting;
  if (outcome === "success") expect(ipc.debugStop).toHaveBeenCalledWith(42);
  expect(notify).not.toHaveBeenCalled();
  expect(useDebugRunSessions.getState().sessions).toEqual([]);
});
