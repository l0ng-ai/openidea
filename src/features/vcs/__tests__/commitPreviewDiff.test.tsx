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

import { CommitToolWindow } from "../CommitView";
import { setCommitDiffPreview, useCommit } from "../commitStore";
import { useVcs } from "../store";

/** The splitter between the changes and the preview: the only vertical one in the layout. */
const previewHandle = () =>
  screen.queryAllByRole("separator").find((s) => s.getAttribute("aria-orientation") === "vertical");

const modified = (path: string) => ({
  path,
  relPath: path.slice(3),
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

/** Selects the tree's first file the way a user does, so the tree's own state moves too. */
function selectFirstFile() {
  const tree = screen.getByRole("tree", { name: "Changes" });
  tree.focus();
  fireEvent.keyDown(tree, { key: "Home" });
  fireEvent.keyDown(tree, { key: "ArrowDown" });
}

describe("Commit tool window Preview Diff (#1599)", () => {
  beforeEach(() => {
    localStorage.clear();
    openDiff.mockClear();
    useCommit.setState({ commitDiffPreview: false, selection: [] });
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [] });
  });

  it("offers a Preview Diff toggle in the changes toolbar, off by default", () => {
    render(<CommitToolWindow />);
    const toggle = screen.getByRole("button", { name: "Preview Diff" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("diff-preview")).toBeNull();
  });

  it("shows an embedded diff pane beside the changes when enabled", () => {
    useVcs.setState({ status: [modified("/p/a.ts")] });
    render(<CommitToolWindow />);
    selectFirstFile();
    act(() => setCommitDiffPreview(true));
    // Side by side with the changes: the splitter between the panels is vertical.
    expect(previewHandle()).toBeTruthy();
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/a.ts");
    expect(screen.getByPlaceholderText("Commit Message")).toBeTruthy();
  });

  it("previews the selected file and follows the selection", () => {
    useVcs.setState({ status: ["a.ts", "b.ts"].map((name) => modified(`/p/${name}`)) });
    render(<CommitToolWindow />);
    act(() => setCommitDiffPreview(true));
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
    selectFirstFile();
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/a.ts");
    const tree = screen.getByRole("tree", { name: "Changes" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/b.ts");
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/a.ts");
  });

  it("keeps the files list and the commit message accessible while the preview is open", () => {
    useVcs.setState({ status: [modified("/p/a.ts")] });
    render(<CommitToolWindow />);
    selectFirstFile();
    act(() => setCommitDiffPreview(true));
    expect(screen.getByTestId("diff-preview")).toBeTruthy();
    expect(screen.getByRole("tree", { name: "Changes" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Commit Message")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy();
  });

  it("offers a resize handle between the changes and the preview", () => {
    useVcs.setState({ status: [modified("/p/a.ts")] });
    render(<CommitToolWindow />);
    selectFirstFile();
    act(() => setCommitDiffPreview(true));
    const handle = previewHandle();
    expect(handle).toBeTruthy();
    expect(handle!.getAttribute("aria-valuenow")).not.toBeNull();
    // Resizing moves the boundary and keeps both sides rendered.
    fireEvent.keyDown(handle!, { key: "ArrowLeft" });
    expect(screen.getByTestId("diff-preview")).toBeTruthy();
    expect(screen.getByRole("tree", { name: "Changes" })).toBeTruthy();
  });

  it("hides the pane when disabled and persists the toggle state", () => {
    useVcs.setState({ status: [modified("/p/a.ts")] });
    render(<CommitToolWindow />);
    selectFirstFile();
    const toggle = screen.getByRole("button", { name: "Preview Diff" });
    act(() => toggle.click());
    expect(useCommit.getState().commitDiffPreview).toBe(true);
    expect(localStorage.getItem("openidea.vcs.commitDiffPreview")).toBe("true");
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-path", "/p/a.ts");
    act(() => toggle.click());
    expect(useCommit.getState().commitDiffPreview).toBe(false);
    expect(localStorage.getItem("openidea.vcs.commitDiffPreview")).toBe("false");
    expect(screen.queryByTestId("diff-preview")).toBeNull();
    expect(previewHandle()).toBeUndefined();
    // The tree keeps its selection across the toggling.
    expect(screen.getByText("a.ts").closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
  });

  it("shows an empty state until exactly one file is selected", () => {
    useVcs.setState({ status: ["a.ts", "b.ts"].map((name) => modified(`/p/${name}`)) });
    render(<CommitToolWindow />);
    act(() => setCommitDiffPreview(true));
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
    act(() => useCommit.setState({ selection: ["/p/a.ts", "/p/b.ts"] }));
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
  });

  it("shows an empty state when there are no changes to preview", () => {
    render(<CommitToolWindow />);
    act(() => setCommitDiffPreview(true));
    expect(screen.getByText("No changes to preview")).toBeTruthy();
    expect(screen.queryByTestId("diff-preview")).toBeNull();
  });
});
