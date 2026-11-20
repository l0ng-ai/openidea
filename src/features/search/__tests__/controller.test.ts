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
  it("filters recent actions when disabled actions are excluded", async () => {
    const { c, last } = setup({
      actions: () => [
        { id: "blocked", title: "Blocked", run: () => {} },
        { id: "available", title: "Available", run: () => {} },
      ],
      isEnabled: (a) => a.id === "available",
      recentActions: () => ["blocked", "available"],
    });
    const recent = () => last().sections.get("recentActions")!.items;
    c.run({ query: "", tab: "actions", includeNonProject: false, includeDisabled: false, extra: {} });
    await flush();
    expect(recent()).toMatchObject([{ id: "available", enabled: true }]);

    c.run({ query: "", tab: "actions", includeNonProject: true, includeDisabled: true, extra: {} });
    await flush();
    expect(recent()).toMatchObject([
      { id: "blocked", enabled: false },
      { id: "available", enabled: true },
    ]);
  });

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

  it("lists scratch files with the indexed files, ranked by name", async () => {
    const outsideFiles = vi.fn(async () => [
      { path: "/data/scratches/scratch_3.md", relPath: "Scratches/scratch_3.md" },
      { path: "/data/scratches/notes.txt", relPath: "Scratches/notes.txt" },
    ]);
    const { c, last } = setup({
      findFiles: async () => [{ ...fm("tests/test_scratch_dir.py"), score: (1 << 20) + 50 }],
      outsideFiles,
      inFileSet: (set, path) => path.startsWith("/p/") && (set === "all" || set === "test"),
    });
    c.run({ query: "scratch_3", tab: "files", includeNonProject: false, extra: {} });
    await flush();
    expect(last().sections.get("files")!.items[0]).toMatchObject({
      key: "f:/data/scratches/scratch_3.md",
      name: "scratch_3.md",
      dir: "Scratches",
      nameIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    });

    c.run({ query: "scratch", tab: "files", includeNonProject: false, extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/data/scratches/scratch_3.md", "f:/p/tests/test_scratch_dir.py"]);

    // Production / test file sets are project scopes.
    c.run({ query: "scratch", tab: "files", includeNonProject: false, fileSet: "test", extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).not.toContain("f:/data/scratches/scratch_3.md");
  });

  // #4079 follow-up: a plain Windows absolute path names an indexed file.
  it("searches a pasted Windows absolute path as its project-relative path", async () => {
    const findFiles = vi.fn(async () => [fm("pkg/service/Config.go")]);
    const { c, last } = setup({ findFiles, root: () => "E:/work/sample" });
    c.run({
      query: String.raw`e:\work\sample\pkg\service\Config.go`,
      tab: "files",
      includeNonProject: false,
      extra: {},
    });
    await flush();
    expect(findFiles).toHaveBeenCalledWith("pkg/service/Config.go", expect.any(Number));
    expect(last().sections.get("files")!.items[0]).toMatchObject({ key: "f:/p/pkg/service/Config.go" });
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

  // #4080: `:digits` is a location only where a result opens at it.
  it.each([
    ["http://localhost:8080", "http://localhost", 8079, null],
    ["a:1", "a", 0, null],
    ["key: 2", "key: 2", null, null],
    ["10:30", "10", 29, null],
    ["foo.ts:12:3", "foo.ts", 11, 2],
  ])("%s: files look up %s, text search takes the query as typed", async (query, file, line, col) => {
    const findFiles = vi.fn(async (_q: string, _limit: number) => [fm("x.ts")]);
    const searchText = vi.fn(async (_r: number, _q: SearchQuery) => {});
    const { c, last } = setup({ findFiles, searchText });
    c.run({ query, tab: "all", includeNonProject: false, extra: {} });
    await flush();
    expect(findFiles.mock.calls.at(-1)![0]).toBe(file);
    const item = last().sections.get("files")!.items[0]!;
    expect(item.kind === "file" && [item.line ?? null, item.col ?? null]).toEqual([line, col]);
    expect(searchText.mock.calls.at(-1)![1].pattern).toBe(query);
    c.run({ query, tab: "text", includeNonProject: false, extra: {} });
    await flush();
    expect(searchText.mock.calls.at(-1)![1].pattern).toBe(query);
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

describe("plugin search categories", () => {
  const id = "plugin:sample:routes" as const;
  const page = (title: string) => ({
    items: [
      {
        id: "same",
        title,
        description: "Handler",
        target: { kind: "command" as const, value: { id: "open", arg: "/files /users:42" } },
      },
    ],
    hasMore: true,
  });
  const request = (query: string) => ({ query, tab: id, includeNonProject: false, extra: {} });
  it("passes the raw query, preserves provider order, bounds show more and does not query custom categories in All", async () => {
    const search = vi.fn(async () => page("Request"));
    const category = {
      id,
      title: "Routes",
      search,
      command: (c: string) => ({ id: `plugin.sample.${c}`, title: "Open", run: vi.fn() }),
    };
    const { c, last } = setup({
      categories: () => [category],
      actions: () => [{ id: "plugin.sample.open", title: "Open", run: () => {} }],
    });
    c.run(request("/files /users:42"));
    await flush();
    expect(search).toHaveBeenLastCalledWith(1, "/files /users:42", 50);
    const item = last().sections.get(id)!.items[0]!;
    expect(item).toMatchObject({ key: `${id}:same`, enabled: true });
    expect(buildRows(last().sections, { headers: false })).toHaveLength(2);
    c.run({ ...request(""), extra: { [id]: 10000 } });
    await flush();
    expect(search).toHaveBeenLastCalledWith(2, "", 200);
    expect(last().sections.get(id)!.hasMore).toBe(false);
    c.run({ ...request("query"), tab: "all" });
    await flush();
    expect(search).toHaveBeenCalledTimes(2);
  });
  it("cancels superseded work, ignores late answers and withdraws removed providers", async () => {
    const old = deferred<ReturnType<typeof page>>();
    const search = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(page("New"));
    let categories = [{ id, title: "Routes", search, command: (c: string) => ({ id: c, title: c, run: vi.fn() }) }];
    const { c, deps, last } = setup({ categories: () => categories });
    c.run(request("old"));
    c.run(request("new"));
    await flush();
    expect(deps.cancel).toHaveBeenCalledWith(1);
    old.resolve(page("Old"));
    await flush();
    expect(last().sections.get(id)!.items[0]).toMatchObject({ title: "New" });
    categories = [];
    c.invalidateCategories();
    c.run(request("new"));
    await flush();
    expect(last().sections.has(id)).toBe(false);
    c.dispose();
  });
  it("cancels close and tab switches and completes failed providers without hanging", async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad provider"))
      .mockReturnValue(new Promise(() => {}));
    const { c, deps, last } = setup({
      categories: () => [{ id, title: "Routes", search, command: (c) => ({ id: c, title: c, run: vi.fn() }) }],
    });
    c.run(request("bad"));
    await flush();
    expect(last().loading).toBe(false);
    c.run(request("pending"));
    c.run({ ...request("q"), tab: "files" });
    expect(deps.cancel).toHaveBeenCalledWith(2);
    c.run(request("pending"));
    c.dispose();
    expect(deps.cancel).toHaveBeenCalledWith(3);
  });
});
