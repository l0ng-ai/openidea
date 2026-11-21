import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  worktree: vi.fn(),
  revisions: vi.fn(),
  presentations: vi.fn(),
  openDiff: vi.fn(),
  openFile: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsDiffWithWorktree: mocks.worktree,
      vcsDiffRevisions: mocks.revisions,
      jvmFilePresentations: mocks.presentations,
    },
  };
});
vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));
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
import { ChangesBetweenDialog, comparisonDiffData, type ComparisonFile } from "../operations";
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

  it("shows Java and Kotlin declarations from the compared repository and skips deleted files", async () => {
    const base = "/workspace/client/src/";
    mocks.worktree.mockResolvedValue({
      status: "ok",
      data: [
        { ...modified, path: "src/PricingRule.java", kind: "renamed", oldPath: "src/Rule.java" },
        { ...modified, path: "src/Order.java" },
        { ...modified, path: "src/OrderTest.java", kind: "added" },
        { ...modified, path: "src/Removed.java", kind: "deleted" },
        { ...modified, path: "src/Pricing.kt" },
        modified,
      ],
    });
    mocks.presentations.mockResolvedValue({
      status: "ok",
      data: [
        { path: base + "PricingRule.java", presentation: { kind: "interface" } },
        { path: base + "Order.java", presentation: { kind: "class" } },
        { path: base + "OrderTest.java", presentation: { kind: "class" } },
        { path: base + "Pricing.kt", presentation: { kind: "object" } },
      ],
    });
    render(<CompareToolWindow />);
    expect(await screen.findByTestId("icon-interface")).toBeInTheDocument();
    expect(screen.getByText("PricingRule.java").previousElementSibling).toBe(screen.getByTestId("icon-interface"));
    expect(screen.getByText("Order.java").previousElementSibling).toBe(screen.getByTestId("icon-class"));
    expect(screen.getByText("OrderTest.java").previousElementSibling).toBe(screen.getByTestId("icon-jvm-test"));
    expect(screen.getByText("Removed.java").previousElementSibling).toBe(screen.getByTestId("icon-file-java"));
    expect(screen.getByText("Pricing.kt").previousElementSibling).toBe(screen.getByTestId("icon-kotlin-object"));
    expect(mocks.presentations.mock.calls.flatMap(([paths]) => paths).sort()).toEqual(
      ["Order.java", "OrderTest.java", "Pricing.kt", "PricingRule.java"].map((name) => base + name),
    );
  });

  it("keeps the file-type icon for a comparison of two revisions", async () => {
    mocks.revisions.mockResolvedValue({ status: "ok", data: [{ ...modified, path: "src/PricingRule.java" }] });
    render(<ChangesBetweenDialog from={from} to={{ rev: "next", label: "next" }} onClose={() => {}} />);
    expect(await screen.findByTestId("icon-file-java")).toBeInTheDocument();
    expect(mocks.presentations).not.toHaveBeenCalled();
  });

  it("opens the selected revision diff from the native comparison toolbar", async () => {
    mocks.revisions.mockResolvedValue({ status: "ok", data: [modified] });
    const onShowDiff = vi.fn();
    const onClose = vi.fn();
    render(
      <ChangesBetweenDialog
        from={from}
        to={{ rev: "next", label: "next" }}
        onClose={onClose}
        onShowDiff={onShowDiff}
        native
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Comparison actions" });
    const showDiff = within(toolbar).getByRole("button", { name: "Show Diff" });
    expect(showDiff).toBeDisabled();
    fireEvent.mouseDown(await screen.findByText("app.ts"), { button: 0 });
    expect(await screen.findByTestId("diff")).toBeInTheDocument();
    expect(showDiff).toBeEnabled();
    fireEvent.click(showDiff);
    expect(onShowDiff).toHaveBeenCalledWith({
      path: "/workspace/client/src/app.ts",
      left: { type: "rev", rev: "main", label: "main", path: undefined },
      right: { type: "rev", rev: "next", label: "next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
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
