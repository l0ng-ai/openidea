import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { provideEditorService, registerProjectViewRoot, type EditorService } from "@/workbench/contributions";
import { activate } from "./index";
import { setOsClipboardForTests } from "./clipboard";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { MessagesHost } from "@/workbench/messages";
import { FileRefactorDialogHost } from "./FileRefactorDialogs";
import { setRefactorBackendForTests } from "./fileRefactor";
import { ProjectView } from "./ProjectView";
import { beginNew, canPaste } from "./operations";
import { initProjectTree, setViewOption, useProjectTree } from "./store";
import type { OutlineItem } from "@/bindings";
import { _emitEditorEvent } from "@/editor/api";
import { loadOutline } from "./store";

const ipc = vi.hoisted(() => ({
  docOpen: vi.fn(),
  docClose: vi.fn(),
  docOutline: vi.fn(),
}));
vi.mock("@/bindings", async (orig) => {
  const real = await orig<typeof import("@/bindings")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const item = (name: string, kind: OutlineItem["kind"], line: number, children: OutlineItem[] = []): OutlineItem => {
  const r = { start: { line, col: 0 }, end: { line, col: 1 } };
  return { name, kind, detail: null, range: r, selection_range: r, children };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

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
  const row = (label: string) =>
    within(tree)
      .getAllByRole("treeitem")
      .find((r) => r.textContent?.startsWith(label))!;
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
      setFiles: async () => false,
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

  it("clears cut dimming and disables Paste on focus after the OS clipboard becomes text", async () => {
    let files: string[] = [];
    setOsClipboardForTests({
      files: async () => files,
      hasFiles: async () => files.length > 0,
      setFiles: async (paths) => {
        files = paths;
        return true;
      },
    });
    try {
      const { tree, row, rows } = setup();
      await waitFor(() => expect(rows()).toContain("README.md"));
      fireEvent.mouseDown(row("README.md"));
      tree.focus();
      fireEvent.keyDown(tree, { key: "x", code: "KeyX", metaKey: true });
      const content = row("README.md").querySelector("[data-project-path]")!;
      expect(content.className).toMatch(/cut/);
      await act(async () => {
        await useProjectTree.getState().clipboard?.osWrite;
      });
      files = [];
      fireEvent.focus(window);
      await waitFor(() => expect(content.className).not.toMatch(/cut/));
      expect(useProjectTree.getState().clipboard).toBeNull();
      expect(canPaste()).toBe(false);
      fireEvent.keyDown(tree, { key: "v", code: "KeyV", metaKey: true });
      expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Move" })).toBeNull();
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

  it("expands and collapses folders on single click only when enabled", async () => {
    const { row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    const src = () => row("src").querySelector("[data-project-path]")!;
    const click = (detail = 1, init: MouseEventInit = {}) => {
      fireEvent.mouseDown(row("src"), { detail, ...init });
      fireEvent.click(src(), { detail, ...init });
    };
    click();
    expect(rows()).not.toContain("App.kt");

    act(() => setViewOption("singleClickExpand", true));
    click();
    await waitFor(() => expect(rows()).toContain("App.kt"));
    click();
    expect(rows()).not.toContain("App.kt");

    // A double click toggles once: the second click and the dblclick are ignored.
    click(1);
    click(2);
    fireEvent.doubleClick(src());
    await waitFor(() => expect(rows()).toContain("App.kt"));

    // Modifier clicks only change the selection.
    fireEvent.mouseDown(row("README.md"));
    click(1, { metaKey: true });
    expect(useProjectTree.getState().selected).toEqual(new Set(["/w/acme/README.md", "/w/acme/src"]));
    click(1, { shiftKey: true });
    expect(rows()).toContain("App.kt");
    act(() => setViewOption("singleClickExpand", false));
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

  it("publishes the selected folder or file parent only while the tree has focus", async () => {
    const { tree, row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    fireEvent.mouseDown(row("src"));
    tree.focus();
    expect(getContext().focusedDirectory).toBe(`${ROOT}/src`);
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(rows()).toContain("App.kt"));
    fireEvent.mouseDown(row("App.kt"));
    expect(getContext().focusedDirectory).toBe(`${ROOT}/src`);
    fireEvent.mouseDown(row("README.md"));
    expect(getContext().focusedDirectory).toBe(ROOT);
    fireEvent.blur(tree);
    expect(getContext().focusedDirectory).toBeUndefined();
  });

  it("publishes Scratches paths through the same Project tree", async () => {
    fs.nodes.set("/scratches", { kind: "dir" });
    fs.nodes.set("/scratches/note.txt", { kind: "file", size: 0 });
    const remove = registerProjectViewRoot({
      id: "scratch-test",
      path: "/scratches",
      label: "Scratches",
      icon: "scratches",
      scope: "scratches",
    });
    try {
      const { tree, row, rows } = setup();
      await waitFor(() => expect(rows()).toContain("Scratches"));
      fireEvent.mouseDown(row("Scratches"));
      tree.focus();
      expect(getContext().focusedDirectory).toBe("/scratches");
      fireEvent.keyDown(tree, { key: "ArrowRight" });
      await waitFor(() => expect(rows()).toContain("note.txt"));
      fireEvent.mouseDown(row("note.txt"));
      expect(getContext().focusedDirectory).toBe("/scratches");
    } finally {
      act(() => remove());
    }
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
    await waitFor(() =>
      expect(rows()).toEqual(["acme/w/acme", "build", "src", "App.kt", "New.kt", "Util.kt", "README.md"]),
    );
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

describe("Show Members", () => {
  const APP = "/w/acme/src/App.kt";

  const expand = (tree: HTMLElement, label: string, row: (l: string) => HTMLElement) => {
    fireEvent.mouseDown(row(label));
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowRight" });
  };

  it("shows a file's members and opens the symbol on double click", async () => {
    ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
    ipc.docClose.mockResolvedValue(ok(null));
    ipc.docOutline.mockResolvedValue(
      ok([item("App", "class", 0, [item("render", "method", 4)]), item("main", "function", 10)]),
    );
    const { tree, row, rows } = setup();
    act(() => useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src"]) }));
    await waitFor(() => expect(rows()).toContain("App.kt"));
    act(() => setViewOption("showMembers", true));
    expand(tree, "App.kt", row);
    await waitFor(() => expect(rows()).toContain("main"));
    expect(rows()).toEqual(expect.arrayContaining(["App.kt", "App", "main"]));

    // Nested members appear when the member row itself is expanded.
    const appMember = within(tree)
      .getAllByRole("treeitem")
      .find((r) => r.textContent === "App")!;
    fireEvent.mouseDown(appMember);
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(rows()).toContain("render"));

    // Activating a member jumps to its declaration, not the file row.
    fireEvent.doubleClick(row("main"));
    const [path, opts] = openFile.mock.calls.at(-1)!;
    expect(path).toBe(APP);
    expect(opts).toMatchObject({ focus: true, selection: { line: 10, col: 0 } });
  });

  it("restores the tree as left: a collapsed root and folders outside the project", () => {
    const outside = ["\u0000group:gradleGroup:Shop", "/w/billing", "/w/billing/modules/core"];
    localStorage.setItem(`openidea.projectTree.expanded:${ROOT}`, JSON.stringify(outside));
    initProjectTree(ROOT, "acme");
    expect([...useProjectTree.getState().expanded]).toEqual(outside);
    localStorage.removeItem(`openidea.projectTree.expanded:${ROOT}`);
    initProjectTree(ROOT, "acme");
    expect([...useProjectTree.getState().expanded]).toEqual([ROOT]);
  });

  it.each([true, false])(
    "loads restored expanded files when Show Members becomes enabled (initially %s)",
    async (enabled) => {
      ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
      ipc.docClose.mockResolvedValue(ok(null));
      ipc.docOutline.mockResolvedValue(ok([item("restored", "function", 3)]));
      localStorage.setItem(`openidea.projectTree.expanded:${ROOT}`, JSON.stringify([ROOT, "/w/acme/src", APP]));
      initProjectTree(ROOT, "acme");
      setViewOption("showMembers", enabled);
      ipc.docOutline.mockClear();
      const { rows, row, tree } = setup();
      await waitFor(() => expect(rows()).toContain("App.kt"));
      if (!enabled) {
        expect(rows()).not.toContain("Loading…");
        expect(row("App.kt")).not.toHaveAttribute("aria-expanded");
        expect(ipc.docOutline).not.toHaveBeenCalled();
        act(() => setViewOption("showMembers", true));
      }
      await waitFor(() => expect(rows()).toContain("restored"));
      expect(ipc.docOutline).toHaveBeenCalledTimes(1);
      fireEvent.mouseDown(row("restored"));
      tree.focus();
      fireEvent.keyDown(tree, { key: "Enter" });
      expect(openFile).toHaveBeenLastCalledWith(
        APP,
        expect.objectContaining({ focus: true, selection: expect.objectContaining({ line: 3 }) }),
      );
      act(() => setViewOption("showMembers", false));
      expect(rows()).not.toContain("restored");
      expect(rows()).not.toContain("Loading…");
      expect(ipc.docOutline).toHaveBeenCalledTimes(1);
    },
  );

  it("honours member single-click options and double-click focus", async () => {
    ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
    ipc.docClose.mockResolvedValue(ok(null));
    ipc.docOutline.mockResolvedValue(ok([item("main", "function", 10)]));
    const { rows, row } = setup();
    act(() => {
      setViewOption("showMembers", true);
      setViewOption("autoscrollToSource", false);
      setViewOption("singleClickOpen", false);
      setViewOption("previewTab", false);
      useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src", APP]) });
    });
    await waitFor(() => expect(rows()).toContain("main"));
    const content = () => row("main").querySelector("[data-project-key]")!;
    fireEvent.click(content(), { detail: 1 });
    expect(openFile).not.toHaveBeenCalled();
    act(() => setViewOption("previewTab", true));
    fireEvent.click(content(), { detail: 1 });
    expect(openFile).toHaveBeenLastCalledWith(
      APP,
      expect.objectContaining({ preview: true, focus: false, selection: expect.objectContaining({ line: 10 }) }),
    );
    act(() => setViewOption("singleClickOpen", true));
    fireEvent.click(content(), { detail: 1 });
    expect(openFile).toHaveBeenLastCalledWith(
      APP,
      expect.objectContaining({ preview: undefined, focus: false, selection: expect.objectContaining({ line: 10 }) }),
    );
    openFile.mockClear();
    fireEvent.click(content(), { detail: 1, metaKey: true });
    fireEvent.click(content(), { detail: 2 });
    expect(openFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(content());
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenLastCalledWith(
      APP,
      expect.objectContaining({ focus: true, selection: expect.objectContaining({ line: 10 }) }),
    );
  });

  it("refreshes once per editor save and defers collapsed or disabled outlines", async () => {
    ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
    ipc.docClose.mockResolvedValue(ok(null));
    ipc.docOutline.mockResolvedValue(ok([item("main", "function", 0)]));
    const { rows } = setup();
    act(() => {
      setViewOption("showMembers", true);
      useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src", APP]) });
    });
    await waitFor(() => expect(rows()).toContain("main"));
    ipc.docOutline.mockClear();
    ipc.docOutline.mockResolvedValue(ok([item("saved", "function", 5)]));
    act(() => _emitEditorEvent({ type: "docSaved", doc: 7, path: APP }));
    await waitFor(() => expect(rows()).toContain("saved"));
    expect(ipc.docOutline).toHaveBeenCalledTimes(1);
    act(() => useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src"]) }));
    act(() => _emitEditorEvent({ type: "docSaved", doc: 7, path: APP }));
    expect(useProjectTree.getState().outlines.has(APP)).toBe(false);
    expect(ipc.docOutline).toHaveBeenCalledTimes(1);
    act(() => useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src", APP]) }));
    await waitFor(() => expect(rows()).toContain("saved"));
    expect(ipc.docOutline).toHaveBeenCalledTimes(2);
    act(() => setViewOption("showMembers", false));
    act(() => _emitEditorEvent({ type: "docSaved", doc: 7, path: APP }));
    expect(useProjectTree.getState().outlines.has(APP)).toBe(false);
    expect(ipc.docOutline).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("discards an outline invalidated during loading (old request fails: %s)", async (fail) => {
    ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
    ipc.docClose.mockResolvedValue(ok(null));
    const old = deferred<ReturnType<typeof ok<OutlineItem[]>>>();
    const fresh = deferred<ReturnType<typeof ok<OutlineItem[]>>>();
    ipc.docOutline.mockClear();
    ipc.docOutline.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { rows } = setup();
    act(() => {
      setViewOption("showMembers", true);
      useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src", APP]) });
    });
    await waitFor(() => expect(ipc.docOutline).toHaveBeenCalledTimes(1));
    act(() => _emitEditorEvent({ type: "docSaved", doc: 7, path: APP }));
    await waitFor(() => expect(ipc.docOutline).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (fail) old.reject(new Error("stale failure"));
      else old.resolve(ok([item("stale", "function", 0)]));
    });
    expect(useProjectTree.getState().outlines.has(APP)).toBe(false);
    // Completing the obsolete request must not remove the new request's dedupe entry.
    let pending: Promise<void>;
    act(() => {
      pending = loadOutline(APP);
    });
    expect(ipc.docOutline).toHaveBeenCalledTimes(2);
    await act(async () => {
      fresh.resolve(ok([item("fresh", "function", 1)]));
      await pending;
    });
    await waitFor(() => expect(rows()).toContain("fresh"));
    expect(rows()).not.toContain("stale");
    expect(ipc.docOutline).toHaveBeenCalledTimes(2);
  });

  it("collapses a file whose members cannot be read", async () => {
    ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
    ipc.docClose.mockResolvedValue(ok(null));
    ipc.docOutline.mockRejectedValue(new Error("unsupported"));
    const { tree, row, rows } = setup();
    await waitFor(() => expect(rows()).toContain("README.md"));
    act(() => setViewOption("showMembers", true));
    const chevron = () => row("README.md").querySelector("[data-tree-toggle]")!;
    expect(chevron().hasChildNodes()).toBe(true);
    expand(tree, "README.md", row);
    await waitFor(() => expect(chevron().hasChildNodes()).toBe(false));
    expect(rows()).not.toContain("main");
  });

  it("refreshes members when the file changes on disk", async () => {
    ipc.docOpen.mockResolvedValue(ok({ id: 7 }));
    ipc.docClose.mockResolvedValue(ok(null));
    ipc.docOutline.mockResolvedValue(ok([item("main", "function", 0)]));
    const { tree, row, rows } = setup();
    act(() => useProjectTree.setState({ expanded: new Set([ROOT, "/w/acme/src"]) }));
    await waitFor(() => expect(rows()).toContain("App.kt"));
    act(() => setViewOption("showMembers", true));
    expand(tree, "App.kt", row);
    await waitFor(() => expect(rows()).toContain("main"));

    ipc.docOutline.mockClear();
    ipc.docOutline.mockResolvedValue(ok([item("main", "function", 0), item("helper", "function", 5)]));
    // An unrelated change keeps the cached outline.
    await act(() => fs.createFile("/w/acme/src/New.kt"));
    expect(ipc.docOutline).not.toHaveBeenCalled();
    // Modifying the file itself drops the cache and refetches while expanded.
    await act(async () => void fs.onChange?.({ created: [], modified: [APP], removed: [] }));
    await waitFor(() => expect(rows()).toContain("helper"));
  });
});

it("renders workspace member roots with their own paths, without the settings directory", async () => {
  fs = new MemoryFs({ "/z/first.txt": "", "/a/second.txt": "", "/workspace/.openidea/workspace.json": "{}" });
  setProjectFsForTests(fs, "/workspace");
  initProjectTree("/workspace", "Workspace", ["/z", "/a"]);
  const { rows } = setup();
  await waitFor(() => expect(rows()).toEqual(["z/z", "first.txt", "a/a", "second.txt"]));
});
