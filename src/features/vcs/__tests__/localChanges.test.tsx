import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

// Writing the View Options settings goes through the backend; the tests set them directly.
vi.mock("../settingsUi", () => ({ saveVcsSetting: vi.fn(async () => undefined) }));

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { path: string } } }) => (
    <div data-testid="diff-preview" data-path={input.data.path} />
  ),
}));

const openDiffDialog = vi.hoisted(() => vi.fn());
vi.mock("../diffDialog", () => ({ openDiffDialog }));

import { ChangesTree, LocalChangesView, nodeMenu, doubleClickMenu, DOUBLE_CLICK_KEY } from "../CommitView";
import { saveVcsSetting } from "../settingsUi";
import type { ChangeNode } from "../changes";
import { setDiffPreview, useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import type { FileStatus, Settings } from "@/bindings";
import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";

/** Editor tabs the diffs open in (openDiff → the editor service). */
const openInput = vi.fn(async () => undefined);
/** The source files double-click opens where the tree shows files (Show on Double-Click). */
const openFile = vi.fn(async () => undefined);
provideEditorService({ openInput, openFile } as never);
/** Settings › Version Control › Commit: "Use non-modal commit interface" unticked. */
const modal = (on: boolean) =>
  useProject.setState({ settings: on ? ({ vcs: { commit: { nonModal: false } } } as Settings) : null });
/** Commit settings with an explicit Show on Double-Click choice (`null` follows the interface). */
const commitSettings = (commit: Record<string, unknown>) =>
  useProject.setState({ settings: { vcs: { commit } } as Settings });
const tabPaths = () => openInput.mock.calls.map((c) => (c as unknown as [{ data: { path: string } }])[0].data.path);

describe("Local Changes diff preview (#710)", () => {
  beforeEach(() => {
    localStorage.clear();
    modal(true);
    openInput.mockClear();
    openFile.mockClear();
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

  it("previews keyboard selection and opens the source file on Enter and double click", async () => {
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
    await vi.waitFor(() => expect(openFile).toHaveBeenLastCalledWith("/p/b.ts", { focus: true }));
    expect(openDiffDialog).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText("a.ts"));
    await vi.waitFor(() => expect(openFile).toHaveBeenLastCalledWith("/p/a.ts", { focus: true }));
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
    openInput.mockClear();
    openFile.mockClear();
    openDiffDialog.mockClear();
    useCommit.setState({ diffPreview: false, selection: [], checks: new Map() });
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [file] });
    useToolWindowLayout.setState({ placements: {} });
  });

  const activate = async () => {
    const row = (await screen.findByText("a.ts")).closest('[role="treeitem"]')!;
    act(() => fireEvent.doubleClick(row));
  };

  it("opens the source file of a double-clicked file with the modal interface", async () => {
    render(<ChangesTree mode="local" />);
    await activate();
    await vi.waitFor(() => expect(openFile.mock.calls).toEqual([["/p/src/a.ts", { focus: true }]]));
    expect(openDiffDialog).not.toHaveBeenCalled();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("opens the diff in front with the modal interface when asked to", async () => {
    commitSettings({ nonModal: false, doubleClickOpensDiff: true });
    render(<ChangesTree mode="local" />);
    await activate();
    await vi.waitFor(() => expect(openDiffDialog).toHaveBeenCalledTimes(1));
    expect(openDiffDialog.mock.calls[0]?.[0]).toMatchObject({ path: "/p/src/a.ts" });
    expect(openFile).not.toHaveBeenCalled();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("opens an editor tab with the non-modal interface", async () => {
    modal(false);
    render(<ChangesTree mode="commit" />);
    await activate();
    await vi.waitFor(() => expect(tabPaths()).toEqual(["/p/src/a.ts"]));
    expect(openInput.mock.calls[0]).toEqual([expect.anything(), { preview: true, focus: true }]);
    expect(openFile).not.toHaveBeenCalled();
    expect(openDiffDialog).not.toHaveBeenCalled();
  });

  it("opens the source file with the non-modal interface when asked to", async () => {
    commitSettings({ nonModal: true, doubleClickOpensDiff: false });
    render(<ChangesTree mode="commit" />);
    await activate();
    await vi.waitFor(() => expect(openFile.mock.calls).toEqual([["/p/src/a.ts", { focus: true }]]));
    expect(openInput).not.toHaveBeenCalled();
    expect(openDiffDialog).not.toHaveBeenCalled();
  });

  it("follows the setting again once it is unset", async () => {
    commitSettings({ nonModal: false, doubleClickOpensDiff: true });
    render(<ChangesTree mode="local" />);
    await activate();
    await vi.waitFor(() => expect(openDiffDialog).toHaveBeenCalledTimes(1));
    act(() => commitSettings({ nonModal: false, doubleClickOpensDiff: null }));
    await activate();
    await vi.waitFor(() => expect(openFile.mock.calls).toEqual([["/p/src/a.ts", { focus: true }]]));
  });

  it("goes by the setting, not by which tree shows the file", async () => {
    modal(false);
    render(<ChangesTree mode="local" />);
    await activate();
    await vi.waitFor(() => expect(tabPaths()).toEqual(["/p/src/a.ts"]));
    expect(openDiffDialog).not.toHaveBeenCalled();
  });

  it.each([
    { label: "source with the modal interface", nonModal: false, doubleClickOpensDiff: undefined, diff: false },
    { label: "diff with the non-modal interface", nonModal: true, doubleClickOpensDiff: undefined, diff: true },
    { label: "diff overriding the modal interface", nonModal: false, doubleClickOpensDiff: true, diff: true },
    { label: "source overriding the non-modal interface", nonModal: true, doubleClickOpensDiff: false, diff: false },
  ])("Enter matches double-click: $label", async ({ nonModal, doubleClickOpensDiff, diff }) => {
    commitSettings({ nonModal, doubleClickOpensDiff });
    render(<ChangesTree mode="local" />);
    const tree = await screen.findByRole("tree", { name: "Changes" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    if (diff) {
      await vi.waitFor(() => expect(nonModal ? openInput : openDiffDialog).toHaveBeenCalledTimes(1));
      expect(openFile).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(openFile.mock.calls).toEqual([["/p/src/a.ts", { focus: true }]]));
      expect(openDiffDialog).not.toHaveBeenCalled();
      expect(openInput).not.toHaveBeenCalled();
    }
  });

  it("opens the Commit dialog's files as a front diff window, whatever Show on Double-Click says", async () => {
    commitSettings({ nonModal: false, doubleClickOpensDiff: false });
    render(<ChangesTree mode="dialog" />);
    await activate();
    await vi.waitFor(() => expect(openDiffDialog).toHaveBeenCalledTimes(1));
    expect(openFile).not.toHaveBeenCalled();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("opens the Show Diff menu item in front with the modal interface", async () => {
    const menu = nodeMenu([node], ["/p"], { roots: [node] });
    const show = menu.find((m) => m.kind !== "separator" && "label" in m && m.label === "Show Diff");
    expect(show && "run" in show).toBe(true);
    (show as { run: () => void }).run();
    await vi.waitFor(() =>
      expect(openDiffDialog).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/src/a.ts" })),
    );
    expect(openFile).not.toHaveBeenCalled();
  });

  // An explicit Show Diff always opens the diff, whatever Show on Double-Click says.
  it("keeps Show Diff in front when Show on Double-Click is Source", async () => {
    commitSettings({ nonModal: false, doubleClickOpensDiff: false });
    const menu = nodeMenu([node], ["/p"], { roots: [node] });
    const show = menu.find((m) => m.kind !== "separator" && "label" in m && m.label === "Show Diff");
    (show as { run: () => void }).run();
    await vi.waitFor(() =>
      expect(openDiffDialog).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/src/a.ts" })),
    );
    expect(openFile).not.toHaveBeenCalled();
  });

  it("keeps the Show Diff action item with the non-modal interface", () => {
    modal(false);
    const menu = nodeMenu([node], ["/p"], { roots: [node] });
    expect(menu).toContainEqual({ kind: "action", action: "vcs.showDiff", arg: "/p/src/a.ts" });
  });
});

describe("View Options › Show on Double-Click", () => {
  const items = (value: boolean | null) => {
    const menu = doubleClickMenu(value);
    const sub = menu.find((m) => m.kind !== "separator" && "label" in m && m.label === "Show on Double-Click");
    return (sub as { submenu: { label?: string; checked?: boolean }[] }).submenu.filter((m) => m.label);
  };

  it.each([
    [null, ["Follow the Interface"]],
    [true, ["Diff"]],
    [false, ["Source"]],
  ] as const)("checks exactly one choice for %s", (value, expected) => {
    expect(
      items(value)
        .filter((m) => m.checked)
        .map((m) => m.label),
    ).toEqual([...expected]);
    expect(items(value)).toHaveLength(3);
  });

  it("writes the choice, and null for Follow the Interface", () => {
    vi.mocked(saveVcsSetting).mockClear();
    for (const [label, value] of [
      ["Follow the Interface", null],
      ["Diff", true],
      ["Source", false],
    ] as const) {
      const item = items(null).find((m) => m.label === label) as { run: () => void };
      item.run();
      expect(saveVcsSetting).toHaveBeenLastCalledWith(DOUBLE_CLICK_KEY, value);
    }
  });
});
