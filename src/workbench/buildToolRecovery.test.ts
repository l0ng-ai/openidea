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
