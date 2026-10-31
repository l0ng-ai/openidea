import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMatches, SearchQuery } from "@/platform/ipc";
import { buildFindTree } from "../find/FindToolWindow";
import type { FindDeps } from "../find/session";
import {
  disposeFindWindow,
  openEditorResults,
  openInFindWindow,
  pinFindTab,
  rerunFindTab,
  useFindWindow,
} from "../find/windowStore";

const q = (pattern: string): SearchQuery => ({
  pattern,
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 100,
});

const deps: FindDeps = {
  validate: async () => {},
  start: async () => null,
  cancel: () => {},
  nextRequestId: () => 1,
};

const file = (rel: string): FileMatches => ({
  path: `/p/${rel}`,
  relPath: rel,
  matches: [{ line: 0, text: "foo", ranges: [[0, 3]], textOffset: 0 }],
});

afterEach(disposeFindWindow);

describe("Find tool window tabs", () => {
  it("reuses the selected tab unless it is pinned", () => {
    const a = openInFindWindow(q("a"), "a", null, deps);
    const b = openInFindWindow(q("b"), "b", null, deps);
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["b"]);
    expect(useFindWindow.getState().active).toBe(b);
    expect(b).not.toBe(a);

    pinFindTab(b, true);
    const c = openInFindWindow(q("c"), "c", null, deps);
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["b", "c"]);
    expect(useFindWindow.getState().active).toBe(c);

    // Selecting the pinned tab again opens the next search beside it.
    useFindWindow.setState({ active: b });
    openInFindWindow(q("d"), "d", null, deps);
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["b", "c", "d"]);
  });
});

describe("buildFindTree", () => {
  const files = [file("src/b.ts"), file("a.ts"), file("src/a.ts")];

  it("lists files flat by path by default", () => {
    const roots = buildFindTree(files);
    expect(roots.map((n) => n.kind)).toEqual(["file", "file", "file"]);
    expect(roots.map((n) => n.key)).toEqual(["f:/p/a.ts", "f:/p/src/a.ts", "f:/p/src/b.ts"]);
  });

  it("groups files by directory on request", () => {
    const roots = buildFindTree(files, true);
    expect(roots.map((n) => (n.kind === "dir" ? [n.label, n.count] : n.kind))).toEqual([
      ["/", 1],
      ["src", 2],
    ]);
  });
});

describe("editor-backed Find results", () => {
  it("uses the shared session and recomputes live results on rerun without IPC", async () => {
    const current = file("unsaved.ts");
    current.matches[0]!.text = "foo foo";
    current.matches[0]!.ranges.push([4, 7]);
    const read = vi.fn(() => current);
    const id = openEditorResults({ title: "Occurrences of 'foo'", query: q("foo"), read });
    await vi.waitFor(() => expect(useFindWindow.getState().tabs[0]?.state.status).toBe("done"));
    expect(useFindWindow.getState().tabs[0]?.state.files).toEqual([current]);
    expect(useFindWindow.getState().tabs[0]?.state.matchCount).toBe(2);
    const tree = buildFindTree(useFindWindow.getState().tabs[0]!.state.files);
    expect(tree[0]).toMatchObject({ kind: "file", count: 2 });
    read.mockReturnValue({ ...file("unsaved.ts"), matches: [] });
    rerunFindTab(id);
    await vi.waitFor(() => expect(useFindWindow.getState().tabs[0]?.state.files).toEqual([]));
    expect(read).toHaveBeenCalledTimes(2);
    expect(useFindWindow.getState().tabs[0]?.state.summary?.matches).toBe(0);
  });
});
