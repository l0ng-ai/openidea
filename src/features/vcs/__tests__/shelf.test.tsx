import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import type { ShelvedChangeList } from "@/bindings";

const mocks = vi.hoisted(() => ({ openDiff: vi.fn(), execute: vi.fn(), ipc: vi.fn(), patch: vi.fn() }));
vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff: mocks.openDiff,
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
    fsProbe: () => Promise.resolve(null),
    vcsShelfPatch: mocks.patch,
  },
}));
import { ShelfPanel, copyShelfPatch, shelfDiffs, shelfTarget, showShelfDiff, useShelf } from "../shelf";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";
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
  useVcs.setState({ root: "/repo" });
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
