import { describe, expect, it, vi } from "vitest";
import type { FileMatches, SearchQuery } from "@/platform/ipc";
import { SeController, type SeDeps, type SeSnapshot } from "../everywhere/controller";
import { buildRows } from "../everywhere/model";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: Partial<SeDeps> = {}) {
  let id = 0;
  const deps: SeDeps = {
    findFiles: vi.fn(async () => []),
    findSymbols: vi.fn(async () => []),
    searchText: vi.fn(async () => {}),
    cancel: vi.fn(),
    nextRequestId: () => ++id,
    actions: () => [],
    isEnabled: () => true,
    recentFiles: async () => [],
    recentActions: () => [],
    root: () => "/p",
    now: () => 0,
    ...overrides,
  };
  const snaps: SeSnapshot[] = [];
  const c = new SeController(deps, (s) => snaps.push(s));
  return { c, deps, snaps, last: () => snaps[snaps.length - 1]! };
}

const fm = (rel: string) => ({ path: `/p/${rel}`, relPath: rel, score: 1, indices: [] });

describe("SeController", () => {
  it("streams each section independently", async () => {
    const files = deferred<ReturnType<typeof fm>[]>();
    const { c, last } = setup({
      findFiles: () => files.promise,
      actions: () => [{ id: "x", title: "Order Things", run: () => {} }],
    });
    c.run({ query: "ord", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    // Actions answered synchronously; files are still pending.
    expect(last().sections.get("actions")!.items).toHaveLength(1);
    expect(last().sections.get("files")!.loading).toBe(true);
    expect(last().loading).toBe(true);
    files.resolve([fm("Order.kt")]);
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/Order.kt"]);
  });

  it("drops late results of a superseded query and cancels its requests", async () => {
    const first = deferred<ReturnType<typeof fm>[]>();
    const findFiles = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([fm("New.kt")]);
    const lsp = deferred<never[]>();
    const { c, deps, last } = setup({ findFiles, workspaceSymbols: () => lsp.promise });
    c.run({ query: "old", tab: "files", includeNonProject: false, extra: {} });
    c.run({ query: "new", tab: "files", includeNonProject: false, extra: {} });
    first.resolve([fm("Old.kt")]);
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/New.kt"]);

    c.run({ query: "sym", tab: "symbols", includeNonProject: false, extra: {} });
    c.run({ query: "sym2", tab: "symbols", includeNonProject: false, extra: {} });
    expect(deps.cancel).toHaveBeenCalled();
  });

  it("lists directories with the files, by score, files first on a tie", async () => {
    const { c, last } = setup({
      findFiles: async () => [
        { ...fm("src/util.ts"), score: 5 },
        { ...fm("lib/utils/a.ts"), score: 2 },
      ],
      findDirs: async () => [
        { path: "/p/src/utils", relPath: "src/utils/", score: 5, indices: [4, 5, 6, 7] },
        { path: "/p/lib/utils", relPath: "lib/utils/", score: 3, indices: [] },
      ],
    });
    c.run({ query: "util", tab: "files", includeNonProject: false, extra: {} });
    await flush();
    const items = last().sections.get("files")!.items;
    expect(items.map((i) => i.key)).toEqual([
      "f:/p/src/util.ts",
      "d:/p/src/utils",
      "d:/p/lib/utils",
      "f:/p/lib/utils/a.ts",
    ]);
    expect(items[1]).toMatchObject({
      kind: "file",
      folder: true,
      name: "utils",
      dir: "src",
      nameIndices: [0, 1, 2, 3],
    });

    // A `File.kt:42` query asks for a file.
    c.run({ query: "util:3", tab: "files", includeNonProject: false, extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.every((i) => !("folder" in i) || !i.folder),
    ).toBe(true);
  });

  it("parses File.kt:42 and opens files at the line", async () => {
    const findFiles = vi.fn(async () => [fm("File.kt")]);
    const { c, last } = setup({ findFiles });
    c.run({ query: "File.kt:42:3", tab: "files", includeNonProject: false, extra: {} });
    await flush();
    expect(findFiles).toHaveBeenCalledWith("File.kt", 51);
    const item = last().sections.get("files")!.items[0]!;
    expect(item.kind === "file" && [item.line, item.col]).toEqual([41, 2]);
  });

  it("shows recent files for an empty query", async () => {
    const { c, last } = setup({ recentFiles: async () => ["/p/a/B.kt", "/p/C.kt"] });
    c.run({ query: "", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    expect(
      last()
        .sections.get("recent")!
        .items.map((i) => (i.kind === "file" ? i.rel : "")),
    ).toEqual(["a/B.kt", "C.kt"]);
  });

  it("re-fetches only the section whose limit changed (Show more)", async () => {
    const findFiles = vi.fn(async () => [fm("A.kt")]);
    const findSymbols = vi.fn(async () => []);
    const { c } = setup({ findFiles, findSymbols });
    c.run({ query: "a", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    c.run({ query: "a", tab: "all", includeNonProject: false, extra: { files: 15 } });
    await flush();
    expect(findFiles).toHaveBeenCalledTimes(2);
    expect(findFiles).toHaveBeenLastCalledWith("a", 22);
    expect(findSymbols).toHaveBeenCalledTimes(2); // classes + symbols once each
  });

  it("merges LSP symbols after the index answers and ignores unavailable servers", async () => {
    const lsp = deferred<never[]>();
    const { c, last } = setup({
      findSymbols: async () => [
        {
          name: "order",
          kind: "variable",
          container: null,
          path: "/p/A.kt",
          relPath: "A.kt",
          range: { start: { line: 1, col: 0 }, end: { line: 1, col: 5 } },
          score: 1,
          indices: [0],
        },
      ],
      workspaceSymbols: () => lsp.promise,
    });
    c.run({ query: "ord", tab: "symbols", includeNonProject: false, extra: {} });
    await flush();
    expect(last().sections.get("symbols")!.items).toHaveLength(1);
    expect(last().sections.get("symbols")!.loading).toBe(true);
    lsp.reject({ kind: "unavailable", message: "no server" });
    await flush();
    expect(last().sections.get("symbols")!.loading).toBe(false);
    expect(last().sections.get("symbols")!.items).toHaveLength(1);
  });

  it("streams text matches up to the limit", async () => {
    const searchText = vi.fn(async (_id: number, q: SearchQuery, onFile: (f: FileMatches) => void) => {
      expect(q.maxMatches).toBe(7);
      for (let i = 0; i < 3; i++)
        onFile({
          path: `/p/${i}.kt`,
          relPath: `${i}.kt`,
          matches: [1, 2, 3].map((line) => ({ line, text: "order", ranges: [[0, 5]], textOffset: 0 })),
        });
    });
    const { c, last } = setup({ searchText });
    c.run({ query: "order", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    const text = last().sections.get("text")!;
    expect(text.items).toHaveLength(6);
    expect(text.hasMore).toBe(true);
    expect(text.loading).toBe(false);
  });

  it("narrows Files / Symbols / Text to Project Production or Test Files", async () => {
    const isTest = (path: string) => path.includes("/test/");
    const findFiles = vi.fn(async () => [fm("src/main/A.kt"), fm("src/test/ATest.kt")]);
    const searchText = vi.fn(async (_r: number, _q: SearchQuery) => {});
    const { c, last } = setup({
      findFiles,
      searchText,
      inFileSet: (set, path) => (set === "all" ? true : isTest(path) === (set === "test")),
    });
    c.run({ query: "a", tab: "files", includeNonProject: false, fileSet: "test", extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/src/test/ATest.kt"]);
    expect(findFiles).toHaveBeenLastCalledWith("a", 4 * 50 + 1);
    c.run({ query: "a", tab: "files", includeNonProject: false, fileSet: "production", extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/src/main/A.kt"]);
    // "All Places" ignores the narrowed scope.
    c.run({ query: "a", tab: "files", includeNonProject: true, fileSet: "production", extra: {} });
    await flush();
    expect(last().sections.get("files")!.items).toHaveLength(2);
    c.run({ query: "needle", tab: "text", includeNonProject: false, fileSet: "test", extra: {} });
    await flush();
    expect(searchText.mock.calls.at(-1)![1].scope).toEqual({ kind: "fileSet", set: "test" });
  });
});

describe("Endpoints in the All tab", () => {
  it("answers a request path with the controller method that serves it", async () => {
    const routes = [
      {
        method: "POST",
        url: "/deeplink/menu/search",
        controller: "DeepLinkController",
        methodName: "searchMenus",
        path: "/p/tg-tenant-server/src/main/java/DeepLinkController.java",
        rel: "tg-tenant-server/src/main/java/DeepLinkController.java",
        line: 45,
        col: 4,
      },
    ];
    const { c, last } = setup({ root: () => "/p", routes: async () => routes });
    c.run({ query: "/tg-tenant/deeplink/menu/search", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    const section = last().sections.get("endpoints");
    expect(section?.items).toHaveLength(1);
    expect(section?.items[0]).toMatchObject({ kind: "symbol", container: "DeepLinkController.searchMenus", line: 45 });
    // The All tab mixes its sections into one list; an endpoint has to be in it.
    const rows = buildRows(last().sections, { headers: false, mix: "/tg-tenant/deeplink/menu/search" });
    expect(rows.map((r) => (r.kind === "symbol" ? r.container : r.kind))).toContain("DeepLinkController.searchMenus");
  });
});
