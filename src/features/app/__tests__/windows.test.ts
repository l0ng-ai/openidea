import { beforeEach, describe, expect, it, vi } from "vitest";

const windowOpenProject = vi.fn();
const windowOpenFiles = vi.fn();
const windowTakeLaunch = vi.fn();
// The backend answers with the global settings, here: whatever the test set up.
const lightEditOpen = vi.fn(async (_path: string) => ({ status: "ok", data: useProject.getState().settings ?? {} }));
const fsReadDir = vi.fn(async (_path: string) => ({ status: "ok", data: [] }));
const openProject = vi.fn(async (path: string) => {
  const project = { root: path, name: path, isGit: false, settings: {} };
  useProject.setState({ project, lightEdit: false } as never);
  return project;
});

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      windowOpenProject: (...a: unknown[]) => windowOpenProject(...a),
      windowOpenFiles: (...a: unknown[]) => windowOpenFiles(...a),
      windowTakeLaunch: () => windowTakeLaunch(),
      lightEditOpen: (p: string) => lightEditOpen(p),
      fsReadDir: (p: string) => fsReadDir(p),
    },
  };
});
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, openProject: (p: string) => openProject(p) };
});

const { openProjectInWindow, consumeLaunch, openFiles, openPaths, openLightEditFileAsProject, windowActions } =
  await import("../windows");
const { useProject } = await import("@/platform/project");
const { provideEditorService } = await import("@/workbench/contributions");

const opened: string[] = [];
let activePath: string | null = null;
provideEditorService({
  openFile: async (path, options) => void opened.push(`${path}${options?.focus ? " (focus)" : ""}`),
  openInput: async () => {},
  activePath: () => activePath,
  activeCursor: () => null,
  saveAll: async () => {},
});

const ok = (data: unknown) => ({ status: "ok", data });
const projectState = (root: string) => ({ project: { root, name: root, isGit: false, settings: {} } });

beforeEach(() => {
  for (const f of [windowOpenProject, windowOpenFiles, windowTakeLaunch]) f.mockReset();
  for (const f of [lightEditOpen, fsReadDir, openProject]) f.mockClear();
  opened.length = 0;
  activePath = null;
  useProject.setState({ project: null, lightEdit: false, settings: null } as never);
});

describe("openProjectInWindow", () => {
  it("opens in this window when the backend says `current`", async () => {
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    await openProjectInWindow("/p/a", false);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/a", false, []);
    expect(openProject).toHaveBeenCalledWith("/p/a");
  });

  it("asks for a new window when this one already has a project", async () => {
    useProject.setState(projectState("/p/b") as never);
    windowOpenProject.mockResolvedValue(ok({ kind: "opened", label: "project-1" }));
    await openProjectInWindow("/p/a", false);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/a", true, []);
    expect(openProject).not.toHaveBeenCalled();
  });

  it("asks for a new window from a LightEdit window", async () => {
    useProject.setState({ lightEdit: true });
    windowOpenProject.mockResolvedValue(ok({ kind: "opened", label: "project-1" }));
    await openProjectInWindow("/p/a", false);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/a", true, []);
  });

  it("does nothing locally when another window was focused", async () => {
    windowOpenProject.mockResolvedValue(ok({ kind: "focused", label: "main" }));
    await openProjectInWindow("/p/a", true);
    expect(openProject).not.toHaveBeenCalled();
  });
});

describe("loose files (LightEdit)", () => {
  it("turns a window without a project into LightEdit when no LightEdit window exists", async () => {
    windowOpenFiles.mockResolvedValue(ok(["/x/a.txt", "/y/b.md"]));
    await openFiles(["/x/a.txt", "/y/b.md"]);
    expect(windowOpenFiles).toHaveBeenCalledWith(["/x/a.txt", "/y/b.md"]);
    expect(lightEditOpen).toHaveBeenCalledWith("/x/a.txt");
    expect(useProject.getState()).toMatchObject({ project: null, lightEdit: true });
    expect(opened).toEqual(["/x/a.txt", "/y/b.md (focus)"]);
  });

  it("leaves files to the existing LightEdit window or their project's window", async () => {
    windowOpenFiles.mockResolvedValue(ok([]));
    await openFiles(["/x/a.txt"]);
    expect(lightEditOpen).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
    expect(useProject.getState().lightEdit).toBe(false);
  });

  it("opens only the files the backend leaves to this window", async () => {
    windowOpenFiles.mockResolvedValue(ok(["/x/b.txt"]));
    await openFiles(["/p/a.rs", "/x/b.txt"]);
    expect(lightEditOpen).toHaveBeenCalledWith("/x/b.txt");
    expect(opened).toEqual(["/x/b.txt (focus)"]);
  });

  it("adds tabs to this LightEdit window", async () => {
    useProject.setState({ lightEdit: true });
    windowOpenFiles.mockResolvedValue(ok(["/x/c.txt"]));
    await openFiles(["/x/c.txt"]);
    expect(windowOpenFiles).toHaveBeenCalledWith(["/x/c.txt"]);
    expect(lightEditOpen).not.toHaveBeenCalled();
    expect(opened).toEqual(["/x/c.txt (focus)"]);
  });

  it("opens files in the project's editor in a project window", async () => {
    useProject.setState(projectState("/p") as never);
    await openFiles(["/elsewhere/a.txt"]);
    expect(windowOpenFiles).not.toHaveBeenCalled();
    expect(opened).toEqual(["/elsewhere/a.txt (focus)"]);
    expect(useProject.getState().lightEdit).toBe(false);
  });

  it("routes dropped files to LightEdit and the dropped folder to a project", async () => {
    windowOpenFiles.mockResolvedValue(ok(["/x/a.txt"]));
    windowOpenProject.mockResolvedValue(ok({ kind: "opened", label: "project-1" }));
    useProject.setState({ settings: { general: { openProjectIn: "new" } } } as never);
    await openPaths(["/x/a.txt", "/work/app"], async (p) => p === "/work/app");
    expect(lightEditOpen).toHaveBeenCalledWith("/x/a.txt");
    expect(windowOpenProject).toHaveBeenCalledWith("/work/app", true, []);
  });

  it("opens a dropped folder alone exactly as before", async () => {
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    await openPaths(["/work/app"], async () => true);
    expect(windowOpenFiles).not.toHaveBeenCalled();
    expect(lightEditOpen).not.toHaveBeenCalled();
    expect(openProject).toHaveBeenCalledWith("/work/app");
  });

  it("classifies paths through the file system by default", async () => {
    fsReadDir.mockResolvedValueOnce({ status: "error", error: { kind: "notFound", message: "not a dir" } } as never);
    windowOpenFiles.mockResolvedValue(ok(["/x/a.txt"]));
    await openPaths(["/x/a.txt"]);
    expect(fsReadDir).toHaveBeenCalledWith("/x/a.txt");
    expect(lightEditOpen).toHaveBeenCalledWith("/x/a.txt");
  });
});

describe("Open Containing Folder as Project", () => {
  it("is an action available in LightEdit only", () => {
    const action = windowActions().find((a) => a.id === "lightEdit.openProject");
    expect(action?.when).toBe("lightEdit");
    expect(windowActions().some((a) => a.id === "file.openFile")).toBe(true);
  });

  it("opens the folder in a new window with the file, per 'Open project in'", async () => {
    useProject.setState({ lightEdit: true, settings: { general: { openProjectIn: "new" } } } as never);
    activePath = "/x/notes/a.txt";
    windowOpenProject.mockResolvedValue(ok({ kind: "opened", label: "project-1" }));
    await openLightEditFileAsProject();
    expect(windowOpenProject).toHaveBeenCalledWith("/x/notes", true, ["/x/notes/a.txt"]);
    expect(openProject).not.toHaveBeenCalled();
  });

  it("or turns this window into the project and reopens the file there", async () => {
    useProject.setState({ lightEdit: true, settings: { general: { openProjectIn: "same" } } } as never);
    activePath = "/x/notes/a.txt";
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    await openLightEditFileAsProject();
    expect(windowOpenProject).toHaveBeenCalledWith("/x/notes", false, ["/x/notes/a.txt"]);
    expect(openProject).toHaveBeenCalledWith("/x/notes");
    expect(useProject.getState()).toMatchObject({ lightEdit: false, project: { root: "/x/notes" } });
    expect(opened).toEqual(["/x/notes/a.txt (focus)"]);
  });

  it("does nothing outside LightEdit", async () => {
    useProject.setState(projectState("/p") as never);
    activePath = "/p/a.txt";
    await openLightEditFileAsProject();
    expect(windowOpenProject).not.toHaveBeenCalled();
  });
});

describe("launch", () => {
  it("opens the pending project once", async () => {
    windowTakeLaunch.mockResolvedValueOnce({ project: "/p/launch", files: [] }).mockResolvedValueOnce(null);
    await consumeLaunch();
    await consumeLaunch();
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledWith("/p/launch");
  });

  it("opens launched files in LightEdit without a project", async () => {
    windowTakeLaunch.mockResolvedValueOnce({ project: null, files: ["/x/a.txt"] });
    await consumeLaunch();
    expect(windowOpenFiles).not.toHaveBeenCalled();
    expect(lightEditOpen).toHaveBeenCalledWith("/x/a.txt");
    expect(opened).toEqual(["/x/a.txt (focus)"]);
  });

  it("opens launched files in the launched project", async () => {
    windowTakeLaunch.mockResolvedValueOnce({ project: "/x/notes", files: ["/x/notes/a.txt"] });
    await consumeLaunch();
    expect(openProject).toHaveBeenCalledWith("/x/notes");
    expect(lightEditOpen).not.toHaveBeenCalled();
    expect(opened).toEqual(["/x/notes/a.txt (focus)"]);
  });
});
