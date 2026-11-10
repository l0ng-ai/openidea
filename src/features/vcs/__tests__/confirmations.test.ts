import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, ProjectInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({ stage: vi.fn(), ask: vi.fn(), refresh: vi.fn(), notify: vi.fn(), mode: "ask" }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, vcsStage: mocks.stage },
  };
});
vi.mock("@/workbench/messages", () => ({ ask: mocks.ask }));
vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ vcs: { confirmation: { onCreate: mocks.mode, onDelete: "never" } } }),
}));
vi.mock("../store", async () => {
  const { create } = await import("zustand");
  return { useVcs: create(() => ({})), refreshNow: mocks.refresh, beginGitWork: () => () => {} };
});
import { notifyFileOperation } from "@/platform/fileOps";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { installFileConfirmations } from "../confirmations";
import { clearConsole } from "../ops";
import { useVcs } from "../store";

const asset = "/p/Assets/New.cs";
const meta = asset + ".meta";
const file = (
  path: string,
  staged: FileStatus["staged"] = null,
  unstaged: FileStatus["unstaged"] = "untracked",
): FileStatus => ({ path, relPath: path.slice(3), staged, unstaged, renamedFrom: null });
const publish = (...status: FileStatus[]) => useVcs.setState({ status });
const createFile = (path = asset) => notifyFileOperation({ kind: "created", paths: [path] });
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
let dispose: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = "ask";
  mocks.ask.mockResolvedValue({ button: "ok", checked: false });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.stage.mockImplementation(async (paths: string[]) => {
    publish(
      ...useVcs
        .getState()
        .status.map((f) => (paths.includes(f.path) ? { ...f, staged: "added" as const, unstaged: null } : f)),
    );
    return { status: "ok", data: null };
  });
  clearConsole();
  provideNotificationService({ notify: mocks.notify });
  useProject.setState({ project: { root: "/p", unity: {} } as ProjectInfo, opening: false, openingPath: null });
  useVcs.setState({
    available: true,
    root: "/p",
    roots: ["/p"],
    repo: "/p",
    statusLoaded: true,
    loading: false,
    error: null,
    status: [file(asset)],
  });
  dispose = installFileConfirmations();
});
afterEach(() => dispose());

describe("Unity new-file Git confirmations", () => {
  it("includes existing metadata in the confirmation and stages both files", async () => {
    publish(file(asset), file(meta));
    createFile();
    await settle();
    expect(mocks.ask.mock.calls[0]![0].body).toContain("Assets/New.cs.meta");
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset, meta]);
  });

  it("adds delayed metadata only, preserving later unstaged script edits", async () => {
    createFile();
    await settle();
    publish(file(asset, "added", "modified"), file(meta), file("/p/Assets/Other.cs.meta"));
    await settle();
    expect(mocks.stage.mock.calls.map(([paths]) => paths)).toEqual([[asset], [meta]]);
    expect(useVcs.getState().status[0]!.unstaged).toBe("modified");
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it("finds metadata generated while the confirmation is open", async () => {
    mocks.ask.mockImplementationOnce(async () => {
      publish(file(asset), file(meta));
      return { button: "ok", checked: false };
    });
    createFile();
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset, meta]);
  });

  it("also pairs metadata in silent mode", async () => {
    mocks.mode = "silently";
    createFile();
    await settle();
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.stage).toHaveBeenLastCalledWith([meta]);
  });

  it("waits for a completed status refresh before adding delayed metadata", async () => {
    createFile();
    await settle();
    useVcs.setState({ loading: true });
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    useVcs.setState({ loading: false });
    await settle();
    expect(mocks.stage).toHaveBeenLastCalledWith([meta]);
  });

  it("finds metadata generated during the initial staging operation", async () => {
    mocks.stage.mockImplementationOnce(async () => {
      publish(file(asset, "added", null), file(meta));
      return { status: "ok", data: null };
    });
    createFile();
    await settle();
    expect(mocks.stage.mock.calls.map(([paths]) => paths)).toEqual([[asset], [meta]]);
  });

  it.each(["declined", "never", "failure"])("does not follow metadata after %s", async (reason) => {
    if (reason === "declined") mocks.ask.mockResolvedValue({ button: "cancel", checked: false });
    if (reason === "never") mocks.mode = "never";
    if (reason === "failure") mocks.stage.mockRejectedValueOnce(new Error("stage failed"));
    createFile();
    await settle();
    const calls = mocks.stage.mock.calls.length;
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(calls);
  });

  it.each(["unstage", "delete", "switch", "opening", "repository", "dispose"])(
    "cancels pending metadata after %s",
    async (reason) => {
      createFile();
      await settle();
      if (reason === "unstage") publish(file(asset));
      if (reason === "delete") publish(file(asset, "added", "deleted"));
      if (reason === "switch") useProject.setState({ project: { root: "/other", unity: {} } as ProjectInfo });
      if (reason === "opening") {
        useProject.setState({ opening: true, openingPath: "/other" });
        useProject.setState({ opening: false, openingPath: null });
      }
      if (reason === "repository") {
        useVcs.setState({ repo: "/p/other" });
        useVcs.setState({ repo: "/p" });
      }
      if (reason === "dispose") dispose();
      publish(file(asset, "added", null), file(meta));
      await settle();
      expect(mocks.stage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["normal project", "outside Assets", "metadata itself"])("does not pair files in %s", async (reason) => {
    if (reason === "normal project") useProject.setState({ project: { root: "/p" } as ProjectInfo });
    const path = reason === "outside Assets" ? "/p/New.cs" : reason === "metadata itself" ? meta : asset;
    publish(file(path), file(path + ".meta"));
    createFile(path);
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([path]);
  });

  it.each(["modified", "ignored"] as const)("does not stage %s metadata", async (kind) => {
    createFile();
    await settle();
    publish(file(asset, "added", null), file(meta, null, kind));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it("does not repeatedly retry a failed metadata addition", async () => {
    createFile();
    await settle();
    mocks.stage.mockRejectedValueOnce(new Error("index locked"));
    publish(file(asset, "added", null), file(meta));
    await settle();
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "index locked" }));
  });

  it("does not stage files if the project changed while the dialog was open", async () => {
    mocks.ask.mockImplementationOnce(async () => {
      useProject.setState({ project: { root: "/other" } as ProjectInfo });
      return { button: "ok", checked: false };
    });
    createFile();
    await settle();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it.each(["repository", "opening", "dispose"])("discards an open confirmation after %s", async (reason) => {
    mocks.ask.mockImplementationOnce(async () => {
      if (reason === "repository") useVcs.setState({ repo: "/p/nested" });
      if (reason === "opening") useProject.setState({ opening: true, openingPath: "/other" });
      if (reason === "dispose") dispose();
      return { button: "ok", checked: false };
    });
    createFile();
    await settle();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("does not stage a source or metadata staged by the user while the dialog was open", async () => {
    publish(file(asset), file(meta));
    mocks.ask.mockImplementationOnce(async () => {
      publish(file(asset, "added", "modified"), file(meta, "added", "modified"));
      return { button: "ok", checked: false };
    });
    createFile();
    await settle();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("preserves manually staged metadata even when it was explicitly included in the creation event", async () => {
    publish(file(asset), file(meta));
    mocks.ask.mockImplementationOnce(async () => {
      publish(file(asset), file(meta, "added", "modified"));
      return { button: "ok", checked: false };
    });
    notifyFileOperation({ kind: "created", paths: [asset, meta] });
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset]);
    expect(useVcs.getState().status[1]!.unstaged).toBe("modified");
  });

  it.each(["added", "modified", "ignored", "missing"] as const)(
    "rechecks metadata that becomes %s while the dialog is open",
    async (kind) => {
      publish(file(asset), file(meta));
      mocks.ask.mockImplementationOnce(async () => {
        publish(
          file(asset),
          ...(kind === "missing"
            ? []
            : [file(meta, kind === "added" ? "added" : null, kind === "added" ? "modified" : kind)]),
        );
        return { button: "ok", checked: false };
      });
      createFile();
      await settle();
      expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset]);
    },
  );

  it("waits for successful staging before following metadata", async () => {
    let complete!: () => void;
    mocks.stage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ status: "ok", data: null });
        }),
    );
    createFile();
    await settle();
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    complete();
    await settle();
    expect(mocks.stage.mock.calls.map(([paths]) => paths)).toEqual([[asset], [meta]]);
  });

  it("remembers an unstage while the initial staging response is still in flight", async () => {
    let complete!: () => void;
    mocks.stage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ status: "ok", data: null });
        }),
    );
    createFile();
    await settle();
    publish(file(asset, "added", null));
    publish(file(asset));
    publish(file(asset, "added", null), file(meta));
    complete();
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset]);
  });

  it("does not re-add metadata already included in the successful initial operation", async () => {
    publish(file(asset), file(meta));
    let complete!: () => void;
    mocks.stage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ status: "ok", data: null });
        }),
    );
    createFile();
    await settle();
    publish(file(asset, "added", null), file(meta, "added", null));
    publish(file(asset, "added", null), file(meta));
    complete();
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset, meta]);
  });

  it("does not follow metadata after an in-flight addition outlives its project", async () => {
    let complete!: () => void;
    mocks.stage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ status: "ok", data: null });
        }),
    );
    createFile();
    await settle();
    useProject.setState({ opening: true, openingPath: "/other" });
    complete();
    await settle();
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it("ignores incomplete or failed status snapshots", async () => {
    createFile();
    await settle();
    useVcs.setState({ statusLoaded: false });
    publish(file(asset));
    useVcs.setState({ statusLoaded: true, error: "refresh failed" });
    publish(file(asset, "added", "modified"), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    useVcs.setState({ error: null });
    await settle();
    expect(mocks.stage).toHaveBeenLastCalledWith([meta]);
  });

  it("does not cancel an addition when the first refresh discovers the repository", async () => {
    useVcs.setState({ repo: null, roots: [], statusLoaded: false });
    mocks.refresh.mockImplementationOnce(async () => {
      useVcs.setState({ roots: ["/p"], repo: "/p", statusLoaded: true });
    });
    createFile();
    await settle();
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage.mock.calls.map(([paths]) => paths)).toEqual([[asset], [meta]]);
  });

  it("does not stage from a failed pre-addition refresh", async () => {
    mocks.ask.mockImplementationOnce(async () => {
      useVcs.setState({ error: "refresh failed" });
      return { button: "ok", checked: false };
    });
    createFile();
    await settle();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("rechecks the project after the pre-staging promise resolves", async () => {
    mocks.refresh.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => useProject.setState({ opening: true, openingPath: "/other" })));
    });
    createFile();
    await settle();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("does not infer metadata consent for children of a copied directory", async () => {
    createFile("/p/Assets");
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset]);
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it("keeps a batch limited to the explicitly created files", async () => {
    const other = "/p/Assets/Other.cs";
    publish(file(asset), file(meta), file(other), file(`${other}.meta`));
    notifyFileOperation({ kind: "created", paths: [asset, asset] });
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([asset, meta]);
  });

  it.each([
    ["D:/Unity Project", "D:\\Unity Project\\Assets\\New.cs", "D:/Unity Project/Assets/New.cs"],
    ["//server/share/project", "\\\\server\\share\\project\\Assets\\New.cs", "//server/share/project/Assets/New.cs"],
    ["/p", "/p/Assets/Name\\Part.cs", "/p/Assets/Name\\Part.cs"],
    ["/project space", "/project space/Assets/角色.cs", "/project space/Assets/角色.cs"],
  ])("pairs files with native or literal path characters under %s", async (root, input, path) => {
    useProject.setState({ project: { root, unity: {} } as ProjectInfo });
    useVcs.setState({ root, roots: [root], repo: root });
    publish(file(path), file(`${path}.meta`));
    createFile(input);
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([path, `${path}.meta`]);
  });

  it.each(["/p/AssetsOther/New.cs", "/p/Packages/New.cs"])("does not pair %s outside Assets", async (path) => {
    publish(file(path), file(`${path}.meta`));
    createFile(path);
    await settle();
    expect(mocks.stage).toHaveBeenCalledExactlyOnceWith([path]);
  });

  it("does not add files from another project's similarly named path", async () => {
    const other = "/project/Assets/New.cs";
    publish(file(other), file(`${other}.meta`));
    createFile(other);
    await settle();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("cancels metadata when the asset's repository disappears", async () => {
    useVcs.setState({ roots: ["/p", "/p/Assets"] });
    createFile();
    await settle();
    useVcs.setState({ roots: ["/p"] });
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

  it("still cancels other pending additions while metadata staging is in flight", async () => {
    const other = "/p/Assets/Other.cs";
    publish(file(asset), file(other));
    notifyFileOperation({ kind: "created", paths: [asset, other] });
    await settle();
    let complete!: () => void;
    mocks.stage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ status: "ok", data: null });
        }),
    );
    publish(file(asset, "added", null), file(meta), file(other, "added", null));
    await settle();
    publish(file(asset, "added", null), file(meta), file(other));
    publish(file(asset, "added", null), file(meta, "added", null), file(other, "added", null), file(`${other}.meta`));
    complete();
    await settle();
    expect(mocks.stage.mock.calls.map(([paths]) => paths)).toEqual([[asset, other], [meta]]);
  });
});
