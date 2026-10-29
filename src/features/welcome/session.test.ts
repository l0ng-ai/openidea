import { beforeEach, describe, expect, it, vi } from "vitest";

const openProject = vi.fn();

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, settingsGet: async () => ({ general: { reopenLastProject: true } }) },
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, openProject: (p: string) => openProject(p) };
});

const { reopenLastProject, _resetSessionForTests } = await import("./session");
const { provideStartupLaunch, useProject } = await import("@/platform/project");

beforeEach(() => {
  openProject.mockReset();
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
});
