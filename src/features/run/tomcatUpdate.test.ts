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
}));
vi.mock("@/platform/actions", () => ({ executeAction: mocks.action, getAction: () => ({}) }));
vi.mock("@/platform/ipc", () => ({
  call: async (p: Promise<{ data: unknown }>) => (await p).data,
  commands: { runTomcatUpdate: mocks.update },
}));
vi.mock("@/workbench/contributions", () => ({
  maybeEditorService: () => ({ saveAll: async () => {} }),
  notifications: () => ({ notify: vi.fn() }),
  useDebugRunSessions: { getState: () => ({ sessions: mocks.debug ? [{ configId: "tomcat:one" }] : [] }) },
}));
vi.mock("@/ui", () => ({ showContextMenu: vi.fn() }));
vi.mock("./tomcat", () => ({ buildTomcatArtifact: mocks.build }));
vi.mock("./store", () => ({
  startRun: mocks.start,
  stopSession: mocks.stop,
  waitForExit: mocks.wait,
  useRun: { setState: vi.fn() },
}));
import { updateTomcat } from "./tomcatUpdate";
const session = { id: "run1", config: { id: "tomcat:one", kind: "tomcat" } } as RunSession;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.debug = true;
  mocks.action.mockResolvedValue(true);
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
