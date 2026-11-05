import { beforeEach, describe, expect, it, vi } from "vitest";

const openProject = vi.fn();
const openRemoteProject = vi.fn();
const UNC = String.raw`\\wsl.localhost\Ubuntu\home\me\app`;

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      wslResolve: async (p: string) =>
        p === UNC ? { target: { kind: "wsl", distro: "Ubuntu" }, path: "/home/me/app" } : null,
    },
  };
});
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, openProject: (p: string) => openProject(p) };
});
vi.mock("@/workbench/projectWindow", () => ({
  openRemoteProject: (...a: unknown[]) => openRemoteProject(...a),
}));

const { openRecent } = await import("./recent");
const { useProject } = await import("@/platform/project");

beforeEach(() => {
  openProject.mockReset();
  openRemoteProject.mockReset().mockResolvedValue(true);
  useProject.setState({ project: null, lightEdit: false });
});

describe("openRecent", () => {
  it("opens a legacy WSL UNC recent through the distro, not as a local folder", async () => {
    expect(await openRecent({ path: UNC, name: "app" })).toBe(true);
    expect(openRemoteProject).toHaveBeenCalledWith(
      { kind: "wsl", distro: "Ubuntu" },
      "/home/me/app",
      expect.any(Function),
    );
    expect(openProject).not.toHaveBeenCalled();
  });

  it("still opens a plain local recent locally", async () => {
    await openRecent({ path: "/p/local", name: "local" });
    expect(openProject).toHaveBeenCalledWith("/p/local");
    expect(openRemoteProject).not.toHaveBeenCalled();
  });
});
