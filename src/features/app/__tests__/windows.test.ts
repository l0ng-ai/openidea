import { beforeEach, describe, expect, it, vi } from "vitest";

const projectTrustStatus = vi.fn();
vi.mock("@/platform/projectTrust", () => ({ confirmProjectTrust: vi.fn(async () => {}) }));
vi.mock("@/workbench/messages", () => ({ ask: vi.fn() }));
const workspaceAttach = vi.fn();
const workspaceUpdate = vi.fn();
const projectCurrent = vi.fn();
const windowOpenProject = vi.fn();
const windowOpenFiles = vi.fn();
const windowTakeLaunch = vi.fn();
const windowCompleteLaunch = vi.fn();
const wslResolve = vi.fn();
const cancelClose = vi.fn();
const notify = vi.fn();
const listen = vi.fn();
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen }),
}));
vi.mock("@/platform/remote", async (original) => ({
  ...(await original<typeof import("@/platform/remote")>()),
  isRemoteWindow: vi.fn(() => false),
  connectRemote: vi.fn(async () => {}),
}));
// The backend answers with the global settings, here: whatever the test set up.
const lightEditOpen = vi.fn(async (_path: string) => ({ status: "ok", data: useProject.getState().settings ?? {} }));
const fsReadDir = vi.fn(async (_path: string) => ({ status: "ok", data: [] }));
const openProject = vi.fn(async (path: string) => {
  const project = { root: path, name: path, trusted: true, isGit: false, settings: {} };
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
      projectTrustStatus: (...a: unknown[]) => projectTrustStatus(...a),
      workspaceAttach: (...a: unknown[]) => workspaceAttach(...a),
      workspaceUpdate: (...a: unknown[]) => workspaceUpdate(...a),
      projectCurrent: () => projectCurrent(),
      windowOpenProject: (...a: unknown[]) => windowOpenProject(...a),
      windowOpenFiles: (...a: unknown[]) => windowOpenFiles(...a),
      windowTakeLaunch: () => windowTakeLaunch(),
      windowCompleteLaunch: () => windowCompleteLaunch(),
      wslResolve: (p: string) => wslResolve(p),
      lightEditOpen: (p: string) => lightEditOpen(p),
      fsReadDir: (p: string) => fsReadDir(p),
    },
  };
});
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, confirmLeaveProject: vi.fn(real.confirmLeaveProject), openProject: (p: string) => openProject(p) };
});
const diffs: unknown[] = [];
const openDiff = vi.fn(async (data: unknown) => void diffs.push(data));
vi.mock("@/features/vcs/diffInput", () => ({ openVcsDiff: (data: unknown) => openDiff(data) }));

const {
  openProjectInWindow,
  consumeLaunch,
  installLaunchHandling,
  openFiles,
  openPaths,
  openLightEditFileAsProject,
  openProjectWithPolicy,
  windowActions,
} = await import("../windows");
const { useProject, startupLaunchHandled, confirmLeaveProject } = await import("@/platform/project");
const { provideEditorService, provideNotificationService } = await import("@/workbench/contributions");
const { isRemoteWindow, connectRemote } = await import("@/platform/remote");
const { ask } = await import("@/workbench/messages");
const { confirmProjectTrust } = await import("@/platform/projectTrust");
const { IpcError } = await import("@/platform/ipc");
provideNotificationService({ notify });

const opened: string[] = [];
let activePath: string | null = null;
const openEditorFile = vi.fn<import("@/workbench/contributions").EditorService["openFile"]>(
  async (path, options) =>
    void opened.push(
      `${path}${options?.focus ? " (focus)" : ""}${options?.selection ? ` @${options.selection.line}:${options.selection.col}` : ""}`,
    ),
);
provideEditorService({
  openFile: openEditorFile,
  openInput: async () => {},
  activePath: () => activePath,
  activeCursor: () => null,
  saveAll: async () => {},
  cancelClose,
});

const ok = (data: unknown) => ({ status: "ok", data });
const projectState = (root: string) => ({ project: { root, name: root, trusted: true, isGit: false, settings: {} } });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(ask).mockReset().mockResolvedValue({ button: "attach", checked: false });
  vi.mocked(confirmProjectTrust).mockReset().mockResolvedValue();
  projectTrustStatus.mockReset().mockResolvedValue(ok({ trusted: true }));
  workspaceAttach.mockReset();
  workspaceUpdate.mockReset();
  projectCurrent.mockReset();
  for (const f of [windowOpenProject, windowOpenFiles, windowTakeLaunch, wslResolve]) f.mockReset();
  windowTakeLaunch.mockResolvedValue(null);
  windowCompleteLaunch.mockReset().mockResolvedValue(ok(null));
  wslResolve.mockResolvedValue(null);
  vi.mocked(connectRemote).mockClear();
  for (const f of [lightEditOpen, fsReadDir, openProject]) f.mockClear();
  cancelClose.mockClear();
  vi.mocked(confirmLeaveProject).mockClear();
  notify.mockClear();
  listen.mockReset();
  openEditorFile.mockClear();
  openDiff.mockClear();
  vi.mocked(isRemoteWindow).mockReturnValue(false);
  opened.length = 0;
  diffs.length = 0;
  activePath = null;
  useProject.setState({ project: null, lightEdit: false, settings: null, opening: false, openingPath: null } as never);
});

describe("openProjectInWindow", () => {
  it("opens in this window when the backend says `current`", async () => {
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    await openProjectInWindow("/p/a", false);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/a", false, []);
    expect(openProject).toHaveBeenCalledWith("/p/a");
  });

  it("connects to the distribution when the folder is on the WSL share", async () => {
    const [distro, linuxPath] = ["Debian", "/srv/app"];
    const share = `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
    const target = { kind: "wsl", distro };
    wslResolve.mockResolvedValue({ target, path: linuxPath });
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    await openProjectInWindow(share, false);
    expect(wslResolve).toHaveBeenCalledWith(share);
    expect(connectRemote).toHaveBeenCalledWith(target, linuxPath);
    expect(openProject).not.toHaveBeenCalled();
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

describe("replacing a project in this window", () => {
  it.each([
    new Error("local folder unavailable"),
    new IpcError({ kind: "cancelled", message: "Project opening cancelled" }),
  ])("releases the close decision after opening fails or is cancelled: %s", async (error) => {
    useProject.setState({
      ...projectState("/remote"),
      settings: { general: { openProjectIn: "same" } },
    } as never);
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    openProject.mockRejectedValueOnce(error);
    await openProjectWithPolicy("/local");
    expect(cancelClose).toHaveBeenCalledOnce();
    expect(useProject.getState().project?.root).toBe("/remote");
    await openProjectWithPolicy("/local");
    expect(useProject.getState().project?.root).toBe("/local");
  });

  it("opens the local project when its path matches the remote root", async () => {
    useProject.setState({
      ...projectState("/same"),
      settings: { general: { openProjectIn: "same" } },
    } as never);
    vi.mocked(isRemoteWindow).mockReturnValue(true);
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    await openProjectWithPolicy("/same");
    expect(windowOpenProject).toHaveBeenCalledWith("/same", false, []);
    expect(openProject).toHaveBeenCalledWith("/same");
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
  it("subscribes before taking a launch received while the listener is registering", async () => {
    const registered = deferred();
    const unlisten = vi.fn();
    listen.mockImplementationOnce(async () => {
      await registered.promise;
      windowTakeLaunch.mockResolvedValueOnce({ project: "/p", files: ["/p/late.cs"] });
      return unlisten;
    });
    const dispose = installLaunchHandling();
    try {
      await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
      expect(windowTakeLaunch).not.toHaveBeenCalled();
      registered.resolve();
      await startupLaunchHandled();
      expect(opened).toEqual(["/p/late.cs (focus)"]);
    } finally {
      registered.resolve();
      await startupLaunchHandled();
      dispose();
    }
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("does not consume a launch after disposal while the listener is registering", async () => {
    const registered = deferred();
    const unlisten = vi.fn();
    listen.mockImplementationOnce(async () => {
      await registered.promise;
      return unlisten;
    });
    windowTakeLaunch.mockResolvedValueOnce({ project: "/p", files: ["/p/a.cs"] });
    const dispose = installLaunchHandling();
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    dispose();
    registered.resolve();
    await startupLaunchHandled();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(windowTakeLaunch).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it("serializes launch events while their project is opening", async () => {
    const openedProject = deferred();
    openProject.mockImplementationOnce(async (path) => {
      await openedProject.promise;
      const state = projectState(path);
      useProject.setState({ ...state, lightEdit: false } as never);
      return state.project;
    });
    let onLaunch: (() => void) | undefined;
    listen.mockImplementationOnce(async (_event, handler: () => void) => {
      onLaunch = handler;
      return () => {};
    });
    windowTakeLaunch
      .mockResolvedValueOnce({ project: "/p", files: ["/p/a.cs"] })
      .mockResolvedValueOnce({ files: ["/p/b.cs"], positions: [{ path: "/p/b.cs", line: 10, column: 3 }] });
    const dispose = installLaunchHandling();
    try {
      await vi.waitFor(() => expect(openProject).toHaveBeenCalledOnce());
      onLaunch!();
      openedProject.resolve();
      await startupLaunchHandled();
      await consumeLaunch();
      expect(lightEditOpen).not.toHaveBeenCalled();
      expect(opened).toEqual(["/p/a.cs (focus)", "/p/b.cs (focus) @10:3"]);
      expect(openProject).toHaveBeenCalledOnce();
    } finally {
      openedProject.resolve();
      await startupLaunchHandled();
      dispose();
    }
  });

  it("waits for an existing project restore before opening a received file", async () => {
    useProject.setState({ opening: true, openingPath: "/p" });
    windowTakeLaunch.mockResolvedValueOnce({
      files: ["/p/a.cs"],
      positions: [{ path: "/p/a.cs", line: 8, column: 2 }],
    });
    const request = consumeLaunch();
    try {
      await vi.waitFor(() => expect(windowTakeLaunch).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(opened).toEqual([]);
      expect(lightEditOpen).not.toHaveBeenCalled();
      expect(windowCompleteLaunch).not.toHaveBeenCalled();
    } finally {
      useProject.setState({ ...projectState("/p"), opening: false, openingPath: null } as never);
      await request;
    }
    expect(openProject).not.toHaveBeenCalled();
    expect(lightEditOpen).not.toHaveBeenCalled();
    expect(opened).toEqual(["/p/a.cs (focus) @8:2"]);
    expect(windowCompleteLaunch).toHaveBeenCalledOnce();
  });

  it("keeps the open project and applies later locations in order", async () => {
    useProject.setState(projectState("/p") as never);
    for (const line of [5, 8, 12]) {
      windowTakeLaunch.mockResolvedValueOnce({
        project: "/p",
        files: ["/p/a.cs"],
        positions: [{ path: "/p/a.cs", line, column: 0 }],
      });
    }
    await Promise.all([consumeLaunch(), consumeLaunch(), consumeLaunch()]);
    expect(openProject).not.toHaveBeenCalled();
    expect(opened).toEqual(["/p/a.cs (focus) @5:0", "/p/a.cs (focus) @8:0", "/p/a.cs (focus) @12:0"]);
  });

  it("reports a missing file and still handles the next launch", async () => {
    useProject.setState(projectState("/p") as never);
    openEditorFile.mockRejectedValueOnce(new Error("File not found"));
    windowTakeLaunch.mockResolvedValueOnce({ files: ["/p/missing.cs"] }).mockResolvedValueOnce({ files: ["/p/a.cs"] });
    await Promise.all([consumeLaunch(), consumeLaunch()]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "File not found" }));
    expect(opened).toEqual(["/p/a.cs (focus)"]);
    expect(windowCompleteLaunch).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error("Project unavailable"),
    new IpcError({ kind: "cancelled", message: "Project opening cancelled" }),
  ])("completes a failed or cancelled project launch and handles the next: %s", async (error) => {
    openProject.mockRejectedValueOnce(error);
    windowTakeLaunch
      .mockResolvedValueOnce({ project: "/p", files: ["/p/a.cs"] })
      .mockResolvedValueOnce({ project: "/q", files: ["/q/b.cs"] });
    await Promise.all([consumeLaunch(), consumeLaunch()]);
    expect(windowCompleteLaunch).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(["/q/b.cs (focus)"]);
    expect(useProject.getState().project?.root).toBe("/q");
  });

  it("keeps handling launches after completing a launch fails", async () => {
    useProject.setState(projectState("/p") as never);
    windowCompleteLaunch.mockRejectedValueOnce(new Error("Connection interrupted"));
    windowTakeLaunch.mockResolvedValueOnce({ files: ["/p/a.cs"] }).mockResolvedValueOnce({ files: ["/p/b.cs"] });
    const first = consumeLaunch();
    const second = consumeLaunch();
    await expect(first).rejects.toThrow("Connection interrupted");
    await second;
    expect(windowCompleteLaunch).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(["/p/a.cs (focus)", "/p/b.cs (focus)"]);
  });

  it("opens the pending project once", async () => {
    windowTakeLaunch.mockResolvedValueOnce({ project: "/p/launch", files: [] }).mockResolvedValueOnce(null);
    await consumeLaunch();
    await consumeLaunch();
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledWith("/p/launch");
    expect(windowCompleteLaunch).toHaveBeenCalledOnce();
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

  it("places the caret where the command line asked (openidea --line --column)", async () => {
    windowTakeLaunch.mockResolvedValueOnce({
      project: "/x/notes",
      files: ["/x/notes/a.txt", "/x/notes/b.txt"],
      positions: [{ path: "/x/notes/a.txt", line: 119, column: 7 }],
    });
    await consumeLaunch();
    expect(opened).toEqual(["/x/notes/a.txt @119:7", "/x/notes/b.txt (focus)"]);
  });

  it("opens the CLI diff pair in LightEdit without a project (openidea diff a b)", async () => {
    windowTakeLaunch.mockResolvedValueOnce({ project: null, files: [], diff: { left: "/x/a.txt", right: "/x/b.txt" } });
    await consumeLaunch();
    expect(lightEditOpen).toHaveBeenCalledWith("/x/b.txt");
    expect(windowCompleteLaunch).toHaveBeenCalledOnce();
    expect(diffs).toEqual([
      {
        path: "/x/b.txt",
        left: { type: "file", path: "/x/a.txt", label: "/x/a.txt" },
        right: { type: "worktree", label: "/x/b.txt" },
      },
    ]);
  });

  it("opens the CLI diff pair in the open project without LightEdit", async () => {
    useProject.setState(projectState("/p") as never);
    windowTakeLaunch.mockResolvedValueOnce({ project: null, files: [], diff: { left: "/p/a.txt", right: "/p/b.txt" } });
    await consumeLaunch();
    expect(lightEditOpen).not.toHaveBeenCalled();
    expect(windowCompleteLaunch).toHaveBeenCalledOnce();
    expect(diffs).toEqual([
      {
        path: "/p/b.txt",
        left: { type: "file", path: "/p/a.txt", label: "a.txt" },
        right: { type: "worktree", label: "b.txt" },
      },
    ]);
  });

  it("completes a failed CLI diff and handles the next file launch", async () => {
    useProject.setState(projectState("/p") as never);
    openDiff.mockRejectedValueOnce(new Error("Diff file unavailable"));
    windowTakeLaunch
      .mockResolvedValueOnce({ files: [], diff: { left: "/p/a.txt", right: "/p/b.txt" } })
      .mockResolvedValueOnce({ files: ["/p/next.cs"], positions: [{ path: "/p/next.cs", line: 8, column: 2 }] });
    const first = consumeLaunch();
    const next = consumeLaunch();
    await expect(first).rejects.toThrow("Diff file unavailable");
    await next;
    expect(windowCompleteLaunch).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(["/p/next.cs (focus) @8:2"]);
  });

  it("applies a later source location after a pending diff", async () => {
    useProject.setState(projectState("/p") as never);
    windowTakeLaunch
      .mockResolvedValueOnce({ files: [], diff: { left: "/p/a.txt", right: "/p/b.txt" } })
      .mockResolvedValueOnce({ files: ["/p/next.cs"], positions: [{ path: "/p/next.cs", line: 8, column: 2 }] });
    await Promise.all([consumeLaunch(), consumeLaunch()]);
    expect(diffs).toHaveLength(1);
    expect(opened).toEqual(["/p/next.cs (focus) @8:2"]);
    expect(openDiff.mock.invocationCallOrder[0]).toBeLessThan(openEditorFile.mock.invocationCallOrder[0]!);
    expect(windowCompleteLaunch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { project: null, diffBeforeFiles: false },
    { project: "/p", diffBeforeFiles: false },
    { project: null, diffBeforeFiles: true },
    { project: "/p", diffBeforeFiles: true },
  ])(
    "preserves the last request's focus for $project (diff first: $diffBeforeFiles)",
    async ({ project, diffBeforeFiles }) => {
      windowTakeLaunch.mockResolvedValueOnce({
        project,
        diffBeforeFiles,
        files: ["/p/a.cs"],
        positions: [{ path: "/p/a.cs", line: 8, column: 2 }],
        diff: { left: "/p/left.txt", right: "/p/right.txt" },
      });
      await consumeLaunch();
      expect(opened).toEqual(["/p/a.cs (focus) @8:2"]);
      expect(diffs).toHaveLength(1);
      const fileCall = openEditorFile.mock.invocationCallOrder[0]!;
      const diffCall = openDiff.mock.invocationCallOrder[0]!;
      expect(diffBeforeFiles ? diffCall : fileCall).toBeLessThan(diffBeforeFiles ? fileCall : diffCall);
      expect(windowCompleteLaunch).toHaveBeenCalledOnce();
    },
  );

  it("opens later files when their preceding diff fails", async () => {
    useProject.setState(projectState("/p") as never);
    openDiff.mockRejectedValueOnce(new Error("Diff file unavailable"));
    windowTakeLaunch.mockResolvedValueOnce({
      files: ["/p/next.cs"],
      positions: [{ path: "/p/next.cs", line: 8, column: 2 }],
      diff: { left: "/p/a.txt", right: "/p/b.txt" },
      diffBeforeFiles: true,
    });
    await consumeLaunch();
    expect(opened).toEqual(["/p/next.cs (focus) @8:2"]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "Diff file unavailable" }));
    expect(windowCompleteLaunch).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "does not open a diff when its project launch is cancelled (diff first: %s)",
    async (diffBeforeFiles) => {
      openProject.mockRejectedValueOnce(new IpcError({ kind: "cancelled", message: "Project opening cancelled" }));
      windowTakeLaunch.mockResolvedValueOnce({
        project: "/p",
        diffBeforeFiles,
        files: ["/p/a.cs"],
        diff: { left: "/p/left.txt", right: "/p/right.txt" },
      });
      await consumeLaunch();
      expect(opened).toEqual([]);
      expect(diffs).toEqual([]);
      expect(lightEditOpen).not.toHaveBeenCalled();
      expect(windowCompleteLaunch).toHaveBeenCalledOnce();
    },
  );
});

describe("Attach", () => {
  it("attaches in place without reopening or asking to leave", async () => {
    useProject.setState({
      ...projectState("/p/a"),
      settings: { general: { openProjectIn: "attach" } },
    } as never);
    const project = {
      ...projectState("/p/a").project,
      workspace: { version: 1, name: "a", projects: ["/p/a", "/p/b"] },
    };
    projectCurrent.mockResolvedValue(project);
    workspaceAttach.mockResolvedValue(ok("/p/a"));
    await openProjectWithPolicy("/p/b", ["/p/b/file.txt"]);
    expect(confirmProjectTrust).toHaveBeenCalledWith("/p/b", "local");
    expect(workspaceAttach).toHaveBeenCalledWith("/p/b");
    expect(openProject).not.toHaveBeenCalled();
    expect(cancelClose).not.toHaveBeenCalled();
    expect(confirmLeaveProject).not.toHaveBeenCalled();
    expect(useProject.getState().project).toEqual(project);
    expect(opened).toEqual(["/p/b/file.txt (focus)"]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(windowOpenProject).not.toHaveBeenCalled();
  });
  it("does not attach when trust is cancelled", async () => {
    useProject.setState(projectState("/p/a"));
    vi.mocked(confirmProjectTrust).mockRejectedValueOnce(new IpcError({ kind: "cancelled", message: "Cancelled" }));
    await openProjectWithPolicy("/p/b");
    expect(workspaceAttach).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it("does not attach a folder previewed in restricted mode", async () => {
    useProject.setState(projectState("/p/a"));
    projectTrustStatus.mockResolvedValueOnce(ok({ trusted: false }));
    await openProjectWithPolicy("/p/b");
    expect(workspaceAttach).not.toHaveBeenCalled();
  });
  it("explains how to attach a folder already decided as restricted", async () => {
    useProject.setState(projectState("/p/a"));
    projectTrustStatus.mockResolvedValueOnce(ok({ root: "/p/b", trusted: false, decided: true }));
    await openProjectWithPolicy("/p/b");
    expect(workspaceAttach).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        body: "Cannot attach /p/b because it is restricted. Open it separately and choose Trust Project, then attach it again.",
      }),
    );
  });
  it("refreshes an existing workspace without reopening its editor session", async () => {
    const before = {
      root: "/workspace",
      name: "A",
      trusted: true,
      isGit: false,
      settings: {},
      workspace: { version: 1, name: "A", projects: ["/p/a"] },
    };
    useProject.setState({
      project: before,
      settings: { general: { openProjectIn: "attach" } },
    } as never);
    workspaceAttach.mockResolvedValue(ok("/workspace"));
    projectCurrent.mockResolvedValue({
      ...before,
      workspace: { ...before.workspace, projects: ["/p/a", "/p/b"] },
    });
    await openProjectWithPolicy("/p/b");
    expect(useProject.getState().project?.workspace?.projects).toEqual(["/p/a", "/p/b"]);
    expect(openProject).not.toHaveBeenCalled();
  });
});

it("removes the first workspace member while retaining the workspace state root", async () => {
  const project = {
    root: "/workspace",
    name: "A",
    trusted: true,
    isGit: false,
    settings: {},
    workspace: { version: 1, name: "A", projects: ["/a", "/b"] },
  };
  useProject.setState({ project });
  workspaceUpdate.mockResolvedValue(ok({ ...project, workspace: { ...project.workspace, projects: ["/b"] } }));
  await windowActions()
    .find((a) => a.id === "workspace.removeProject")!
    .run({ arg: "/a" } as never);
  expect(workspaceUpdate).toHaveBeenCalledWith("A", ["/b"]);
  expect(useProject.getState().project?.root).toBe("/workspace");
  expect(useProject.getState().project?.workspace?.projects).toEqual(["/b"]);
});

it("confirms detaching an attachment and never removes the primary", async () => {
  const project = { ...projectState("/a").project, workspace: { version: 1, name: "A", projects: ["/a", "/b"] } };
  useProject.setState({ project });
  const action = windowActions().find((a) => a.id === "project.detach")!;
  expect(action.title).toBe("Detach Project");
  expect(action.when).toBe("projectAttached");
  await action.run({ arg: "/a" } as never);
  expect(ask).not.toHaveBeenCalled();
  expect(workspaceUpdate).not.toHaveBeenCalled();
  vi.mocked(ask).mockResolvedValueOnce({ button: "cancel", checked: false });
  await action.run({ arg: "/b" } as never);
  expect(workspaceUpdate).not.toHaveBeenCalled();
  vi.mocked(ask).mockResolvedValueOnce({ button: "detach", checked: false });
  workspaceUpdate.mockResolvedValueOnce(ok(projectState("/a").project));
  await action.run({ arg: "/b" } as never);
  expect(workspaceUpdate).toHaveBeenCalledWith("A", ["/a"]);
  expect(useProject.getState().project?.workspace).toBeUndefined();
});

describe("explicit project-window requests", () => {
  it("honours current-window requests even when a project is already open", async () => {
    useProject.setState(projectState("/p/old") as never);
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    const action = windowActions().find((a) => a.id === "file.openProjectPath")!;
    await action.run({ arg: { path: "/p/new", newWindow: false } } as never);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/new", false, []);
    expect(openProject).toHaveBeenCalledWith("/p/new");
  });
  it("opens a new window without replacing the current project", async () => {
    useProject.setState(projectState("/p/old") as never);
    windowOpenProject.mockResolvedValue(ok({ kind: "opened", label: "project-1" }));
    const action = windowActions().find((a) => a.id === "file.openProjectPath")!;
    await action.run({ arg: { path: "/p/new", newWindow: true } } as never);
    expect(windowOpenProject).toHaveBeenCalledWith("/p/new", true, []);
    expect(openProject).not.toHaveBeenCalled();
    expect(useProject.getState().project?.root).toBe("/p/old");
  });
  it("keeps the ordinary unsaved-change guard for current-window opens", async () => {
    const { provideLeaveProjectGuard } = await import("@/platform/project");
    const dispose = provideLeaveProjectGuard(async () => false);
    useProject.setState(projectState("/p/old") as never);
    windowOpenProject.mockResolvedValue(ok({ kind: "current" }));
    try {
      const action = windowActions().find((a) => a.id === "file.openProjectPath")!;
      await action.run({ arg: { path: "/p/new", newWindow: false } } as never);
      expect(openProject).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
