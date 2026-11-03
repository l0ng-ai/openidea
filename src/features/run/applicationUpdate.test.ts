import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSession } from "./store";
const mocks = vi.hoisted(() => ({
  action: vi.fn(async () => true),
  build: vi.fn(async () => {}),
  update: vi.fn(async () => ({ status: "ok", data: null })),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  wait: vi.fn(async () => {}),
  debug: true,
  notify: vi.fn(),
  menu: vi.fn(),
  springBuild: vi.fn(async () => ({ status: "ok", data: { id: "build" } })),
  publish: vi.fn(async () => ({ status: "ok", data: null })),
  resolve: vi.fn(async () => ({
    status: "ok",
    data: { build: "succeeded", classPaths: ["/p/app/bin/main"], pathListSeparator: ":" },
  })),
  runBuild: vi.fn(async () => {}),
  state: { configs: [] as RunSession["config"][], sessions: [] as RunSession[], activeSession: null as string | null },
}));
vi.mock("@/platform/actions", () => ({ executeAction: mocks.action, getAction: () => ({}) }));
vi.mock("@/platform/ipc", () => ({
  call: async (p: Promise<{ data: unknown }>) => (await p).data,
  isTauri: () => false,
  nextRequestId: () => 1,
  commands: {
    runTomcatUpdate: mocks.update,
    runApplicationBuild: mocks.springBuild,
    runApplicationPublish: mocks.publish,
    javaResolveLaunch: mocks.resolve,
  },
}));
vi.mock("@/workbench/contributions", () => ({
  maybeEditorService: () => ({ saveAll: async () => {} }),
  notifications: () => ({ notify: mocks.notify }),
  useDebugRunSessions: {
    getState: () => ({
      sessions: mocks.debug ? [{ configId: "tomcat:one" }, { configId: "boot" }] : [],
      serviceSessions: [],
    }),
  },
}));
vi.mock("@/ui", () => ({ showContextMenu: mocks.menu }));
vi.mock("@/platform/javaLaunch", async (original) => ({
  ...(await original<typeof import("@/platform/javaLaunch")>()),
  resolveJavaModule: async () => "app",
}));
vi.mock("./buildUpdate", () => ({ runUpdateBuild: mocks.runBuild }));
vi.mock("./tomcat", () => ({ buildTomcatArtifact: mocks.build }));
vi.mock("./store", () => ({
  startRun: mocks.start,
  stopSession: mocks.stop,
  waitForExit: mocks.wait,
  useRun: { setState: vi.fn(), getState: () => mocks.state },
}));
import {
  updateApplication as updateTomcat,
  showApplicationUpdate,
  updateOnDeactivation,
  updatableSessions,
  useApplicationUpdates,
} from "./applicationUpdate";
const session = { id: "run1", config: { id: "tomcat:one", kind: "tomcat" } } as RunSession;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.debug = true;
  mocks.action.mockResolvedValue(true);
  mocks.state.configs = [];
  mocks.state.sessions = [];
  mocks.state.activeSession = null;
  useApplicationUpdates.setState({ ids: new Set() });
});
describe("Tomcat application updates", () => {
  it("builds and copies the deployment before requesting scoped HotSwap", async () => {
    await updateTomcat(session, "classes");
    expect(mocks.build).toHaveBeenCalledWith(session.config);
    expect(mocks.update).toHaveBeenCalledWith(session.config, "classes");
    expect(mocks.action).toHaveBeenCalledWith("debug.reloadChangedClasses", { configId: "tomcat:one" });
    expect(mocks.build.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.action.mock.invocationCallOrder[0]!);
  });
  it("does not replace classes when updating only resources", async () => {
    await updateTomcat(session, "resources");
    expect(mocks.update).toHaveBeenCalledWith(session.config, "resources");
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("waits for clean shutdown before restarting a debug server", async () => {
    await updateTomcat(session, "restart");
    expect(mocks.stop).toHaveBeenCalledWith("run1");
    expect(mocks.wait).toHaveBeenCalledWith(["run1"]);
    expect(mocks.wait.mock.invocationCallOrder[0]).toBeLessThan(mocks.action.mock.invocationCallOrder[0]!);
    expect(mocks.action).toHaveBeenCalledWith("run.debugConfig", session.config);
  });
  it("redeploys when the debugger cannot perform HotSwap", async () => {
    mocks.action.mockResolvedValue(false);
    await updateTomcat(session, "classes");
    expect(mocks.update).toHaveBeenLastCalledWith(session.config, "redeploy");
  });
});

const boot = {
  id: "boot1",
  status: "running",
  config: { id: "boot", kind: "spring-boot", args: ["-cp", "${classpath}", "a.Main"] },
} as RunSession;
describe("Spring Boot application updates", () => {
  it("processes resources and publishes them to the resolved runtime output", async () => {
    await updateTomcat(boot, "resources");
    expect(mocks.resolve).toHaveBeenCalledWith("app", false, false, 1);
    expect(mocks.runBuild).toHaveBeenCalledWith({ id: "build" });
    expect(mocks.publish).toHaveBeenCalledWith(boot.config, ["/p/app/bin/main"], "a.Main");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("compiles and invokes the existing scoped HotSwap action in debug", async () => {
    await updateTomcat(boot, "classes");
    expect(mocks.resolve).toHaveBeenCalledWith("app", false, true, 1);
    expect(mocks.action).toHaveBeenCalledWith("debug.reloadChangedClasses", { configId: "boot" });
  });
  it("explains compiled classes require restart without a debugger", async () => {
    mocks.debug = false;
    await updateTomcat(boot, "classes");
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Restart the application") }),
    );
  });
  it("explains the restart requirement if the attached debugger cannot dispatch HotSwap", async () => {
    mocks.action.mockResolvedValueOnce(false);
    await updateTomcat(boot, "classes");
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Restart the application") }),
    );
  });
  it("never publishes resources after a failed build", async () => {
    mocks.runBuild.mockRejectedValueOnce(new Error("failed"));
    await updateTomcat(boot, "resources");
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
  });
  it("does not overlap updates of a session", async () => {
    let finish!: () => void;
    mocks.runBuild.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = updateTomcat(boot, "resources");
    await vi.waitFor(() => expect(mocks.runBuild).toHaveBeenCalled());
    await updateTomcat(boot, "resources");
    expect(mocks.runBuild).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(useApplicationUpdates.getState().ids.size).toBe(0);
  });
  it("retains the chooser by default and never offers redeploy", () => {
    mocks.state.sessions = [boot];
    showApplicationUpdate();
    const items = mocks.menu.mock.calls[0]![1];
    expect(items.map((i: { label: string }) => i.label)).toEqual([
      "Update Application",
      "Update resources",
      "Update classes and resources",
      "Restart",
    ]);
  });
  it("uses current saved policies and defaults deactivation to doing nothing", async () => {
    mocks.state.sessions = [boot];
    updateOnDeactivation();
    expect(mocks.resolve).not.toHaveBeenCalled();
    mocks.state.configs = [{ ...boot.config, params: { onUpdate: "resources", onDeactivation: "resources" } }];
    showApplicationUpdate(boot.id);
    expect(mocks.menu).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useApplicationUpdates.getState().ids.size).toBe(0));
    updateOnDeactivation();
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
  });
  it("enables only running, local application sessions", () => {
    mocks.state.sessions = [
      boot,
      { ...boot, id: "done", status: "finished" },
      { ...boot, id: "goal", config: { ...boot.config, kind: "maven" } },
      { ...boot, id: "remote", config: { ...boot.config, target: "ssh" } },
    ];
    expect(updatableSessions().map((s) => s.id)).toEqual([boot.id]);
  });
});
