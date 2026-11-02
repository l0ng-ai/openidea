import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const backend = vi.hoisted(() => ({ invoke: vi.fn(), hunks: vi.fn(), editorsFor: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: backend.invoke,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsDiffHunks: backend.hunks } };
});
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  editorsFor: backend.editorsFor,
}));

import { useProject } from "@/platform/project";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";
import { generateCommitMessage } from "../commitMessageGeneratorRuntime";

const file: FileStatus = {
  path: "/repo/index.ts",
  relPath: "index.ts",
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({
    project: { root: "/repo", trusted: true } as NonNullable<ReturnType<typeof useProject.getState>["project"]>,
  });
  useVcs.setState({ root: "/repo", roots: ["/repo"], status: [file] });
  useCommit.setState({ message: "draft", checks: new Map(), excludedHunks: new Map() });
  backend.editorsFor.mockReturnValue([]);
  backend.hunks.mockResolvedValue([
    { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "old\n" },
  ]);
  backend.invoke.mockImplementation(async (command: string) => {
    if (command === "vcs_read_commit_revision") return { binary: false, text: "old\n" };
    if (command === "vcs_read_commit_working_file") return { binary: false, text: "new\n" };
    if (command === "vcs_build_partial_patch") return "-old\n+new\n";
    if (command === "plugin_generate_commit_message") return "feat: update";
    throw new Error(`unexpected command ${command}`);
  });
});

describe("commit generator runtime", () => {
  it("sends the selected diff to the chosen provider and fills the message", async () => {
    await generateCommitMessage("pushkin");
    expect(backend.invoke).toHaveBeenCalledWith("plugin_generate_commit_message", {
      pluginId: "pushkin",
      diff: "Repository: /repo\nFile: index.ts (modified)\n-old\n+new\n",
    });
    expect(useCommit.getState().message).toBe("feat: update");
  });
  it("does not send a diff if an excluded hunk becomes stale", async () => {
    useCommit.setState({
      checks: new Map([[file.path, "hunks"]]),
      excludedHunks: new Map([[file.path, new Set(["old-key"])]]),
    });
    await expect(generateCommitMessage("pushkin")).rejects.toThrow("index.ts");
    expect(backend.invoke).not.toHaveBeenCalledWith("plugin_generate_commit_message", expect.anything());
    expect(useCommit.getState().message).toBe("draft");
  });
  it("requires a dirty editor buffer to be saved before generation", async () => {
    backend.editorsFor.mockReturnValue([{ view: { state: { doc: { toString: () => "unsaved changes" } } } }]);
    await expect(generateCommitMessage("pushkin")).rejects.toThrow(/save/i);
    expect(backend.invoke).not.toHaveBeenCalledWith("plugin_generate_commit_message", expect.anything());
    expect(useCommit.getState().message).toBe("draft");
  });
  it("does not send anything when a safe working-tree read rejects a symlink", async () => {
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "vcs_read_commit_revision") return { binary: false, text: "old\n" };
      if (command === "vcs_read_commit_working_file") throw new Error("symbolic links are unsupported");
      throw new Error(`unexpected command ${command}`);
    });
    await expect(generateCommitMessage("pushkin")).rejects.toThrow(/symbolic/i);
    expect(backend.invoke).not.toHaveBeenCalledWith("plugin_generate_commit_message", expect.anything());
  });
  it("does not send anything when a revision is a symbolic link", async () => {
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "vcs_read_commit_revision") throw new Error("symbolic links are unsupported");
      throw new Error(`unexpected command ${command}`);
    });
    await expect(generateCommitMessage("pushkin")).rejects.toThrow(/symbolic/i);
    expect(backend.invoke).not.toHaveBeenCalledWith("plugin_generate_commit_message", expect.anything());
  });
});
