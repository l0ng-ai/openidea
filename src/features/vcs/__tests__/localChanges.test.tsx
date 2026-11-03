import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { path: string } } }) => (
    <div data-testid="diff-preview" data-path={input.data.path} />
  ),
}));

const openDiff = vi.hoisted(() => vi.fn());
vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff,
}));

import { LocalChangesView } from "../CommitView";
import { setDiffPreview, useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";

describe("Local Changes diff preview (#710)", () => {
  beforeEach(() => {
    localStorage.clear();
    openDiff.mockClear();
    useCommit.setState({ diffPreview: true, selection: [] });
    useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"], status: [] });
    useToolWindowLayout.setState({ placements: {} });
  });

  it("places the preview beside the tree for default bottom docking", () => {
    render(<LocalChangesView />);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  });

  it.each(["left", "right"] as const)("stacks the preview for %s docking and updates when moved", (anchor) => {
    render(<LocalChangesView />);
    act(() => useToolWindowLayout.setState({ placements: { git: { anchor } } }));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
    act(() => useToolWindowLayout.setState({ placements: { git: { anchor: "bottom" } } }));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  });

  it("previews the single selected file's working-tree diff", () => {
    useCommit.setState({ selection: ["/p/src/a.ts"] });
    render(<LocalChangesView />);
    expect(screen.getByTestId("diff-preview").getAttribute("data-path")).toBe("/p/src/a.ts");
  });

  it("shows a placeholder until exactly one file is selected", () => {
    render(<LocalChangesView />);
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
    useCommit.setState({ selection: ["/p/a.ts", "/p/b.ts"] });
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
  });

  it("follows the selection", () => {
    useCommit.setState({ selection: ["/p/a.ts"] });
    render(<LocalChangesView />);
    expect(screen.getByTestId("diff-preview").getAttribute("data-path")).toBe("/p/a.ts");
    act(() => useCommit.setState({ selection: ["/p/b.ts"] }));
    expect(screen.getByTestId("diff-preview").getAttribute("data-path")).toBe("/p/b.ts");
    act(() => useCommit.setState({ selection: [] }));
    expect(screen.queryByTestId("diff-preview")).toBeNull();
  });

  it("previews keyboard selection and opens the full diff on Enter and double click", () => {
    useVcs.setState({
      status: ["a.ts", "b.ts"].map((name) => ({
        path: `/p/${name}`,
        relPath: name,
        staged: null,
        unstaged: "modified" as const,
        renamedFrom: null,
      })),
    });
    render(<LocalChangesView />);
    const tree = screen.getByRole("tree", { name: "Changes" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/a.ts");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/b.ts");
    expect(tree).toHaveFocus();
    expect(openDiff).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/p/b.ts" }), { preview: true });
    fireEvent.doubleClick(screen.getByText("a.ts"));
    expect(openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/p/a.ts" }), { preview: true });
  });

  it("turns off via the View Options toggle, persists, and keeps the tree alone", () => {
    useCommit.setState({ selection: ["/p/a.ts"] });
    render(<LocalChangesView />);
    act(() => setDiffPreview(false));
    expect(useCommit.getState().diffPreview).toBe(false);
    expect(screen.queryByTestId("diff-preview")).toBeNull();
    expect(screen.getByText("No local changes")).toBeTruthy();
    expect(localStorage.getItem("openidea.vcs.diffPreview")).toBe("false");
  });

  it("keeps the tree selection when the preview is toggled off and on", () => {
    useVcs.setState({
      status: ["a.ts", "b.ts"].map((name) => ({
        path: `/p/${name}`,
        relPath: name,
        staged: null,
        unstaged: "modified" as const,
        renamedFrom: null,
      })),
    });
    render(<LocalChangesView />);
    const tree = screen.getByRole("tree", { name: "Changes" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByText("b.ts").closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
    act(() => setDiffPreview(false));
    expect(screen.getByText("b.ts").closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
    act(() => setDiffPreview(true));
    expect(screen.getByText("b.ts").closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/b.ts");
  });
});
