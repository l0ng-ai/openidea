import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import type { ShelvedChangeList } from "@/bindings";

const mocks = vi.hoisted(() => ({ openDiff: vi.fn(), execute: vi.fn(), ipc: vi.fn(), patch: vi.fn(), probe: vi.fn() }));
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
    vcsUnshelve: () => Promise.resolve(null),
  },
}));
import { ShelfPanel, copyShelfPatch, shelfDiffs, shelfTarget, showShelfDiff, unshelve, useShelf } from "../shelf";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useChangelists } from "../changelists";
import { VcsDialogHost } from "../dialogs";
import { ContextMenuHost } from "@/ui";
import { registerVcsActions } from "../actions";
import { getAction, isActionKeyEnabled } from "@/platform/actions";
import { intellijWindows } from "@/platform/keymaps/intellij-windows";
import { intellijMacos } from "@/platform/keymaps/intellij-macos";

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
  it("copies only the selected file patch through the scoped patch command", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mocks.ipc.mockReset().mockResolvedValue("selected file patch");
    try {
      await copyShelfPatch(entry, "a.txt");
      expect(mocks.patch).toHaveBeenCalledWith("work", "a.txt");
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
    fireEvent.doubleClick(screen.getByText("Work"));
    // Expand explicitly through the accessible tree keyboard navigation.
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    const file = await screen.findByText("a.txt");
    fireEvent.click(file);
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
