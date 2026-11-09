import { beforeEach, expect, it, vi } from "vitest";
import type { BuildModel, MavenModel, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { changedOutsideIde, loadModel, noteExternalBuildChange, noteIdeSave, useBuild } from "./store";

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

const maven = (stale: boolean) =>
  ({ syncedAt: 1, stale, syncError: null, profiles: [], projects: [] }) as unknown as MavenModel;
const model = (stale: boolean): BuildModel => ({ maven: maven(stale), gradle: [] });

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
  expect(mocks.sync.mock.calls[0]![0]).toBe("maven");
  expect(useBuild.getState().model?.maven?.stale).toBe(true);
});

it("leaves an up-to-date build alone after an external change", async () => {
  mocks.model.mockResolvedValue(model(false));
  noteExternalBuildChange();
  await loadModel();
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("tells the IDE's own saves of a build file apart from changes made outside it", () => {
  noteIdeSave("/p/pom.xml", 1000);
  expect(changedOutsideIde(["/p/pom.xml"], 2000)).toBe(false);
  // A tool rewrites the same file later, while it is still open in a tab.
  expect(changedOutsideIde(["/p/pom.xml"], 10_000)).toBe(true);
  // Never saved by the IDE: a VCS update.
  expect(changedOutsideIde(["/p/core/pom.xml"], 2000)).toBe(true);
  noteIdeSave("/p/pom.xml", 20_000);
  expect(changedOutsideIde(["/p/pom.xml", "/p/core/pom.xml"], 20_500)).toBe(true);
});
