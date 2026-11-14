import { describe, expect, it, vi } from "vitest";

const show = vi.fn();
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ show }),
}));
/** The editor at the caret (`null`: a search from outside an editor). */
let caretView: import("@codemirror/view").EditorView | null = null;
const referenceResponse = vi.fn();
const lspReferences = vi.fn(async (..._args: unknown[]) => ({ status: "ok", data: null }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, lspReferences } };
});
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  caretContext: () => ({ doc: 1, path: "/p/a.rs", line: 0, col: 0, word: "used", view: caretView }),
  lspRequest: (request: () => unknown) => {
    request();
    return referenceResponse();
  },
  readManyFileLines: async () => new Map([["/p/b.rs", ["", "    used();", "    used();"]]]),
}));
const channels: { onmessage: (refs: unknown) => void }[] = [];
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));

const { registerDocumentIndexSync } = await import("@/workbench/contributions");

const { activeUsageSearch, findUsages, openUsageTab, pinUsageTab, resetUsages, showUsageResults, useUsages } =
  await import("./usages");

describe("showUsageResults", () => {
  it("shows given usages in the Find Usages tool window", async () => {
    const loc = { path: "/p/b.rs", range: { start: { line: 1, col: 4 }, end: { line: 1, col: 8 } } };
    await showUsageResults({ symbol: "used", locations: [loc] });
    expect(show).toHaveBeenCalledWith("usages");
    const search = activeUsageSearch(useUsages.getState())!;
    expect(search).toMatchObject({ symbol: "used", loading: false, error: null, rerun: null });
    expect(search.groups).toEqual([
      { path: "/p/b.rs", usages: [{ path: "/p/b.rs", line: 1, col: 4, endCol: 8, text: "    used();" }] },
    ]);
  });

  it("shows the lines the server gave along for files it does not read", async () => {
    const lib = {
      path: "jdt://contents/lib/Lib.class",
      range: { start: { line: 3, col: 4 }, end: { line: 3, col: 8 } },
    };
    await showUsageResults({
      symbol: "used",
      locations: [lib],
      classified: [{ location: lib, kind: "unknown", text: "    used();" }],
    });
    expect(activeUsageSearch(useUsages.getState())!.groups[0]!.usages[0]!.text).toBe("    used();");
  });

  it("ignores malformed arguments", async () => {
    show.mockClear();
    await showUsageResults({ symbol: "x" });
    expect(show).not.toHaveBeenCalled();
  });
});

describe("findUsages", () => {
  it("searches Project Files, then Project and Libraries on request", async () => {
    const at = { path: "/p/b.rs", range: { start: { line: 1, col: 4 }, end: { line: 1, col: 8 } } };
    lspReferences.mockClear();
    referenceResponse.mockResolvedValueOnce({ locations: [at], incomplete: null, librariesSkipped: true });
    await findUsages();
    const project = activeUsageSearch(useUsages.getState())!;
    expect(project).toMatchObject({ loading: false, scope: "project" });
    expect(lspReferences.mock.lastCall![5]).toBe(false);
    referenceResponse.mockResolvedValueOnce({ locations: [at], incomplete: null });
    project.searchLibraries!();
    await vi.waitFor(() => expect(activeUsageSearch(useUsages.getState())!.loading).toBe(false));
    expect(lspReferences.mock.lastCall![5]).toBe(true);
    const all = activeUsageSearch(useUsages.getState())!;
    expect(all.scope).toBe("libraries");
    // Rerun keeps the scope.
    referenceResponse.mockResolvedValueOnce({ locations: [at], incomplete: null });
    all.rerun!();
    await vi.waitFor(() => expect(lspReferences).toHaveBeenCalledTimes(3));
    expect(lspReferences.mock.lastCall![5]).toBe(true);
    resetUsages();
  });

  it("shows the usages found first while it searches for the rest", async () => {
    const at = (line: number) => ({ path: "/p/b.rs", range: { start: { line, col: 4 }, end: { line, col: 8 } } });
    let resolve!: (refs: unknown) => void;
    referenceResponse.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const requested = lspReferences.mock.calls.length;
    const search = findUsages();
    await vi.waitFor(() => expect(lspReferences).toHaveBeenCalledTimes(requested + 1));
    channels.at(-1)!.onmessage({ locations: [at(1)], incomplete: null });
    await vi.waitFor(() => expect(activeUsageSearch(useUsages.getState())!.groups).toHaveLength(1));
    expect(activeUsageSearch(useUsages.getState())).toMatchObject({ loading: true, error: null });
    resolve({ locations: [at(1), at(2)], incomplete: null });
    await search;
    const done = activeUsageSearch(useUsages.getState())!;
    expect(done.loading).toBe(false);
    expect(done.groups[0]!.usages.map((u) => u.line)).toEqual([1, 2]);
    resetUsages();
  });

  it("asks the server only once the editor's edits reached it", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { documentSynced } = await import("@/editor/api");
    let release!: () => void;
    const synced = new Promise<void>((resolve) => {
      release = resolve;
    });
    caretView = new EditorView({
      state: EditorState.create({ doc: "used();", extensions: documentSynced.of(() => synced) }),
    });
    referenceResponse.mockResolvedValueOnce({ locations: [], incomplete: null });
    lspReferences.mockClear();
    const pending = findUsages();
    try {
      await new Promise((r) => setTimeout(r, 10));
      expect(lspReferences).not.toHaveBeenCalled();
      release();
      await pending;
      expect(lspReferences).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await pending;
      caretView.destroy();
      caretView = null;
      resetUsages();
    }
  });

  it("waits for the contributed index barrier, then preserves partial and final usage events", async () => {
    let release!: () => void;
    const sync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const off = registerDocumentIndexSync(sync);
    let finish!: (refs: unknown) => void;
    referenceResponse.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    lspReferences.mockClear();
    const allocated = channels.length;
    const pending = findUsages();
    const at = (line: number) => ({ path: "/p/b.rs", range: { start: { line, col: 4 }, end: { line, col: 8 } } });
    try {
      await vi.waitFor(() => expect(sync).toHaveBeenCalledWith("/p/a.rs", "usages"));
      expect(lspReferences).not.toHaveBeenCalled();
      expect(channels).toHaveLength(allocated);
      release();
      await vi.waitFor(() => expect(lspReferences).toHaveBeenCalledTimes(1));
      channels.at(-1)!.onmessage({ locations: [at(1)], incomplete: null });
      await vi.waitFor(() => expect(activeUsageSearch(useUsages.getState())!.groups).toHaveLength(1));
      expect(activeUsageSearch(useUsages.getState())!.loading).toBe(true);
      finish({ locations: [at(1), at(2)], incomplete: null });
      await pending;
      expect(activeUsageSearch(useUsages.getState())!.groups[0]!.usages.map((u) => u.line)).toEqual([1, 2]);
    } finally {
      off();
      release?.();
      finish?.({ locations: [], incomplete: null });
      await pending;
      resetUsages();
    }
  });
});

describe("findUsages with a contributed index that is not up to date", () => {
  it("still searches, and says plugin usages may be missing", async () => {
    const off = registerDocumentIndexSync(async () => false);
    const at = { path: "/p/b.rs", range: { start: { line: 1, col: 4 }, end: { line: 1, col: 8 } } };
    referenceResponse.mockResolvedValueOnce({ locations: [at], incomplete: null });
    try {
      await findUsages();
      const search = activeUsageSearch(useUsages.getState())!;
      expect(search.groups).toHaveLength(1);
      expect(search.note).toBe("May be incomplete: plugin indexes are still updating");
    } finally {
      off();
      resetUsages();
    }
  });
});

describe("usage tabs", () => {
  const search = (id: number) => ({
    id,
    symbol: `s${id}`,
    loading: false,
    groups: [],
    error: null,
    note: null,
    rerun: null,
  });

  it("replace the selected tab unless it is pinned", () => {
    resetUsages();
    openUsageTab(search(101));
    openUsageTab(search(102));
    expect(useUsages.getState().tabs.map((t) => t.id)).toEqual([102]);
    pinUsageTab(102, true);
    openUsageTab(search(103));
    expect(useUsages.getState().tabs.map((t) => t.id)).toEqual([102, 103]);
    expect(activeUsageSearch(useUsages.getState())?.id).toBe(103);
    openUsageTab(search(104));
    expect(useUsages.getState().tabs.map((t) => t.id)).toEqual([102, 104]);
  });
});
