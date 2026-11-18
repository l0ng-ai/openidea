import { beforeEach, describe, expect, it } from "vitest";
import {
  assignMnemonic,
  bookmarkByMnemonic,
  bookmarkLabel,
  describeBookmark,
  linesOf,
  loadBookmarks,
  marksOf,
  toggleMnemonic,
  renameBookmarks,
  toggleBookmark,
  updateBookmarks,
  useBookmarks,
  type Bookmark,
} from "../bookmarks/store";

describe("bookmark helpers", () => {
  it("toggles on and off, keeping the list sorted", () => {
    let list: Bookmark[] = [];
    list = toggleBookmark(list, "/p/b.kt", 3, "  val x = 1  ", 1);
    list = toggleBookmark(list, "/p/a.kt", 9, "fun a()", 2);
    list = toggleBookmark(list, "/p/b.kt", 1, "import", 3);
    expect(list.map((b) => `${b.path}:${b.line}`)).toEqual(["/p/a.kt:9", "/p/b.kt:1", "/p/b.kt:3"]);
    expect(list[2]!.text).toBe("val x = 1");
    list = toggleBookmark(list, "/p/b.kt", 1, "import");
    expect(linesOf(list, "/p/b.kt")).toEqual([3]);
  });

  it("follows renames and drops deleted files", () => {
    const list = [
      { path: "/p/dir/a", line: 1, text: "", created: 1 },
      { path: "/p/other", line: 2, text: "", created: 1 },
    ];
    expect(renameBookmarks(list, "/p/dir", "/p/new").map((b) => b.path)).toEqual(["/p/new/a", "/p/other"]);
    expect(renameBookmarks(list, "/p/dir", null).map((b) => b.path)).toEqual(["/p/other"]);
  });
});

describe("bookmark store", () => {
  beforeEach(() => localStorage.clear());

  it("persists per project", () => {
    loadBookmarks("/p1");
    updateBookmarks((l) => toggleBookmark(l, "/p1/a", 0, "x"));
    loadBookmarks("/p2");
    expect(useBookmarks.getState().items).toEqual([]);
    loadBookmarks("/p1");
    expect(linesOf(useBookmarks.getState().items, "/p1/a")).toEqual([0]);
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem(
      "openidea.bookmarks.v1:/bad",
      JSON.stringify([{ path: 1 }, { path: "/bad/x", line: 2 }, "nope"]),
    );
    loadBookmarks("/bad");
    expect(useBookmarks.getState().items.map((b) => b.line)).toEqual([2]);
  });
});

describe("mnemonic bookmarks", () => {
  it("assigns a mnemonic, moving it from another bookmark", () => {
    let list: Bookmark[] = [];
    list = assignMnemonic(list, "/p/a", 1, "one", "A", undefined, 1);
    list = assignMnemonic(list, "/p/b", 2, "two", "A", "second", 2);
    expect(bookmarkByMnemonic(list, "A")).toMatchObject({ path: "/p/b", line: 2, description: "second" });
    expect(list.find((b) => b.path === "/p/a")?.mnemonic).toBeUndefined();
    list = assignMnemonic(list, "/p/b", 2, "two", null, "");
    expect(list.find((b) => b.path === "/p/b")).toEqual({ path: "/p/b", line: 2, text: "two", created: 2 });
  });

  it("⌃⇧digit toggles a numbered bookmark", () => {
    let list = toggleMnemonic([], "/p/a", 3, "x", "1");
    expect(marksOf(list, "/p/a")).toEqual([{ line: 3, mnemonic: "1" }]);
    list = toggleMnemonic(list, "/p/a", 5, "y", "1");
    expect(marksOf(list, "/p/a")).toEqual([
      { line: 3, mnemonic: null },
      { line: 5, mnemonic: "1" },
    ]);
    list = toggleMnemonic(list, "/p/a", 5, "y", "1");
    expect(linesOf(list, "/p/a")).toEqual([3]);
  });

  it("keeps mnemonics and descriptions when storage reloads", () => {
    const list: Bookmark[] = [{ path: "/p/a", line: 1, text: "a", created: 1, mnemonic: "7", description: "note" }];
    localStorage.setItem(
      "openidea.bookmarks.v1:/m",
      JSON.stringify([...list, { path: "/p/b", line: 0, mnemonic: "ab" }]),
    );
    loadBookmarks("/m");
    expect(useBookmarks.getState().items.map((b) => b.mnemonic)).toEqual(["7", undefined]);
    expect(useBookmarks.getState().items[0]).toMatchObject({ line: 1, description: "note" });
  });

  it("F3 on a selection uses it as the description; Rename edits it", () => {
    let list = toggleBookmark([], "/p/a", 0, "let x = 1;", 1, "  important  ");
    expect(bookmarkLabel(list[0]!)).toBe("important");
    list = describeBookmark(list, "/p/a", 0, "renamed");
    expect(bookmarkLabel(list[0]!)).toBe("renamed");
    list = describeBookmark(list, "/p/a", 0, " ");
    expect(bookmarkLabel(list[0]!)).toBe("let x = 1;");
  });
});
