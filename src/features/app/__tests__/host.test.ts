import { beforeEach, expect, it, vi } from "vitest";
import type { BuildInfo } from "@/platform/ipc";

const { appBuildInfo, isTauri } = vi.hoisted(() => ({ appBuildInfo: vi.fn(), isTauri: vi.fn() }));
vi.mock("@/platform/ipc", () => ({ commands: { appBuildInfo }, isTauri }));

const build: BuildInfo = {
  version: "0.1.32",
  build: "dev",
  profile: "debug",
  os: "windows",
  arch: "x86_64",
  tauri: "2.11.3",
  updates: false,
};

beforeEach(() => {
  vi.resetModules();
  appBuildInfo.mockReset();
  isTauri.mockReturnValue(true);
});

it("retries after a rejected request and caches the successful build info", async () => {
  appBuildInfo.mockRejectedValueOnce(new Error("Project is not trusted")).mockResolvedValueOnce(build);
  const { buildInfo, hostOs } = await import("../host");

  const first = buildInfo();
  expect(buildInfo()).toBe(first);
  await expect(first).resolves.toBeNull();
  await expect(hostOs()).resolves.toBe("windows");
  await expect(buildInfo()).resolves.toBe(build);
  expect(appBuildInfo).toHaveBeenCalledTimes(2);
});

it("shares an in-flight successful request", async () => {
  let resolve!: (value: BuildInfo) => void;
  appBuildInfo.mockReturnValue(new Promise<BuildInfo>((done) => (resolve = done)));
  const { buildInfo } = await import("../host");
  const first = buildInfo();
  expect(buildInfo()).toBe(first);
  expect(appBuildInfo).toHaveBeenCalledTimes(1);
  resolve(build);
  await expect(first).resolves.toBe(build);
});

it("does not invoke the backend outside Tauri", async () => {
  isTauri.mockReturnValue(false);
  const { buildInfo } = await import("../host");
  await expect(buildInfo()).resolves.toBeNull();
  expect(appBuildInfo).not.toHaveBeenCalled();
});
