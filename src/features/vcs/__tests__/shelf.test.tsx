import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import type { ShelvedChangeList } from "@/bindings";

const mocks = vi.hoisted(() => ({
  openDiff: vi.fn(),
  execute: vi.fn(),
  ipc: vi.fn(),
  patch: vi.fn(),
  probe: vi.fn(),
  unshelve: vi.fn(),
  shelve: vi.fn(),
}));
vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff: mocks.openDiff,
  openVcsDiff: mocks.openDiff,
}));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.execute,
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: mocks.ipc,
  commands: {
    ...(await original<typeof import("@/platform/ipc")>()).commands,
    vcsShelves: () => Promise.resolve(null),
    vcsShelfDiff: () => Promise.resolve(null),
    fsProbe: mocks.probe,
    vcsShelfPatch: mocks.patch,
    vcsUnshelve: mocks.unshelve,
    vcsShelve: mocks.shelve,
  },
}));
import {
  ShelfPanel,
  copyShelfPatch,
  shelfDiffs,
  shelfTarget,
  shelveSilently,
  showShelfDiff,
  unshelve,
  unshelveSilently,
  useShelf,
} from "../shelf";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useChangelists } from "../changelists";
import { VcsDialogHost } from "../dialogs";
import { ContextMenuHost } from "@/ui";
import { registerVcsActions } from "../actions";
import { registerHistoryActions } from "../historyActions";
import { getAction, isActionKeyEnabled } from "@/platform/actions";
import { intellijWindows } from "@/platform/keymaps/intellij-windows";
import { intellijMacos } from "@/platform/keymaps/intellij-macos";
import { useProject } from "@/platform/project";
import { setContext } from "@/platform/context";

const entry: ShelvedChangeList = {
  id: "work",
  name: "Work",
  timeMs: 0,
  branch: null,
  repo: null,
  files: [
    { path: "a.txt", kind: "modified", oldPath: null },
    { path: "b.txt", kind: "added", oldPath: null },
    { path: "binary.dat", kind: "added", oldPath: null },
  ],
};
const diffs = [
  { path: "a.txt", before: "base", after: "shelved", patch: "a patch" },
  { path: "b.txt", before: "", after: "added", patch: "b patch" },
  { path: "binary.dat", before: null, after: null, patch: "binary patch" },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.patch.mockResolvedValue(null);
  useVcs.setState({ root: "/repo", roots: [], repo: null, available: false, status: [] });
  useCommit.setState({ selectedShelf: "work\u0000a.txt" });
  useShelf.setState({ shelves: [entry], loaded: true, diffs: { work: diffs } });
  mocks.ipc.mockResolvedValueOnce([entry]).mockResolvedValue(diffs);
});
afterEach(cleanup);

describe("shelf scope and diffs", () => {
  it("keeps identical file names from different repositories in the same shelf", () => {
    const paths = ["repoA/src/same.txt", "repoB/src/same.txt"];
    const combined: ShelvedChangeList = {
      ...entry,
      repo: "/project",
      files: paths.map((path) => ({ path, kind: "modified", oldPath: null })),
    };
    useVcs.setState({ root: "/project", roots: ["/project/repoA", "/project/repoB"], repo: "/project/repoA" });
    useShelf.setState({
      shelves: [combined],
      diffs: { work: paths.map((path) => ({ path, before: path, after: path, patch: "" })) },
    });
    expect(shelfDiffs({ id: entry.id }).map((diff) => diff.path)).toEqual(paths.map((path) => `/project/${path}`));
    expect(shelfDiffs({ id: entry.id, path: paths[1] })[0]?.path).toBe("/project/repoB/src/same.txt");
  });

  it("keeps file scope from selection and explicit targets; rejects stale files", () => {
    expect(shelfTarget()).toEqual({ entry, path: "a.txt" });
    expect(shelfTarget({ id: "work", path: "b.txt" })).toEqual({ entry, path: "b.txt" });
    expect(shelfTarget("work")).toEqual({ entry, path: undefined });
    expect(shelfTarget({ id: "work", path: "missing" })).toBeNull();
    expect(shelfTarget({ id: "missing" })).toBeNull();
  });
  it("compares saved sides, keeps binary files out of text diffs, and scopes chains", async () => {
    expect(shelfDiffs({ id: "work" })).toHaveLength(2);
    expect(shelfDiffs({ id: "work", path: "a.txt" })).toMatchObject([
      { path: "/repo/a.txt", left: { type: "text", text: "base" }, right: { type: "text", text: "shelved" } },
    ]);
    expect(shelfDiffs({ id: "work", path: "a.txt" }, true)).toMatchObject([
      { left: { text: "shelved" }, right: { type: "worktree" } },
    ]);
    await showShelfDiff();
    expect(mocks.openDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/repo/a.txt", chain: undefined }),
      { preview: true },
    );
    await showShelfDiff("work", false, true);
    expect(mocks.openDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: expect.arrayContaining([expect.objectContaining({ path: "/repo/b.txt" })]) }),
      { preview: false },
    );
    await showShelfDiff({ id: "work", path: "binary.dat" });
    expect(mocks.openDiff).toHaveBeenCalledTimes(2);
  });
  it("compares shelf content with the live working file and skips missing or binary files", async () => {
    mocks.ipc.mockReset().mockResolvedValue({ binary: false });
    await showShelfDiff({ id: "work", path: "a.txt" }, true);
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        left: expect.objectContaining({ type: "text", text: "shelved" }),
        right: expect.objectContaining({ type: "worktree" }),
      }),
      { preview: true },
    );
    mocks.ipc.mockResolvedValue({ binary: true });
    await showShelfDiff({ id: "work", path: "a.txt" }, true);
    mocks.ipc.mockRejectedValue(new Error("missing"));
    await showShelfDiff({ id: "work", path: "a.txt" }, true);
    expect(mocks.openDiff).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["same root", "/repo", ["/repo"], "/repo", "src/a.txt", "/repo/src/a.txt"],
    ["项目A under a non-git project", "/project", ["/project/项目A"], null, "src/a.txt", "/project/项目A/src/a.txt"],
    [
      "second repo with the same file name",
      "/project",
      ["/project/A", "/project/B"],
      "/project/B",
      "src/a.txt",
      "/project/B/src/a.txt",
    ],
    ["project below the repo", "/repo/subproject", ["/repo"], null, "src/a.txt", "/repo/src/a.txt"],
    [
      "Windows stored separators",
      "C:/project",
      ["C:/project/项目A"],
      "C:/project/项目A",
      "src\\a.txt",
      "C:/project/项目A/src/a.txt",
    ],
  ])("maps saved and local diffs to the owning repo: %s", async (_name, root, roots, repo, path, expected) => {
    useVcs.setState({ root, roots, repo: roots[0] ?? null });
    useShelf.setState({
      shelves: [{ ...entry, repo }],
      diffs: { work: [{ path, before: "base", after: "shelved", patch: "patch" }] },
    });
    expect(shelfDiffs({ id: "work" })[0]?.path).toBe(expected);
    mocks.ipc.mockReset().mockImplementation(async () => {
      if (mocks.probe.mock.lastCall?.[0] !== expected) throw new Error("wrong local file");
      return { binary: false };
    });
    await showShelfDiff({ id: "work" }, true);
    expect(mocks.probe).toHaveBeenLastCalledWith(expected);
    expect(mocks.openDiff).toHaveBeenCalledWith(expect.objectContaining({ path: expected }), { preview: true });
  });
  it("keeps legacy shelves on the primary repo after selecting another repo", () => {
    useVcs.setState({ root: "/project", roots: ["/project/A", "/project/B"], repo: "/project/B" });
    expect(shelfDiffs({ id: "work", path: "a.txt" }, true)[0]?.path).toBe("/project/A/a.txt");
  });
  it.each([
    ["/project", "/project/项目A", "src/a.txt", "项目A/src/a.txt"],
    ["/repo/subproject", "/repo", "src/a.txt", "/repo/src/a.txt"],
    ["C:/project", "C:/project/项目A", "src\\a.txt", "项目A/src/a.txt"],
  ])("assigns unshelved paths to the project changelist from %s", async (root, repo, path, expected) => {
    useVcs.setState({ root, roots: [repo] });
    useChangelists.setState({
      loaded: false,
      state: { lists: [{ id: "target", name: "Target", comment: "" }], active: "target", files: {} },
    });
    mocks.ipc
      .mockReset()
      .mockResolvedValueOnce({ applied: [path], conflicts: [] })
      .mockResolvedValue([]);
    render(<VcsDialogHost />);
    act(() => unshelve({ ...entry, repo }));
    fireEvent.click(screen.getByRole("button", { name: "Unshelve" }));
    await waitFor(() => expect(useChangelists.getState().state.files).toEqual({ [expected]: "target" }));
  });
  it("unshelves only the files left checked, one by one", async () => {
    useChangelists.setState({
      loaded: false,
      state: { lists: [{ id: "target", name: "Target", comment: "" }], active: "target", files: {} },
    });
    mocks.ipc.mockReset().mockResolvedValue({ applied: [], conflicts: [] });
    render(<VcsDialogHost />);
    act(() => unshelve(entry));
    expect(screen.getByRole("tree", { name: "Files to unshelve" })).toBeTruthy();
    expect(screen.getAllByText("Added")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include b.txt" }));
    expect(screen.getByRole("checkbox", { name: "Include repo" })).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(screen.getByRole("button", { name: "Unshelve" }));
    await waitFor(() => expect(mocks.unshelve).toHaveBeenCalledTimes(2));
    expect(mocks.unshelve.mock.calls.map((c) => c[2])).toEqual(["a.txt", "binary.dat"]);
  });
  it("copies only the selected file patch through the scoped patch command", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mocks.ipc.mockReset().mockResolvedValue("selected file patch");
    try {
      await copyShelfPatch(entry, "a.txt");
      expect(mocks.patch).toHaveBeenCalledWith("work", "a.txt", null);
      expect(writeText).toHaveBeenCalledWith("selected file patch");
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
  it("routes the configured Show Diff shortcut to the focused shelf selection", async () => {
    const off = registerVcsActions();
    try {
      const action = getAction("vcs.showDiff")!;
      expect(intellijWindows[action.id]).toEqual(["Ctrl+D"]);
      expect(intellijMacos[action.id]).toEqual(["Meta+D"]);
      expect(isActionKeyEnabled(action, { vcsAvailable: true, shelfFocus: true })).toBe(true);
      expect(isActionKeyEnabled(action, { vcsAvailable: true, editorTextFocus: true })).toBe(false);
      await action.run({ ctx: { shelfFocus: true } });
      expect(mocks.openDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/a.txt" }), { preview: true });
    } finally {
      off();
    }
  });
  it("preserves file targets through selection, menus, toolbar, and activation", async () => {
    render(
      <>
        <ShelfPanel />
        <ContextMenuHost />
      </>,
    );
    await waitFor(() => expect(screen.getByText("Work")).toBeTruthy());
    fireEvent.mouseDown(screen.getByText("Work"), { button: 0 });
    expect(useCommit.getState().selectedShelf).toBe("work");
    const file = await screen.findByText("a.txt");
    fireEvent.mouseDown(file, { button: 0 });
    expect(useCommit.getState().selectedShelf).toBe("work\u0000a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Unshelve…" }));
    expect(mocks.execute).toHaveBeenCalledWith("vcs.unshelve", { id: "work", path: "a.txt" });
    fireEvent.doubleClick(file);
    expect(mocks.execute).toHaveBeenCalledWith("vcs.shelf.showDiff", { id: "work", path: "a.txt" });
    await act(async () => useShelf.setState({ diffs: { work: diffs } }));
    fireEvent.contextMenu(file);
    await screen.findByRole("menuitem", { name: "Copy as Patch to Clipboard" });
    const labels = screen.getAllByRole("menuitem").map((e) => e.textContent);
    for (const label of [
      "Show Diff",
      "Show Diff in a New Tab",
      "Compare with Local",
      "Create Patch…",
      "Copy as Patch to Clipboard",
      "Import Patches…",
      "Delete…",
    ])
      expect(labels.some((s) => s?.includes(label))).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Rename…" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Patch to Clipboard" }));
    expect(mocks.execute).toHaveBeenCalledWith("vcs.shelf.copyPatch", { id: "work", path: "a.txt" });
  });
});

describe("Shelve Silently / Unshelve Silently", () => {
  const change = (path: string) => ({
    path,
    relPath: path,
    staged: null,
    unstaged: "modified" as const,
    renamedFrom: null,
  });
  const lists = (files: Record<string, string> = {}, active = "default") =>
    useChangelists.setState({
      loaded: false,
      state: {
        lists: [
          { id: "default", name: "Changes", comment: "" },
          { id: "work", name: "Work", comment: "" },
        ],
        active,
        files,
      },
    });
  beforeEach(() => {
    mocks.ipc.mockReset().mockImplementation(async (value: unknown) => (await value) ?? []);
    mocks.shelve.mockImplementation(async (name: string, paths: string[]) => ({
      ...entry,
      id: name,
      name,
      files: paths.map((path) => ({ path, kind: "modified", oldPath: null })),
    }));
    mocks.unshelve.mockResolvedValue({ applied: ["a.txt"], conflicts: [] });
    useVcs.setState({
      root: "/repo",
      roots: ["/repo"],
      available: true,
      status: [change("/repo/a.txt"), change("/repo/b.txt"), change("/repo/c.txt")],
    });
    useProject.setState({ settings: {} });
  });

  it("shelves the selected changes without a dialog, one shelf per changelist named after it", async () => {
    lists({ "b.txt": "work" });
    render(<VcsDialogHost />);
    await act(() => shelveSilently(["/repo/a.txt", "/repo/b.txt"]));
    expect(mocks.shelve.mock.calls).toEqual([
      ["Changes", ["/repo/a.txt"]],
      ["Work", ["/repo/b.txt"]],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shelves the active changelist's changes when nothing is selected", async () => {
    lists({ "a.txt": "default", "b.txt": "work", "c.txt": "work" }, "work");
    await shelveSilently();
    expect(mocks.shelve.mock.calls).toEqual([["Work", ["/repo/b.txt", "/repo/c.txt"]]]);
  });

  it("names the shelf like the Shelve dialog when the project has one changelist", async () => {
    useChangelists.setState({
      loaded: false,
      state: { lists: [{ id: "default", name: "Changes", comment: "" }], active: "default", files: {} },
    });
    await shelveSilently(["/repo/a.txt"]);
    expect(mocks.shelve.mock.calls).toEqual([["Uncommitted changes", ["/repo/a.txt"]]]);
  });

  it("shelves nothing when there are no changes", async () => {
    lists();
    useVcs.setState({ status: [] });
    await shelveSilently();
    await shelveSilently(["/repo/missing.txt"]);
    expect(mocks.shelve).not.toHaveBeenCalled();
  });

  it("stops after a shelf fails so later changelists stay in the working tree", async () => {
    lists({ "b.txt": "work" });
    mocks.shelve.mockRejectedValueOnce(new Error("disk full"));
    await shelveSilently(["/repo/a.txt", "/repo/b.txt"]);
    expect(mocks.shelve).toHaveBeenCalledTimes(1);
  });

  it("ignores the Changes tab's selection while another Commit tab is shown", async () => {
    lists();
    const off = registerHistoryActions();
    setContext("activeToolWindow", "commit");
    useCommit.setState({ tab: "stashes", selection: ["/repo/b.txt"] });
    try {
      await getAction("vcs.shelveSilently")!.run({ ctx: {} });
      expect(mocks.shelve).not.toHaveBeenCalled();
      useCommit.setState({ tab: "changes" });
      await getAction("vcs.shelveSilently")!.run({ ctx: {} });
      expect(mocks.shelve.mock.calls).toEqual([["Changes", ["/repo/b.txt"]]]);
    } finally {
      off();
      setContext("activeToolWindow", null);
      useCommit.setState({ tab: "changes", selection: [] });
    }
  });

  it("does nothing for a shelf without files", async () => {
    lists();
    await unshelveSilently({ ...entry, files: [] });
    expect(mocks.unshelve).not.toHaveBeenCalled();
  });

  it("unshelves into the changelist named like the shelf, without a dialog", async () => {
    lists();
    render(<VcsDialogHost />);
    await act(() => unshelveSilently(entry));
    expect(mocks.unshelve).toHaveBeenCalledWith("work", false, null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useChangelists.getState().state.files).toEqual({ "a.txt": "work" });
  });

  it("unshelves into the active changelist when no changelist has the shelf's name", async () => {
    lists({}, "default");
    await unshelveSilently({ ...entry, name: "Experiment" });
    expect(useChangelists.getState().state.files).toEqual({ "a.txt": "default" });
  });

  it("unshelves only the selected file and follows the remove-applied setting", async () => {
    lists();
    useProject.setState({ settings: { vcs: { shelf: { removeApplied: true } } } });
    await unshelveSilently(entry, "b.txt");
    expect(mocks.unshelve.mock.calls).toEqual([["work", true, "b.txt"]]);
  });

  it("binds IDEA's shortcuts to the Commit tool window and the focused Shelf", async () => {
    const off = registerHistoryActions();
    try {
      const shelve = getAction("vcs.shelveSilently")!;
      const unshelveAction = getAction("vcs.unshelveSilently")!;
      expect(intellijWindows[shelve.id]).toEqual(["Ctrl+Shift+H"]);
      expect(intellijMacos[shelve.id]).toEqual(["Meta+Shift+H"]);
      expect(intellijWindows[unshelveAction.id]).toEqual(["Ctrl+Alt+U"]);
      expect(intellijMacos[unshelveAction.id]).toEqual(["Meta+Alt+U"]);
      expect(isActionKeyEnabled(shelve, { vcsAvailable: true, activeToolWindow: "commit" })).toBe(true);
      expect(isActionKeyEnabled(shelve, { vcsAvailable: true, activeToolWindow: "git" })).toBe(true);
      expect(isActionKeyEnabled(shelve, { vcsAvailable: true, activeToolWindow: "commit", shelfFocus: true })).toBe(
        false,
      );
      expect(isActionKeyEnabled(shelve, { vcsAvailable: true, editorTextFocus: true })).toBe(false);
      expect(isActionKeyEnabled(unshelveAction, { vcsAvailable: true, shelfFocus: true })).toBe(true);
      expect(isActionKeyEnabled(unshelveAction, { vcsAvailable: true, editorTextFocus: true })).toBe(false);
      lists();
      await unshelveAction.run({ ctx: {}, arg: { id: "work", path: "a.txt" } });
      expect(mocks.unshelve).toHaveBeenCalledWith("work", false, "a.txt");
    } finally {
      off();
    }
  });
});
