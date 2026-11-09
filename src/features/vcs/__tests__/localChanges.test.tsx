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

const openDiffDialog = vi.hoisted(() => vi.fn());
vi.mock("../diffDialog", () => ({ openDiffDialog }));

import { ChangesTree, LocalChangesView, nodeMenu } from "../CommitView";
import type { ChangeNode } from "../changes";
import { setDiffPreview, useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import type { FileStatus, Settings } from "@/bindings";
import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";

/** Editor tabs the diffs open in (openDiff → the editor service). */
const openInput = vi.fn(async () => undefined);
provideEditorService({ openInput } as never);
/** Settings › Version Control › Commit: "Use non-modal commit interface" unticked. */
const modal = (on: boolean) =>
  useProject.setState({ settings: on ? ({ vcs: { commit: { nonModal: false } } } as Settings) : null });
const tabPaths = () => openInput.mock.calls.map((c) => (c as unknown as [{ data: { path: string } }])[0].data.path);

describe("Local Changes diff preview (#710)", () => {
  beforeEach(() => {
    localStorage.clear();
    modal(true);
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

  it("previews keyboard selection and opens the diff window on Enter and double click", async () => {
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
    expect(openInput).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: "Enter" });
    await vi.waitFor(() =>
      expect(openDiffDialog).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/p/b.ts" })),
    );
    fireEvent.doubleClick(screen.getByText("a.ts"));
    await vi.waitFor(() =>
      expect(openDiffDialog).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/p/a.ts" })),
    );
    expect(openInput).not.toHaveBeenCalled();
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

describe("Changes tree diffs follow the commit interface setting (#1863)", () => {
  const file: FileStatus = {
    path: "/p/src/a.ts",
    relPath: "src/a.ts",
    staged: null,
    unstaged: "modified",
    renamedFrom: null,
  };
  const node: ChangeNode = {
    key: file.path,
    type: "file",
    label: "src/a.ts",
    group: "changes",
    files: [file],
    path: file.path,
  };

  beforeEach(() => {
    localStorage.clear();
    modal(true);
    useCommit.setState({ diffPreview: false, selection: [], checks: new Map() });
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [file] });
    useToolWindowLayout.setState({ placements: {} });
  });

  const activate = async () => {
    const row = (await screen.findByText("a.ts")).closest('[role="treeitem"]')!;
    act(() => fireEvent.doubleClick(row));
  };

  it("opens the diff of a double-clicked file in front with the modal interface", async () => {
    render(<ChangesTree mode="local" />);
    await activate();
    await vi.waitFor(() => expect(openDiffDialog).toHaveBeenCalledTimes(1));
    expect(openDiffDialog.mock.calls[0]?.[0]).toMatchObject({ path: "/p/src/a.ts" });
    expect(openInput).not.toHaveBeenCalled();
  });

  it("opens an editor tab with the non-modal interface", async () => {
    modal(false);
    render(<ChangesTree mode="commit" />);
    await activate();
    await vi.waitFor(() => expect(tabPaths()).toEqual(["/p/src/a.ts"]));
    expect(openInput.mock.calls[0]).toEqual([expect.anything(), { preview: true, focus: true }]);
    expect(openDiffDialog).not.toHaveBeenCalled();
  });

  it("goes by the setting, not by which tree shows the file", async () => {
    modal(false);
    render(<ChangesTree mode="local" />);
    await activate();
    await vi.waitFor(() => expect(tabPaths()).toEqual(["/p/src/a.ts"]));
    expect(openDiffDialog).not.toHaveBeenCalled();
  });

  it("opens the Show Diff menu item in front with the modal interface", async () => {
    const menu = nodeMenu([node], ["/p"], { roots: [node] });
    const show = menu.find((m) => m.kind !== "separator" && "label" in m && m.label === "Show Diff");
    expect(show && "run" in show).toBe(true);
    (show as { run: () => void }).run();
    await vi.waitFor(() =>
      expect(openDiffDialog).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/src/a.ts" })),
    );
  });

  it("keeps the Show Diff action item with the non-modal interface", () => {
    modal(false);
    const menu = nodeMenu([node], ["/p"], { roots: [node] });
    expect(menu).toContainEqual({ kind: "action", action: "vcs.showDiff", arg: "/p/src/a.ts" });
  });
});
