import { beforeEach, describe, expect, it, vi } from "vitest";

const show = vi.fn();
const hide = vi.fn();
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ show, hide }),
}));
const lspReferences = vi.fn(async (..._args: unknown[]) => ({ status: "ok", data: null }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, lspReferences } };
});
/** The caret Find Usages starts from (`null`: no editor). */
let caret: { doc: number; path: string; line: number; col: number; word: string | null } | null = null;
/** Documents `withDocument` opened and closed, by path; a missing path fails to open. */
const opened: string[] = [];
const closed: number[] = [];
const reportError = vi.fn();
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  caretContext: () => (caret ? { ...caret, view: null } : null),
  lspRequest: async (request: () => unknown) => {
    request();
    return { locations: [], incomplete: null };
  },
  readManyFileLines: async () => new Map(),
  withDocument: async (path: string, fn: (doc: number) => Promise<unknown>) => {
    if (path.includes("missing")) throw new Error(`Cannot open ${path}`);
    opened.push(path);
    const doc = 100 + opened.length;
    try {
      return await fn(doc);
    } finally {
      closed.push(doc);
    }
  },
  reportError,
}));

vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const { executeAction, getAction } = await import("@/platform/actions");
const { setContext } = await import("@/platform/context");
const { useContextMenuStore } = await import("@/ui/Menu");
const { activate } = await import("./index");
const { activeUsageSearch, closeUsageTab, findUsages, recentUsageSearches, resetUsages, useUsages } =
  await import("./usages");

const at = (path: string, line: number, col: number, word: string | null, doc = 1) => {
  caret = { doc, path, line, col, word };
};
/** The (doc, line, col) of the last references request. */
const lastRequest = () => {
  const [, doc, pos, , , libraries] = lspReferences.mock.lastCall!;
  return { doc, pos, libraries };
};

describe("Recent Find Usages", () => {
  beforeEach(() => {
    resetUsages();
    lspReferences.mockClear();
    opened.length = 0;
    closed.length = 0;
    reportError.mockClear();
    useContextMenuStore.setState({ menu: null });
  });

  it("remembers searches newest first, once per position, up to ten", async () => {
    at("/p/a.rs", 1, 4, "foo");
    await findUsages();
    at("/p/b.rs", 2, 0, "bar");
    await findUsages();
    at("/p/a.rs", 1, 4, "foo");
    await findUsages();
    expect(recentUsageSearches().map((r) => r.symbol)).toEqual(["foo", "bar"]);

    // Same name elsewhere is another search.
    at("/p/c.rs", 7, 2, "foo");
    await findUsages();
    expect(recentUsageSearches().map((r) => r.path)).toEqual(["/p/c.rs", "/p/a.rs", "/p/b.rs"]);

    for (let line = 10; line < 20; line++) {
      at("/p/d.rs", line, 0, `s${line}`);
      // oxlint-disable-next-line no-await-in-loop -- searches run one after another, like the user's
      await findUsages();
    }
    expect(recentUsageSearches()).toHaveLength(10);
    expect(recentUsageSearches()[0]!.symbol).toBe("s19");
    expect(recentUsageSearches().at(-1)!.symbol).toBe("s10");
  });

  it("keeps a search after its tab is closed and forgets it on a project switch", async () => {
    at("/p/a.rs", 1, 4, "foo");
    await findUsages();
    closeUsageTab(activeUsageSearch(useUsages.getState())!.id);
    expect(useUsages.getState().tabs).toHaveLength(0);
    expect(recentUsageSearches().map((r) => r.symbol)).toEqual(["foo"]);
    resetUsages();
    expect(recentUsageSearches()).toEqual([]);
  });

  it("does not remember a search that never started", async () => {
    caret = null;
    await findUsages();
    expect(recentUsageSearches()).toEqual([]);
  });

  describe("action", () => {
    let dispose: () => void;
    beforeEach(() => {
      setContext("projectOpen", true);
      dispose = activate();
      return () => dispose();
    });

    it("is disabled until something was searched", async () => {
      const action = getAction("find.recentUsages")!;
      expect(action.title).toBe("Recent Find Usages");
      expect(action.enabled?.({ arg: undefined } as never)).toBe(false);
      expect(await executeAction("find.recentUsages")).toBe(false);
      expect(useContextMenuStore.getState().menu).toBeNull();
    });

    it("lists the searches and runs the chosen one again, in the file's current document", async () => {
      at("/p/a.rs", 1, 4, "foo", 7);
      await findUsages();
      at("/p/b.rs", 2, 0, "bar", 8);
      await findUsages();
      closeUsageTab(activeUsageSearch(useUsages.getState())!.id);

      expect(await executeAction("find.recentUsages")).toBe(true);
      const menu = useContextMenuStore.getState().menu!;
      expect(menu.title).toBe("Recent Find Usages");
      const items = menu.items.filter((i) => i.kind !== "header") as {
        label: string;
        shortcut?: string;
        run(): void;
      }[];
      expect(items.map((i) => [i.label, i.shortcut])).toEqual([
        ["Usages of 'bar'", "b.rs:3"],
        ["Usages of 'foo'", "a.rs:2"],
      ]);

      // The editor that searched `foo` may be gone: it asks in a document opened for it.
      lspReferences.mockClear();
      items[1]!.run();
      await vi.waitFor(() => expect(activeUsageSearch(useUsages.getState())?.loading).toBe(false));
      expect(opened).toEqual(["/p/a.rs"]);
      expect(lastRequest()).toEqual({ doc: 101, pos: { line: 1, col: 4 }, libraries: false });
      expect(activeUsageSearch(useUsages.getState())!.symbol).toBe("foo");
      expect(show).toHaveBeenCalledWith("usages");
      // Run again, it is the newest.
      expect(recentUsageSearches().map((r) => r.symbol)).toEqual(["foo", "bar"]);
      // That document closed with the search: the tab's Rerun opens it again.
      expect(closed).toEqual([101]);
      activeUsageSearch(useUsages.getState())!.rerun!();
      await vi.waitFor(() => expect(closed).toEqual([101, 102]));
      expect(lastRequest()).toEqual({ doc: 102, pos: { line: 1, col: 4 }, libraries: false });
    });

    it("keeps the scope a search was widened to", async () => {
      at("/p/a.rs", 1, 4, "foo");
      await findUsages();
      activeUsageSearch(useUsages.getState())!.searchLibraries!();
      await vi.waitFor(() => expect(lastRequest().libraries).toBe(true));
      await vi.waitFor(() => expect(activeUsageSearch(useUsages.getState())!.loading).toBe(false));
      expect(recentUsageSearches()).toHaveLength(1);

      await executeAction("find.recentUsages");
      const item = useContextMenuStore.getState().menu!.items.find((i) => i.kind !== "header") as { run(): void };
      lspReferences.mockClear();
      item.run();
      await vi.waitFor(() => expect(lspReferences).toHaveBeenCalled());
      expect(lastRequest().libraries).toBe(true);
    });

    it("reports a file that can no longer be opened", async () => {
      at("/p/missing.rs", 0, 0, "gone");
      await findUsages();
      await executeAction("find.recentUsages");
      const item = useContextMenuStore.getState().menu!.items.find((i) => i.kind !== "header") as { run(): void };
      lspReferences.mockClear();
      item.run();
      await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
      expect(String(reportError.mock.lastCall![0])).toContain("Cannot open /p/missing.rs");
      expect(lspReferences).not.toHaveBeenCalled();
      expect(activeUsageSearch(useUsages.getState())).toMatchObject({
        symbol: "gone",
        loading: false,
        error: "Cannot open /p/missing.rs",
      });
    });
  });
});
