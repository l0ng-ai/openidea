import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import { activate } from "./index";
import { setOsClipboardForTests } from "./clipboard";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { MessagesHost } from "@/workbench/messages";
import { FileRefactorDialogHost } from "./FileRefactorDialogs";
import { setRefactorBackendForTests } from "./fileRefactor";
import { ProjectView } from "./ProjectView";
import { beginNew } from "./operations";
import { initProjectTree, setViewOption, useProjectTree } from "./store";

const ROOT = "/w/acme";
let fs: MemoryFs;
let openFile: ReturnType<typeof vi.fn>;
let dispose: () => void;

beforeEach(() => {
  localStorage.clear();
  fs = new MemoryFs(
    {
      "/w/acme/src/App.kt": "x",
      "/w/acme/src/Util.kt": "x",
      "/w/acme/build/out.class": "x",
      "/w/acme/README.md": "x",
    },
    ROOT,
  );
  fs.ignored.add("/w/acme/build");
  fs.onChange = (e) => queueMicrotask(() => emitLocalIdeEvent({ type: "fsChanged", ...e }));
  setProjectFsForTests(fs, ROOT);
  setRefactorBackendForTests(null);
  openFile = vi.fn(async () => {});
  provideEditorService({ openFile, activePath: () => null } as unknown as EditorService);
  dispose = activate();
  initProjectTree(ROOT, "acme");
});

afterEach(() => {
  dispose();
  setProjectFsForTests(null);
});

function setup() {
  render(
    <>
      <ProjectView />
      <MessagesHost />
      <FileRefactorDialogHost />
    </>,
  );
  const tree = screen.getByRole("tree", { name: "Project" });
  const rows = () =>
    within(tree)
      .queryAllByRole("treeitem")
      .map((r) => r.textContent);
  const row = (label: string) => within(tree).getAllByRole("treeitem").find((r) => r.textContent?.startsWith(label))!;
  return { tree, rows, row };
}

describe("ProjectView", () => {
  it("shows the root with its path and loads children lazily", async () => {
    const { rows, row, tree } = setup();
    await waitFor(() => expect(rows()).toEqual(["acme/w/acme", "build", "src", "README.md"]));
    expect(row("build").querySelector("[class*=excluded]")).not.toBeNull();
    fireEvent.mouseDown(row("src"));
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(rows()).toEqual(["acme/w/acme", "build", "src", "App.kt", "Util.kt", "README.md"]));
  });

  it("pastes the files Explorer copied into the selected folder, as copies", async () => {
    // What Explorer leaves on the clipboard: a path outside the project.
    fs.nodes.set("/elsewhere/Photo.png", { kind: "file", size: 3 });
    setOsClipboardForTests({
      files: async () => ["/elsewhere/Photo.png"],
      hasFiles: async () => true,
      setFiles: async () => {},
    });
    try {
      const { tree, row, rows } = setup();
      await waitFor(() => expect(rows()).toContain("README.md"));
      fireEvent.mouseDown(row("src"));
      tree.focus();
      // ⌘ is the primary modifier here, as in the undo test below.
      fireEvent.keyDown(tree, { key: "v", code: "KeyV", metaKey: true });
      await waitFor(() => expect(fs.nodes.has("/w/acme/src/Photo.png")).toBe(true));
      // A copy, not a move: the dropped-from path stays where it was.
      expect(fs.nodes.has("/elsewhere/Photo.png")).toBe(true);
    } finally {
      setOsClipboardForTests(null);
    }
  });

  it("opens files on double click and previews on single click only when enabled", async () => {
    const { row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    const content = row("README.md").querySelector("[data-project-path]")!;
    fireEvent.click(content, { detail: 1 });
    expect(openFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(row("README.md"));
    expect(openFile).toHaveBeenLastCalledWith("/w/acme/README.md", { preview: undefined, focus: true });
    act(() => setViewOption("previewTab", true));
    fireEvent.click(content, { detail: 1 });
    expect(openFile).toHaveBeenLastCalledWith("/w/acme/README.md", { preview: true, focus: false });
    act(() => setViewOption("previewTab", false));
  });

  it("cancels a new file when its name field loses focus", async () => {
    const { rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    await act(() => beginNew("file", ROOT));
    const input = await screen.findByRole("textbox", { name: "New file name" });
    fireEvent.change(input, { target: { value: "Notes.md" } });
    await act(async () => void fireEvent.blur(input));
    expect(useProjectTree.getState().editing).toBeNull();
    expect(fs.nodes.has("/w/acme/Notes.md")).toBe(false);
  });

  it("publishes the focus context key", async () => {
    const { tree, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    fireEvent.focus(tree);
    expect(getContext().projectViewFocus).toBe(true);
    fireEvent.blur(tree);
    expect(getContext().projectViewFocus).toBe(false);
  });

  it("renames in IDEA's Rename dialog with Shift+F6, validating conflicts, and undoes with ⌘Z", async () => {
    const { tree, row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    fireEvent.mouseDown(row("README.md"));
    tree.focus();
    fireEvent.keyDown(tree, { key: "F6", code: "F6", shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    expect(dialog).toHaveTextContent("Rename file 'README.md' and its usages to:");
    expect(within(dialog).getByRole("checkbox", { name: "Search for references" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Search in comments and strings" })).toBeInTheDocument();
    const input = within(dialog).getByRole("textbox", { name: "New name" });
    await waitFor(() => expect((input as HTMLInputElement).selectionEnd).toBe("README".length));
    fireEvent.change(input, { target: { value: "src" } });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("'src' already exists");
    expect(within(dialog).getByRole("button", { name: "Refactor" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "GUIDE.md" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refactor" }));
    await waitFor(() => expect(rows()).toContain("GUIDE.md"));
    expect(fs.nodes.has("/w/acme/GUIDE.md")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Rename" })).toBeNull();

    // ⌘Z in the project view undoes the rename.
    tree.focus();
    fireEvent.keyDown(tree, { key: "z", code: "KeyZ", metaKey: true });
    await waitFor(() => expect(fs.nodes.has("/w/acme/README.md")).toBe(true));
    expect(fs.nodes.has("/w/acme/GUIDE.md")).toBe(false);
  });

  it("moves with F6 through the Move dialog", async () => {
    const { tree, row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    fireEvent.mouseDown(row("README.md"));
    tree.focus();
    fireEvent.keyDown(tree, { key: "F6", code: "F6" });
    const dialog = await screen.findByRole("dialog", { name: "Move" });
    expect(dialog).toHaveTextContent("Move file 'README.md'");
    expect(within(dialog).getByRole("checkbox", { name: "Open moved files in editor" })).toBeInTheDocument();
    const target = within(dialog).getByRole("textbox", { name: "Target directory" });
    expect(target).toHaveValue(ROOT);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Already in this directory");
    fireEvent.change(target, { target: { value: "src" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refactor" }));
    await waitFor(() => expect(fs.nodes.has("/w/acme/src/README.md")).toBe(true));
    expect(fs.nodes.has("/w/acme/README.md")).toBe(false);
  });

  it("deletes the selection after confirmation", async () => {
    const { tree, row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    fireEvent.mouseDown(row("README.md"));
    tree.focus();
    fireEvent.keyDown(tree, { key: "Delete", code: "Delete" });
    const dialog = await screen.findByRole("dialog", { name: "Delete" });
    expect(dialog).toHaveTextContent("Delete 'README.md'?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rows()).not.toContain("README.md"));
    expect(fs.nodes.has("/w/acme/README.md")).toBe(false);
  });

  it("refreshes from fsChanged events keeping expansion", async () => {
    const { rows } = setup();
    act(() => useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src"]) }));
    await waitFor(() => expect(rows()).toContain("App.kt"));
    await act(() => fs.createFile("/w/acme/src/New.kt"));
    await waitFor(() => expect(rows()).toEqual(["acme/w/acme", "build", "src", "App.kt", "New.kt", "Util.kt", "README.md"]));
  });

  it("renders large folders virtualized", async () => {
    for (let i = 0; i < 10_000; i++) fs.nodes.set(`/w/acme/big/f${i}.txt`, { kind: "file", size: 1 });
    fs.nodes.set("/w/acme/big", { kind: "dir" });
    const { tree } = setup();
    act(() => useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/big"]) }));
    await waitFor(() => expect(useProjectTree.getState().listings.get("/w/acme/big")?.length).toBe(10_000));
    const rendered = within(tree).getAllByRole("treeitem").length;
    expect(rendered).toBeLessThan(80);
  });
});
