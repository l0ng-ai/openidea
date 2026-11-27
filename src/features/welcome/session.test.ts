import { beforeEach, describe, expect, it, vi } from "vitest";

const openProject = vi.fn();
const closeProject = vi.fn();
const connectRemote = vi.fn();
const UNC = String.raw`\\wsl.localhost\Ubuntu\home\me\app`;

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      settingsGet: async () => ({ general: { reopenLastProject: true } }),
      wslResolve: async (p: string) =>
        p === UNC ? { target: { kind: "wsl", distro: "Ubuntu" }, path: "/home/me/app" } : null,
    },
  };
});
vi.mock("@/platform/remote", async (orig) => {
  const real = await orig<typeof import("@/platform/remote")>();
  return { ...real, connectRemote: (t: unknown, p: string) => connectRemote(t, p) };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, openProject: (p: string) => openProject(p), closeProject: () => closeProject() };
});

const { cancelReopen, reopenLastProject, useSession, _resetSessionForTests } = await import("./session");
const { provideStartupLaunch, useProject } = await import("@/platform/project");

beforeEach(() => {
  openProject.mockReset();
  closeProject.mockReset().mockResolvedValue(undefined);
  connectRemote.mockReset();
  useProject.setState({ project: null, lightEdit: false });
  sessionStorage.clear();
  localStorage.setItem("openidea.session.openProject", "/p/last");
  _resetSessionForTests();
});

describe("reopenLastProject", () => {
  it("waits for the command-line project instead of opening the last one too", async () => {
    let finishLaunch!: () => void;
    provideStartupLaunch(
      new Promise<void>((resolve) => {
        finishLaunch = () => {
          useProject.setState({ project: { root: "/p/launch" } as never });
          resolve();
        };
      }),
    );
    const reopened = reopenLastProject();
    await new Promise((r) => setTimeout(r, 0));
    expect(openProject).not.toHaveBeenCalled();
    finishLaunch();
    await reopened;
    expect(openProject).not.toHaveBeenCalled();
  });

  it.each(["last session", "window session"])(
    "keeps launched loose files instead of restoring the %s project",
    async (remembered) => {
      if (remembered === "window session") sessionStorage.setItem("openidea.window.project", "/p/window");
      provideStartupLaunch(
        Promise.resolve().then(() => {
          useProject.setState({ lightEdit: true });
        }),
      );
      await reopenLastProject();
      expect(openProject).not.toHaveBeenCalled();
      expect(useProject.getState().lightEdit).toBe(true);
      expect(useProject.getState().project).toBeNull();
    },
  );

  it("reopens the last project when the launch named none", async () => {
    provideStartupLaunch(Promise.resolve());
    await reopenLastProject();
    expect(openProject).toHaveBeenCalledWith("/p/last");
  });

  it("restores a session saved as a WSL UNC folder through the distro", async () => {
    localStorage.setItem("openidea.session.openProject", UNC);
    provideStartupLaunch(Promise.resolve());
    await reopenLastProject();
    expect(connectRemote).toHaveBeenCalledWith({ kind: "wsl", distro: "Ubuntu" }, "/home/me/app");
    expect(openProject).not.toHaveBeenCalled();
  });

  it("clears the remembered project while reopening and lets the user cancel", async () => {
    let resolveOpen!: () => void;
    openProject.mockImplementation(
      () =>
        new Promise((r) => {
          resolveOpen = () => {
            useProject.setState({ project: { root: "/p/last" } as never });
            r({ root: "/p/last" });
          };
        }),
    );
    provideStartupLaunch(Promise.resolve());
    const promise = reopenLastProject();
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem("openidea.session.openProject")).toBeNull();
    expect(useSession.getState().reopening).toBe("/p/last");

    cancelReopen();
    expect(useSession.getState().reopening).toBeNull();
    resolveOpen();
    await promise;
    expect(closeProject).toHaveBeenCalledOnce();
    expect(localStorage.getItem("openidea.session.openProject")).toBeNull();
  });

  it("keeps a project the user opened after cancelling", async () => {
    let resolveOpen!: () => void;
    openProject.mockImplementation(
      () =>
        new Promise((r) => {
          resolveOpen = () => r({ root: "/p/last" });
        }),
    );
    provideStartupLaunch(Promise.resolve());
    const promise = reopenLastProject();
    await new Promise((r) => setTimeout(r, 0));
    cancelReopen();
    useProject.setState({ project: { root: "/p/other" } as never });
    resolveOpen();
    await promise;
    expect(closeProject).not.toHaveBeenCalled();
  });
});
