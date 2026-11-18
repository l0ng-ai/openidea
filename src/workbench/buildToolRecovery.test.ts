import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BuildModel, ProjectInfo, RunConfig } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), start: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      buildSync: mocks.sync,
      runStart: mocks.start,
      runConfigs: async () => ({ status: "ok", data: [] }),
      showSystemNotification: async () => ({ status: "ok", data: null }),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: unknown = null;
  },
}));

import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { notificationServiceImpl, useNotifications } from "@/workbench/notificationStore";
import { resetBuild, syncTool, useBuild } from "../features/build-tools/store";
import { resetRuns, startRun } from "../features/run/store";

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ project: { root: "/p", trusted: true } as ProjectInfo });
  useBuild.setState({ root: "/p", syncing: {}, model: { maven: null, gradle: [] } });
  provideNotificationService({ notify: mocks.notify });
});
afterEach(() => {
  resetBuild();
  resetRuns();
  useNotifications.setState({ items: [] });
});

it.each(["maven", "gradle"] as const)("offers settings for %s sync failures, returned or thrown", async (tool) => {
  const command = tool === "maven" ? "mvn" : "gradle";
  const message = `cannot start ${command}: No such file or directory (os error 2)`;
  mocks.sync.mockRejectedValueOnce(new Error(message));
  await syncTool(tool);
  expect(mocks.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actions: [expect.objectContaining({ label: `Open ${tool === "maven" ? "Maven" : "Gradle"} Settings` })],
      body: expect.stringContaining(message),
    }),
  );
  const model = (tool === "maven"
    ? { maven: { syncError: message }, gradle: [] }
    : { maven: null, gradle: [{ syncError: message }] }) as unknown as BuildModel;
  mocks.sync.mockResolvedValueOnce({ status: "ok", data: model });
  await syncTool(tool);
  expect(mocks.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actions: [expect.objectContaining({ label: `Open ${tool === "maven" ? "Maven" : "Gradle"} Settings` })],
    }),
  );
});

// #4092: the failure balloon outlived the reload that fixed it.
it.each(["maven", "gradle"] as const)("a clean %s reload takes down the failure balloon", async (tool) => {
  provideNotificationService(notificationServiceImpl);
  const name = tool === "maven" ? "Maven" : "Gradle";
  const shown = () =>
    useNotifications
      .getState()
      .items.filter((n) => n.balloon)
      .map((n) => n.title);
  mocks.sync.mockRejectedValueOnce(new Error("cannot start mvn.cmd: program not found"));
  await syncTool(tool);
  expect(shown()).toEqual([`Cannot reload ${name} projects`]);

  const clean = (tool === "maven"
    ? { maven: { syncError: null }, gradle: [] }
    : { maven: null, gradle: [{ syncError: null }] }) as unknown as BuildModel;
  mocks.sync.mockResolvedValueOnce({ status: "ok", data: clean });
  await syncTool(tool);
  expect(shown()).toEqual([]);
  // Still in the Notifications tool window.
  expect(useNotifications.getState().items.map((n) => n.title)).toEqual([`Cannot reload ${name} projects`]);
});

it.each(["maven", "gradle"] as const)("offers settings when a %s run cannot start", async (kind) => {
  const command = kind === "maven" ? "mvn" : "gradle";
  const config: RunConfig = {
    id: kind,
    name: `${command} test`,
    kind,
    command,
    args: ["test"],
    cwd: null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
  mocks.start.mockRejectedValueOnce(new Error(`command not found: ${command}`));
  await startRun(config, undefined, undefined, { prepared: true, show: false });
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actions: [expect.objectContaining({ label: `Open ${kind === "maven" ? "Maven" : "Gradle"} Settings` })],
    }),
  );
});
