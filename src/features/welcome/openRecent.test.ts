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
const executeAction = vi.fn(async (_id: string, _arg?: unknown) => true);
vi.mock("@/platform/actions", async (orig) => {
  const real = await orig<typeof import("@/platform/actions")>();
  return {
    ...real,
    // The app feature is not loaded here: stand in for its Open Recent action.
    getAction: (id: string) =>
      id === "file.openRecentProject" ? (real.getAction("file.openRecentProject") ?? {}) : real.getAction(id),
    executeAction: (id: string, arg?: unknown) =>
      id === "file.openRecentProject" ? executeAction(id, arg) : real.executeAction(id, arg),
  };
});

const { openRecent } = await import("./recent");
const { useProject } = await import("@/platform/project");

beforeEach(() => {
  openProject.mockReset();
  executeAction.mockClear();
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

  it("joins a remote open that is still connecting instead of connecting twice", async () => {
    let finish!: (ok: boolean) => void;
    openRemoteProject.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
    const first = openRecent({ path: UNC, name: "app" });
    const second = openRecent({ path: UNC, name: "app" });
    finish(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(openRemoteProject).toHaveBeenCalledTimes(1);
    await openRecent({ path: UNC, name: "app" });
    expect(openRemoteProject).toHaveBeenCalledTimes(2);
  });

  it("hands the window chosen with a modifier key to the Open Recent action, project open or not", async () => {
    const local = { path: "/p/local", name: "local" };
    useProject.setState({
      project: { root: "/p/other", name: "other", trusted: true, isGit: false, settings: {} },
    });
    expect(await openRecent(local, "new")).toBe(true);
    expect(executeAction).toHaveBeenLastCalledWith("file.openRecentProject", { path: "/p/local", window: "new" });
    useProject.setState({ project: null, lightEdit: false });
    expect(await openRecent(local, "same")).toBe(true);
    expect(executeAction).toHaveBeenLastCalledWith("file.openRecentProject", { path: "/p/local", window: "same" });
    expect(openProject).not.toHaveBeenCalled();
    // A plain click from a window without a project still opens the project here.
    await openRecent(local);
    expect(openProject).toHaveBeenCalledWith("/p/local");
    expect(executeAction).toHaveBeenCalledTimes(2);
  });

  it("opens a remote recent in the window chosen with a modifier key", async () => {
    expect(await openRecent({ path: UNC, name: "app" }, "new")).toBe(true);
    expect(openRemoteProject).toHaveBeenCalledWith(
      { kind: "wsl", distro: "Ubuntu" },
      "/home/me/app",
      expect.any(Function),
      "new",
    );
  });
});
