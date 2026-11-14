import { afterEach, expect, it, vi } from "vitest";
import { appDataDir, loadPlatformInfo, usePlatform } from "./platformInfo";

const appInfo = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", () => ({ isTauri: () => true, commands: { appInfo } }));

const initialPlatform = usePlatform.getState();
afterEach(() => usePlatform.setState(initialPlatform));

it.each([
  ["windows", 19045],
  ["windows", 22631],
  ["macos", null],
  ["linux", null],
] as const)("loads %s OS build %s separately from the app version", async (platform, windowsBuildNumber) => {
  appInfo.mockResolvedValue({ platform, windowsBuildNumber, version: "0.1.39", wayland: false });
  await loadPlatformInfo();
  expect(usePlatform.getState()).toMatchObject({ os: platform, windowsBuildNumber, version: "0.1.39" });
});

it("keeps platform defaults when the query fails", async () => {
  appInfo.mockRejectedValue(new Error("unavailable"));
  await loadPlatformInfo();
  expect(usePlatform.getState()).toEqual(initialPlatform);
});

it("takes the user data directory from the backend, which may have moved it", async () => {
  appInfo.mockResolvedValue({ platform: "windows", dataDir: "E:/OpenIDEA/ai.l0ng.openidea/" });
  expect(await appDataDir()).toBe("E:/OpenIDEA/ai.l0ng.openidea");
});
