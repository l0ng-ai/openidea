import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyFilesMoved, pendingFileMoves, trackFileMove } from "@/platform/fileOps";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { activate } from "../index";
import { loadBookmarks, updateBookmarkData, useBookmarks, type BookmarkData } from "../bookmarks/store";

const root = "C:/project";
const bookmark = {
  path: `${root}/docs/nested/notes.txt`,
  line: 2,
  text: "review this line",
  mnemonic: "7",
  description: "Review",
  list: "work",
  created: 3,
};
const folder = { path: `${root}/docs`, dir: true, list: "work", created: 1 };
const file = { path: bookmark.path, dir: false, list: "work", created: 2 };
const neighbor = { path: `${root}/docs-other`, dir: true, list: "work", created: 4 };
const initial: BookmarkData = {
  items: [bookmark],
  paths: [folder, file, neighbor],
  lists: [{ id: "work", name: "Work" }],
  defaultList: "work",
};

function removePaths(...removed: string[]) {
  emitLocalIdeEvent({ type: "fsChanged", removed, created: [], modified: [] });
}

describe("bookmarks during file refactoring", () => {
  let dispose: (() => void) | void;

  beforeEach(() => {
    localStorage.clear();
    useProject.setState({ project: { root } as never });
    dispose = activate();
    updateBookmarkData(() => initial);
  });

  afterEach(() => {
    dispose?.();
    useProject.setState({ project: null });
    loadBookmarks(null);
  });

  it("retargets a file bookmark and its mnemonic line bookmark", async () => {
    const to = `${root}/docs/nested/renamed.txt`;
    await notifyFilesMoved([{ from: file.path, to }]);
    removePaths(file.path);
    expect(useBookmarks.getState().items).toEqual([{ ...bookmark, path: to }]);
    expect(useBookmarks.getState().paths).toContainEqual({ ...file, path: to });
  });

  it("retargets a folder and its descendants and keeps the mapping through undo", async () => {
    const to = `${root}/archive`;
    const movedFile = `${to}/nested/notes.txt`;
    await notifyFilesMoved([{ from: folder.path, to }]);
    removePaths(folder.path, file.path);
    loadBookmarks(root);
    expect(useBookmarks.getState().items).toEqual([{ ...bookmark, path: movedFile }]);
    expect(useBookmarks.getState().paths).toEqual([{ ...folder, path: to }, { ...file, path: movedFile }, neighbor]);

    await notifyFilesMoved([{ from: to, to: folder.path }]);
    removePaths(to);
    expect(useBookmarks.getState().items).toEqual(initial.items);
    expect(useBookmarks.getState().paths).toEqual(expect.arrayContaining(initial.paths));
  });

  it("waits for an in-flight move before pruning watcher removals", async () => {
    const to = `${root}/docs/nested/renamed.txt`;
    await trackFileMove(root, async () => {
      removePaths(file.path, neighbor.path);
      expect(useBookmarks.getState().items).toEqual(initial.items);
      await notifyFilesMoved([{ from: file.path, to }]);
    });
    await vi.waitFor(() => {
      const { items, paths } = useBookmarks.getState();
      expect(items).toEqual([{ ...bookmark, path: to }]);
      expect(paths).toEqual([folder, { ...file, path: to }]);
    });
  });

  it("handles unrelated deletions after a failed move and clears pending state", async () => {
    await expect(
      trackFileMove(root, async () => {
        removePaths(neighbor.path);
        expect(useBookmarks.getState().paths).toContainEqual(neighbor);
        throw new Error("Rename failed");
      }),
    ).rejects.toThrow("Rename failed");
    expect(pendingFileMoves(root)).toBeNull();
    await vi.waitFor(() => expect(useBookmarks.getState().paths).toEqual([folder, file]));
    removePaths(folder.path);
    expect(useBookmarks.getState().items).toEqual([]);
    expect(useBookmarks.getState().paths).toEqual([]);
  });

  it("does not apply a deferred removal to another project", async () => {
    await trackFileMove(root, async () => {
      removePaths(folder.path);
      useProject.setState({ project: { root: "C:/other" } as never });
      updateBookmarkData(() => initial);
    });
    expect(useBookmarks.getState()).toMatchObject({ scope: "C:/other", items: [bookmark] });
  });
});
