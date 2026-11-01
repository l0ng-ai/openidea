import { beforeEach, expect, it, vi } from "vitest";
import type { BuildModel, GradleModel, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { loadModel, noteExternalBuildChange, useBuild } from "./store";

const mocks = vi.hoisted(() => ({ model: vi.fn(), sync: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      buildModel: mocks.model,
      runConfigs: () => Promise.resolve([]),
      buildSync: mocks.sync,
      cancelRequest: () => Promise.resolve(),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: unknown = null;
  },
}));

const gradle = (stale: boolean) => ({ syncedAt: 1, stale, syncError: null, projects: [] }) as unknown as GradleModel;
const model = (stale: boolean): BuildModel => ({ maven: null, gradle: gradle(stale) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sync.mockImplementation(() => new Promise(() => {}));
  useBuild.setState({ syncing: {} });
  useProject.setState({ project: { root: "/p", trusted: true } as ProjectInfo });
});

it("reloads a build made stale by a change outside the editor, not by an edit in it", async () => {
  mocks.model.mockResolvedValue(model(true));
  await loadModel();
  expect(mocks.sync).not.toHaveBeenCalled();

  noteExternalBuildChange();
  await loadModel();
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.sync.mock.calls[0]![0]).toBe("gradle");
  expect(useBuild.getState().model?.gradle?.stale).toBe(true);
});

it("leaves an up-to-date build alone after an external change", async () => {
  mocks.model.mockResolvedValue(model(false));
  noteExternalBuildChange();
  await loadModel();
  expect(mocks.sync).not.toHaveBeenCalled();
});
