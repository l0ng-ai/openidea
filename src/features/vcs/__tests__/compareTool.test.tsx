import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  worktree: vi.fn(),
  openDiff: vi.fn(),
  openFile: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, vcsDiffWithWorktree: mocks.worktree },
  };
});
vi.mock("../diffInput", async (original) => {
  const real = await original<typeof import("../diffInput")>();
  return { ...real, openVcsDiff: mocks.openDiff };
});
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: unknown }) => <div data-testid="diff">{JSON.stringify(input)}</div>,
}));
vi.mock("@/workbench/contributions", async (original) => {
  const real = await original<typeof import("@/workbench/contributions")>();
  return { ...real, maybeEditorService: () => ({ openFile: mocks.openFile }) };
});
import { useProject } from "@/platform/project";
import { comparisonDiffData, type ComparisonFile } from "../operations";
import { CompareToolWindow, useCompareTool } from "../compareTool";
import { useVcs } from "../store";

const modified: ComparisonFile = {
  path: "src/app.ts",
  kind: "modified",
  oldPath: null,
  root: "/workspace/client",
  revision: "aaa",
  added: 3,
  removed: 1,
};
const from = { rev: "main", label: "main" };

describe("comparisonDiffData", () => {
  it("puts the revision on the left and the working tree on the right", () => {
    const data = comparisonDiffData(modified, from, null, false);
    expect(data.path).toBe("/workspace/client/src/app.ts");
    expect(data.left).toEqual({ type: "rev", rev: "aaa", label: "main", path: undefined });
    expect(data.right).toEqual({ type: "worktree" });
  });

  it("swaps both sides, for worktree and revision diffs alike", () => {
    const worktree = comparisonDiffData(modified, from, null, true);
    expect(worktree.left).toEqual({ type: "worktree" });
    expect(worktree.right).toEqual({ type: "rev", rev: "aaa", label: "main", path: undefined });
    const revisions = comparisonDiffData(modified, from, { rev: "feature", label: "feature" }, true);
    expect(revisions.left).toEqual({ type: "rev", rev: "feature", label: "feature" });
    expect(revisions.right).toEqual({ type: "rev", rev: "aaa", label: "main", path: undefined });
  });

  it("keeps the one-sided markers on their file after a swap", () => {
    const added: ComparisonFile = { ...modified, kind: "added", path: "src/new.ts" };
    expect(comparisonDiffData(added, from, null, false).left).toEqual({
      type: "text",
      text: "",
      label: "(does not exist)",
    });
    expect(comparisonDiffData(added, from, null, true).right).toEqual({
      type: "text",
      text: "",
      label: "(does not exist)",
    });
    const deleted: ComparisonFile = { ...modified, kind: "deleted", path: "src/old.ts" };
    expect(comparisonDiffData(deleted, from, null, false).right).toEqual({
      type: "text",
      text: "",
      label: "(deleted)",
    });
    expect(comparisonDiffData(deleted, from, null, true).left).toEqual({
      type: "text",
      text: "",
      label: "(deleted)",
    });
  });
});

describe("CompareToolWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProject.setState({ project: { root: "/workspace", name: "workspace" } as never });
    useVcs.setState({ available: true, root: "/workspace", roots: ["/workspace/client"], repo: "/workspace/client" });
    mocks.worktree.mockResolvedValue({
      status: "ok",
      data: [
        { ...modified, added: 3, removed: 1 },
        { path: "src/new.ts", kind: "added", oldPath: null, root: "/workspace/client", revision: "aaa" },
        { path: "src/old.ts", kind: "deleted", oldPath: null, root: "/workspace/client", revision: "aaa" },
      ],
    });
    useCompareTool.getState().show(from, null);
  });
  afterEach(() => {
    cleanup();
    useCompareTool.getState().close();
    useProject.setState({ project: null });
  });

  it("lists the worktree diff and jumps to the selected source file", async () => {
    render(<CompareToolWindow />);
    const jump = screen.getByRole("button", { name: "Jump to Source" });
    expect(jump).toBeDisabled();
    fireEvent.mouseDown(await screen.findByText("app.ts"), { button: 0 });
    expect(jump).toBeEnabled();
    fireEvent.click(jump);
    expect(mocks.openFile).toHaveBeenCalledWith("/workspace/client/src/app.ts", { focus: true });
  });

  it("lists files without an inline diff and opens a file's diff in the editor", async () => {
    mocks.openDiff.mockResolvedValue(undefined);
    render(<CompareToolWindow />);
    const file = await screen.findByText("app.ts");
    fireEvent.mouseDown(file, { button: 0 });
    expect(screen.queryByTestId("diff")).toBeNull();
    fireEvent.doubleClick(file);
    expect(mocks.openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/workspace/client/src/app.ts" }));
  });

  it("has no Jump to Source for a file deleted from the working tree", async () => {
    render(<CompareToolWindow />);
    fireEvent.mouseDown(await screen.findByText("old.ts"), { button: 0 });
    expect(screen.getByRole("button", { name: "Jump to Source" })).toBeDisabled();
  });

  it("swaps the sides of the shown diff", async () => {
    mocks.openDiff.mockResolvedValue(undefined);
    render(<CompareToolWindow />);
    fireEvent.mouseDown(await screen.findByText("app.ts"), { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Show Diff" }));
    expect(mocks.openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ right: { type: "worktree" } }));
    fireEvent.click(screen.getByRole("button", { name: "Swap Sides" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Diff" }));
    expect(mocks.openDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        left: { type: "worktree" },
        right: expect.objectContaining({ type: "rev", label: "main" }),
      }),
    );
  });
});
