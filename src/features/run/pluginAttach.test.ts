import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({
  action: vi.fn(async () => true),
  notify: vi.fn(),
  startRun: vi.fn(),
  target: vi.fn(),
}));
vi.mock("@/platform/actions", () => ({ executeAction: mocks.action }));
vi.mock("@/platform/ipc", () => ({
  call: async (p: Promise<unknown>) => p,
  commands: { pluginDebugAttachTarget: mocks.target },
}));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));
vi.mock("./store", () => ({ startRun: mocks.startRun }));

import { attachesToChild, debugAttachingToChild } from "./pluginAttach";

const config = {
  id: "plugin:acme.functions:func",
  name: "Functions host",
  kind: "plugin",
  command: "func",
  args: ["start"],
  params: { debugAttach: "dotnet" },
} as unknown as RunConfig;
const worker = { pid: 42, name: "dotnet", commandLine: "dotnet Worker.dll", kind: "dotnet", adapter: "netcoredbg" };

describe("plugin configurations that attach to a child process", () => {
  beforeEach(() => vi.clearAllMocks());

  it("are plugin configurations with an attach kind", () => {
    expect(attachesToChild(config)).toBe(true);
    expect(attachesToChild({ ...config, params: {} })).toBe(false);
    expect(attachesToChild({ ...config, kind: "shell" })).toBe(false);
  });

  it("run, then attach the debugger to the process the run started", async () => {
    mocks.startRun.mockResolvedValue({ id: "s1", runId: 7, status: "running" });
    mocks.target.mockResolvedValue(worker);
    const session = await debugAttachingToChild(config, { show: false, prepared: true });
    expect(session?.runId).toBe(7);
    expect(mocks.startRun).toHaveBeenCalledWith(config, undefined, undefined, { show: false, prepared: true });
    expect(mocks.target).toHaveBeenCalledWith(config.id, 7);
    await vi.waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith("debug.attach", {
        attachable: worker,
        process: 7,
        runConfig: config,
        show: false,
      }),
    );
  });

  it("leave the run going and say why when no process turns up", async () => {
    mocks.startRun.mockResolvedValue({ id: "s1", runId: 7, status: "running" });
    mocks.target.mockRejectedValue(new Error("no dotnet process started by the run within a minute"));
    await debugAttachingToChild(config);
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalled());
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls[0]![0].body).toContain("within a minute");
  });

  it("don't wait for a process when the run didn't start", async () => {
    mocks.startRun.mockResolvedValue({ id: "s1", runId: null, status: "failed" });
    await debugAttachingToChild(config);
    expect(mocks.target).not.toHaveBeenCalled();
  });
});
