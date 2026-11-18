import { deleteCharForward, history, redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookmarkGutter } from "../bookmarks/gutter";
import { bookmarkByMnemonic, loadBookmarks, updateBookmarkData, useBookmarks, type Bookmark } from "../bookmarks/store";

const path = "/project/file.txt";
const bookmark = (line: number, text: string, extra: Partial<Bookmark> = {}): Bookmark => ({
  path,
  line,
  text,
  created: line + 1,
  list: "default",
  ...extra,
});

let view: EditorView | undefined;
beforeEach(() => {
  localStorage.clear();
  loadBookmarks("/project");
});
afterEach(() => {
  view?.destroy();
  view = undefined;
});

function editor(doc: string, items: Bookmark[]) {
  updateBookmarkData((d) => ({ ...d, items, lists: [...d.lists, { id: "custom", name: "Investigate" }] }));
  view = new EditorView({ doc, parent: document.body, extensions: [history(), bookmarkGutter(path, () => {})] });
  return view;
}

describe("bookmark gutter edits", () => {
  it.each([
    ["plain text", ["first", "remove", "survive"]],
    ["TypeScript", ["const first = 1;", "const remove = 2;", "const survive = 3;"]],
  ])("keeps the surviving bookmark's identity after deleting the adjacent line in %s", async (_kind, lines) => {
    const survivor = bookmark(2, lines[2]!, { mnemonic: "3", description: "Review this", list: "custom" });
    const otherFile = bookmark(0, "other file", { path: "/project/other", mnemonic: "4" });
    const v = editor(lines.join("\n"), [bookmark(1, lines[1]!), survivor, otherFile]);
    v.dispatch({ selection: { anchor: v.state.doc.line(2).from, head: v.state.doc.line(3).from } });
    expect(deleteCharForward(v)).toBe(true);
    await Promise.resolve();

    const moved = { ...survivor, line: 1 };
    expect(v.state.doc.toString()).toBe([lines[0], lines[2]].join("\n"));
    expect(useBookmarks.getState().items).toEqual([moved, otherFile]);
    expect(bookmarkByMnemonic(useBookmarks.getState().items, "3")).toEqual(moved);
    expect(v.dom.querySelector(".cm-openidea-bookmarkMnemonic")?.textContent).toBe("3");
    expect(v.dom.querySelector(".cm-openidea-bookmark")).toBeNull();

    expect(undo(v)).toBe(true);
    await Promise.resolve();
    expect(v.state.doc.toString()).toBe(lines.join("\n"));
    expect(bookmarkByMnemonic(useBookmarks.getState().items, "3")).toEqual(survivor);
    expect(redo(v)).toBe(true);
    await Promise.resolve();
    expect(bookmarkByMnemonic(useBookmarks.getState().items, "3")).toEqual(moved);
  });

  it("preserves an adjacent empty line's bookmark when its predecessor is deleted", async () => {
    const blank = bookmark(2, "", { mnemonic: "3" });
    const v = editor("first\nremove\n\nlast", [bookmark(1, "remove"), blank]);
    v.dispatch({ changes: { from: v.state.doc.line(2).from, to: v.state.doc.line(3).from } });
    await Promise.resolve();
    expect(useBookmarks.getState().items).toEqual([{ ...blank, line: 1 }]);
  });

  it("keeps a surviving anchor when a replacement consumes the preceding line", async () => {
    const survivor = bookmark(2, "survive", { mnemonic: "3" });
    const v = editor("first\nremove\nsurvive", [bookmark(1, "remove"), survivor]);
    v.dispatch({ changes: { from: v.state.doc.line(2).from, to: v.state.doc.line(3).from, insert: "new " } });
    await Promise.resolve();
    expect(useBookmarks.getState().items).toEqual([{ ...survivor, line: 1, text: "new survive" }]);
  });

  it("tracks an inserted line and keeps a bookmark when its first character is deleted", async () => {
    const saved = bookmark(1, "sample", { mnemonic: "3", description: "Review this" });
    const v = editor("first\nsample", [saved]);
    const start = v.state.doc.line(2).from;
    v.dispatch({ changes: { from: start, to: start + 1 } });
    await Promise.resolve();
    expect(useBookmarks.getState().items).toEqual([saved]);
    v.dispatch({ changes: { from: start, insert: "new line\n" } });
    await Promise.resolve();
    expect(useBookmarks.getState().items).toEqual([{ ...saved, line: 2, text: "ample" }]);
  });

  it("keeps the first bookmark when two surviving lines are joined", async () => {
    const first = bookmark(0, "first", { mnemonic: "1" });
    const v = editor("first\nsecond", [first, bookmark(1, "second", { mnemonic: "2" })]);
    v.dispatch({ changes: { from: 5, to: 6 } });
    await Promise.resolve();
    expect(useBookmarks.getState().items).toEqual([first]);
  });

  it("publishes a deletion once when the edit is mirrored in another view", async () => {
    const survivor = bookmark(2, "survive", { mnemonic: "3", description: "Review this", list: "custom" });
    const v = editor("first\nremove\nsurvive", [bookmark(1, "remove"), survivor]);
    const other = new EditorView({
      doc: v.state.doc,
      parent: document.body,
      extensions: bookmarkGutter(path, () => {}),
    });
    try {
      const changes = { from: v.state.doc.line(2).from, to: v.state.doc.line(3).from };
      v.dispatch({ changes });
      other.dispatch({ changes });
      await Promise.resolve();
      expect(useBookmarks.getState().items).toEqual([{ ...survivor, line: 1 }]);
      expect(other.dom.querySelector(".cm-openidea-bookmarkMnemonic")?.textContent).toBe("3");
      expect(other.dom.querySelector(".cm-openidea-bookmark")).toBeNull();
    } finally {
      other.destroy();
    }
  });
});
