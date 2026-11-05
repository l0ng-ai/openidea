import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BuildModel, MavenModel, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { loadModel, PROFILE_RELOAD_DELAY_MS, resetBuild, setProfile, useBuild } from "./store";

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

const maven = {
  syncedAt: 1,
  stale: false,
  syncError: null,
  profiles: [
    { id: "native", activeByDefault: false },
    { id: "local", activeByDefault: false },
    { id: "dev", activeByDefault: true },
  ],
  projects: [],
} as unknown as MavenModel;
const model: BuildModel = { maven, gradle: [] };

/** The `-P` entries each sync was started with. */
const syncedProfiles = () => mocks.sync.mock.calls.map((c) => c[3] as string[]);

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  resetBuild();
  useBuild.setState({ syncing: {} });
  useProject.setState({ project: { root: "/p", trusted: true } as ProjectInfo });
  mocks.model.mockResolvedValue(model);
  await loadModel();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("reloads Maven once with the new profiles after a few toggles", async () => {
  let finish = () => {};
  mocks.sync.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(model))));
  setProfile("native", true);
  setProfile("local", true);
  setProfile("dev", false);
  expect(mocks.sync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(PROFILE_RELOAD_DELAY_MS);
  expect(syncedProfiles()).toEqual([["native", "local", "!dev"]]);
  finish();
  await vi.runAllTimersAsync();
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("reloads again after a sync that started with the previous profiles", async () => {
  const finishes: (() => void)[] = [];
  mocks.sync.mockImplementation(() => new Promise((resolve) => finishes.push(() => resolve(model))));
  setProfile("native", true);
  await vi.advanceTimersByTimeAsync(PROFILE_RELOAD_DELAY_MS);
  setProfile("local", true);
  await vi.advanceTimersByTimeAsync(PROFILE_RELOAD_DELAY_MS);
  expect(syncedProfiles()).toEqual([["native"]]);
  finishes[0]!();
  await vi.runAllTimersAsync();
  expect(syncedProfiles()).toEqual([["native"], ["native", "local"]]);
});

it("does not reload a project closed before the delay ran out", async () => {
  setProfile("native", true);
  resetBuild();
  await vi.advanceTimersByTimeAsync(PROFILE_RELOAD_DELAY_MS);
  expect(mocks.sync).not.toHaveBeenCalled();
});
