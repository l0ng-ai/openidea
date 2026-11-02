import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JavaLaunchInfo, RunConfig } from "@/platform/ipc";

const ipc = vi.hoisted(() => ({
  javaResolveLaunch: vi.fn(),
  cancelRequest: vi.fn(async () => undefined),
  runStart: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { provideNotificationService } from "@/workbench/contributions";
import { resetRuns, runtime, startRun, stopSession, useRun } from "./store";

const config: RunConfig = {
  id: "application:Main",
  name: "Main",
  kind: "application",
  command: "java",
  args: ["-cp", "${classpath}", "Main"],
  cwd: null,
  module: "",
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
};
const info: JavaLaunchInfo = {
  build: "succeeded",
  projectRoot: "/p",
  classPaths: ["/p/target/classes"],
  modulePaths: [],
  pathListSeparator: ":",
  javaHome: null,
  javaExec: "java",
  shortenCommandLine: null,
  errors: [],
  errorCount: 0,
  hints: [],
};
const notify = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  provideNotificationService({ notify });
});
afterEach(() => {
  resetRuns();
  vi.restoreAllMocks();
});

describe("Stop during Java launch resolution", () => {
  it.each(["cancelled", "success"])("cancels the request and ignores a late %s response", async (response) => {
    type Result = Awaited<ReturnType<typeof import("@/platform/ipc").commands.javaResolveLaunch>>;
    let resolve!: (result: Result) => void;
    const pending = new Promise<Result>((done) => {
      resolve = done;
    });
    ipc.javaResolveLaunch.mockReturnValue(pending);
    const launch = startRun(config);
    await vi.waitFor(() => expect(ipc.javaResolveLaunch).toHaveBeenCalledOnce());
    const session = useRun.getState().sessions[0]!;
    expect(session.status).toBe("starting");
    const request = ipc.javaResolveLaunch.mock.calls[0]![3];
    expect(request).toEqual(expect.any(Number));
    await stopSession(session.id);
    expect(ipc.cancelRequest).toHaveBeenCalledExactlyOnceWith(request);
    expect(useRun.getState().sessions[0]?.status).toBe("finished");
    resolve(
      response === "cancelled"
        ? { status: "error", error: { kind: "cancelled", message: "request cancelled" } }
        : { status: "ok", data: info },
    );
    await launch;
    expect(ipc.runStart).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(runtime(session.id)!.console.lines.some((line) => line.kind === "stderr")).toBe(false);
    expect(useRun.getState().sessions[0]).toMatchObject({ stopped: true, status: "finished", runId: null });
    expect(runtime(session.id)!.resolveRequest).toBeUndefined();
  });
});

describe("Java run host separator", () => {
  it.each([
    { client: "Win32", separator: ":", paths: ["/p/classes", "/lib/a.jar"] },
    { client: "MacIntel", separator: ";", paths: ["C:\\p\\classes", "D:\\lib\\a.jar"] },
    { client: "MacIntel", separator: ":", paths: ["/p/classes", "/lib/a.jar"] },
  ])("uses $separator from the host on $client", async ({ client, separator, paths }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(client);
    ipc.javaResolveLaunch.mockResolvedValue({
      status: "ok",
      data: { ...info, classPaths: paths, modulePaths: paths, pathListSeparator: separator },
    });
    ipc.runStart.mockResolvedValue({ status: "ok", data: 42 });
    await startRun(config);
    expect(ipc.runStart.mock.calls[0]![0].args).toEqual([
      "--module-path",
      paths.join(separator),
      "-cp",
      paths.join(separator),
      "Main",
    ]);
  });
});
