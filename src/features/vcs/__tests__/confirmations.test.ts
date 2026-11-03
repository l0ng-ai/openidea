import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, ProjectInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({ stage: vi.fn(), ask: vi.fn(), refresh: vi.fn(), mode: "ask" }));
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
  return { useVcs: create(() => ({})), refreshNow: mocks.refresh };
});
vi.mock("../ops", () => ({
  runOp: async (_title: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  },
}));

import { notifyFileOperation } from "@/platform/fileOps";
import { useProject } from "@/platform/project";
import { installFileConfirmations } from "../confirmations";
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
  useProject.setState({ project: { root: "/p", unity: {} } as ProjectInfo });
  useVcs.setState({
    available: true,
    root: "/p",
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
    expect(mocks.stage.mock.calls.map(([paths]) => paths)).toEqual([[asset], [meta]]);
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

  it.each(["unstage", "delete", "switch", "dispose"])("cancels pending metadata after %s", async (reason) => {
    createFile();
    await settle();
    if (reason === "unstage") publish(file(asset));
    if (reason === "delete") publish(file(asset, "added", "deleted"));
    if (reason === "switch") useProject.setState({ project: { root: "/other", unity: {} } as ProjectInfo });
    if (reason === "dispose") dispose();
    publish(file(asset, "added", null), file(meta));
    await settle();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
  });

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
});
