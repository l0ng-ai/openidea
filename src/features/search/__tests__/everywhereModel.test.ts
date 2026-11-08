import { describe, expect, it } from "vitest";
import type { Action } from "@/platform/actions";
import type { SymbolMatch, WorkspaceSymbol } from "@/platform/ipc";
import {
  buildRows,
  fileItem,
  matchActions,
  mergeSymbols,
  parseCommand,
  sectionsFor,
  stableIndex,
  symbolItem,
  textItems,
  topResultSettled,
  type SectionId,
  type SectionState,
} from "../everywhere/model";

const range = (line: number, col = 0) => ({ start: { line, col }, end: { line, col: col + 1 } });
const sym = (
  name: string,
  kind: SymbolMatch["kind"],
  path: string,
  line: number,
  container: string | null = null,
): SymbolMatch => ({
  name,
  kind,
  container,
  path,
  relPath: path.replace("/p/", ""),
  range: range(line),
  score: 0,
  indices: [0],
});
const ws = (name: string, kind: WorkspaceSymbol["kind"], path: string, line: number): WorkspaceSymbol => ({
  name,
  kind,
  container: null,
  location: { path, range: range(line) },
});
const opts = { root: "/p", includeNonProject: false, typesOnly: false, excludeTypes: false, limit: 10 };

describe("mergeSymbols", () => {
  it("keeps index order and appends unknown LSP symbols, deduplicated", () => {
    const index = [sym("orderCount", "method", "/p/A.kt", 3), sym("ordinal", "field", "/p/B.kt", 1)];
    const lsp = [ws("orderCount", "method", "/p/A.kt", 3), ws("ordersTotal", "function", "/p/C.kt", 9)];
    const r = mergeSymbols(index, lsp, "ord", opts);
    expect(r.items.map((i) => i.name)).toEqual(["orderCount", "ordinal", "ordersTotal"]);
    expect(r.items[2]!.lsp).toBe(true);
    expect(r.items[2]!.indices).toEqual([0, 1, 2]);
    expect(r.items[2]!.rel).toBe("C.kt");
  });

  it("puts exact LSP hits before fuzzy index hits", () => {
    const index = [sym("orderCount", "method", "/p/A.kt", 3)];
    const lsp = [ws("ord", "function", "/p/C.kt", 9)];
    expect(mergeSymbols(index, lsp, "ord", opts).items.map((i) => i.name)).toEqual(["ord", "orderCount"]);
  });

  it("filters non-project LSP symbols unless included", () => {
    const lsp = [ws("orderLib", "function", "/usr/lib/x.kt", 1)];
    expect(mergeSymbols([], lsp, "ord", opts).items).toHaveLength(0);
    expect(mergeSymbols([], lsp, "ord", { ...opts, includeNonProject: true }).items[0]!.rel).toBe("/usr/lib/x.kt");
  });

  it("applies type filters and reports overflow", () => {
    const index = [
      sym("Order", "class", "/p/A.kt", 0),
      sym("order", "variable", "/p/A.kt", 2),
      sym("OrderKind", "enum", "/p/A.kt", 5),
    ];
    expect(mergeSymbols(index, [], "ord", { ...opts, typesOnly: true }).items.map((i) => i.name)).toEqual([
      "Order",
      "OrderKind",
    ]);
    expect(mergeSymbols(index, [], "ord", { ...opts, excludeTypes: true }).items.map((i) => i.name)).toEqual(["order"]);
    const limited = mergeSymbols(index, [], "ord", { ...opts, limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.hasMore).toBe(true);
  });

  it("decorates callables with ()", () => {
    expect(mergeSymbols([sym("run", "function", "/p/A.kt", 0)], [], "run", opts).items[0]!.display).toBe("run()");
  });
});

describe("matchActions", () => {
  const act = (id: string, title: string, extra: Partial<Action> = {}): Action => ({
    id,
    title,
    run: () => {},
    ...extra,
  });
  const actions = [
    act("code.optimizeImports", "Optimize Imports", { category: "Code" }),
    act("run.editConfigs", "Edit Configurations…", { keywords: ["run config"] }),
    act("internal.thing", "Optimize Secret", { hidden: true }),
    act("code.reformat", "Reformat Code", { when: "editorFocus" }),
  ];
  const isEnabled = (a: Action) => a.when !== "editorFocus";

  it("matches titles with highlight indices, skipping hidden actions", () => {
    const r = matchActions(actions, "opt", { isEnabled, recent: [] });
    expect(r.map((a) => a.id)).toEqual(["code.optimizeImports"]);
    expect(r[0]!.indices).toEqual([0, 1, 2]);
  });

  it("falls back to keywords/category without indices", () => {
    const r = matchActions(actions, "run config", { isEnabled, recent: [] });
    expect(r[0]!.id).toBe("run.editConfigs");
  });

  it("ranks disabled actions lower but keeps them (greyed)", () => {
    const r = matchActions([actions[3]!, act("x.code", "Code Cleanup")], "code", { isEnabled, recent: [] });
    expect(r.map((a) => [a.id, a.enabled])).toEqual([
      ["x.code", true],
      ["code.reformat", false],
    ]);
  });

  it("boosts recently used actions", () => {
    const two = [act("a.one", "Show Diff Left"), act("a.two", "Show Diff Right")];
    expect(matchActions(two, "show diff", { isEnabled, recent: ["a.two"] })[0]!.id).toBe("a.two");
  });

  it("rejects scattered letters but keeps substrings and word starts", () => {
    const list = [
      act("a.mute", "Mute Breakpoints"),
      act("a.step", "Smart Step Into"),
      act("a.perf", "Toggle Performance Overlay (Dev)"),
      act("a.split", "Split Right"),
      act("a.menu", "Main Menu"),
    ];
    expect(matchActions(list, "main", { isEnabled, recent: [] }).map((a) => a.id)).toEqual(["a.menu"]);
    expect(matchActions(list, "split", { isEnabled, recent: [] }).map((a) => a.id)).toEqual(["a.split"]);
    expect(matchActions(list, "tpo", { isEnabled, recent: [] }).map((a) => a.id)).toEqual(["a.perf"]);
    expect(matchActions(list, "ssi", { isEnabled, recent: [] }).map((a) => a.id)).toEqual(["a.step"]);
  });

  it("returns nothing for an empty query", () => {
    expect(matchActions(actions, "  ", { isEnabled, recent: [] })).toEqual([]);
  });
});

describe("items and rows", () => {
  it("fileItem splits name and directory highlights", () => {
    const f = fileItem(
      { path: "/p/src/orders/OrderController.kt", relPath: "src/orders/OrderController.kt", indices: [4, 11, 12, 16] },
      41,
      null,
    );
    expect(f.name).toBe("OrderController.kt");
    expect(f.dir).toBe("src/orders");
    expect(f.nameIndices).toEqual([0, 1, 5]);
    expect(f.line).toBe(41);
  });

  it("textItems collapses indentation and shifts ranges", () => {
    const [t] = textItems("/p/a.kt", "a.kt", [
      { line: 4, text: "\t\t  val order = 1", ranges: [[8, 13]], textOffset: 0 },
    ]);
    expect(t!.text).toBe("  val order = 1");
    expect(t!.indices).toEqual([6, 7, 8, 9, 10]);
    expect([t!.col, t!.endCol]).toEqual([8, 13]);
  });

  it("buildRows orders sections, adds headers and more rows", () => {
    const sections = new Map<SectionId, SectionState>([
      [
        "actions",
        {
          items: matchActions([{ id: "a", title: "Order", run: () => {} }], "ord", {
            isEnabled: () => true,
            recent: [],
          }),
          hasMore: false,
          loading: false,
        },
      ],
      [
        "files",
        { items: [fileItem({ path: "/p/O.kt", relPath: "O.kt", indices: [] })], hasMore: true, loading: false },
      ],
      ["classes", { items: [], hasMore: false, loading: true }],
    ]);
    const rows = buildRows(sections, { headers: true });
    expect(rows.map((r) => r.kind)).toEqual(["section", "file", "more", "section", "action"]);
    expect(buildRows(sections, { headers: false }).map((r) => r.kind)).toEqual(["file", "more", "action"]);
  });

  it("buildRows interleaves the All tab by relevance, keeping each source's order", () => {
    const file = (rel: string) => fileItem({ path: `/p/${rel}`, relPath: rel, indices: [] });
    const sections = new Map<SectionId, SectionState>([
      ["files", { items: [file("src/upload_gray.py"), file("src/upgrade.py")], hasMore: true, loading: false }],
      ["symbols", { items: [symbolItem(sym("upgrade", "function", "/p/m.py", 3))], hasMore: false, loading: false }],
      [
        "text",
        {
          items: textItems("/p/a.md", "a.md", [{ line: 0, text: "upgrade", ranges: [[0, 3]], textOffset: 0 }]),
          hasMore: false,
          loading: false,
        },
      ],
    ]);
    const rows = buildRows(sections, { headers: false, mix: "upg" });
    expect(rows.map((r) => (r.kind === "more" ? `more:${r.section}` : (r as { section: SectionId }).section))).toEqual([
      "symbols",
      "files",
      "files",
      "text",
      "more:files",
    ]);
    // The index ranked upload_gray first; mixing must not reorder within files.
    expect(rows.filter((r) => r.kind === "file").map((r) => (r as { name: string }).name)).toEqual([
      "upload_gray.py",
      "upgrade.py",
    ]);
  });

  it("stableIndex keeps the selected key while rows stream in", () => {
    const sections = new Map<SectionId, SectionState>([
      [
        "files",
        {
          items: [
            fileItem({ path: "/p/A.kt", relPath: "A.kt", indices: [] }),
            fileItem({ path: "/p/B.kt", relPath: "B.kt", indices: [] }),
          ],
          hasMore: false,
          loading: false,
        },
      ],
    ]);
    const before = buildRows(sections, { headers: true });
    const key = before[2]!.key;
    sections.set("classes", {
      items: [fileItem({ path: "/p/C.kt", relPath: "C.kt", indices: [] })],
      hasMore: false,
      loading: false,
    });
    const after = buildRows(sections, { headers: true });
    expect(after[stableIndex(after, key, 2, true)]!.key).toBe(key);
    // Without a user selection the first selectable row wins.
    expect(stableIndex(after, null, -1, false)).toBe(1);
    // A vanished key after navigation clamps to the previous index.
    expect(stableIndex(after, "gone", 3, true)).toBe(3);
  });

  it("sectionsFor picks sources per tab and empty query", () => {
    expect(sectionsFor("all", true)).toEqual(["recent", "recentActions"]);
    expect(sectionsFor("classes", true)).toEqual([]);
    expect(sectionsFor("all", false)).toEqual(["classes", "files", "symbols", "endpoints", "actions", "text"]);
    expect(sectionsFor("text", false)).toEqual(["text"]);
    expect(sectionsFor("routes", false)).toEqual(["endpoints"]);
    expect(sectionsFor("routes", true)).toEqual([]);
  });
});

describe("topResultSettled", () => {
  const sec = (loading: boolean, n = 0): SectionState => ({
    items: Array.from({ length: n }, () => ({}) as never),
    hasMore: false,
    loading,
  });

  it("waits while a section above the first result is loading", () => {
    expect(
      topResultSettled(
        new Map([
          ["classes", sec(true)],
          ["files", sec(false, 2)],
        ]),
      ),
    ).toBe(false);
  });

  it("is settled once the first section with items is done, even if later ones load", () => {
    expect(
      topResultSettled(
        new Map([
          ["classes", sec(false)],
          ["files", sec(false, 1)],
          ["text", sec(true)],
        ]),
      ),
    ).toBe(true);
  });

  it("with mixing waits for every source but a text search the top row already beats", () => {
    const strong = {
      items: [fileItem({ path: "/p/upgrade.py", relPath: "upgrade.py", indices: [] })],
      hasMore: false,
      loading: false,
    };
    expect(
      topResultSettled(
        new Map([
          ["files", strong],
          ["symbols", sec(true)],
        ]),
        "upg",
      ),
    ).toBe(false);
    expect(
      topResultSettled(
        new Map([
          ["files", strong],
          ["text", sec(true)],
        ]),
        "upg",
      ),
    ).toBe(true);
    const weak = { ...strong, items: [fileItem({ path: "/p/xuxpxg.py", relPath: "xuxpxg.py", indices: [] })] };
    expect(
      topResultSettled(
        new Map([
          ["files", weak],
          ["text", sec(true)],
        ]),
        "upg",
      ),
    ).toBe(false);
  });

  it("is settled when everything finished empty", () => {
    expect(topResultSettled(new Map([["files", sec(false)]]))).toBe(true);
  });
});

describe("parseCommand", () => {
  it("lists scope commands matching the typed prefix", () => {
    const c = parseCommand("/");
    expect(c?.kind === "list" && c.rows.map((r) => (r as { name: string }).name)).toEqual([
      "/classes",
      "/files",
      "/symbols",
      "/routes",
      "/actions",
      "/text",
    ]);
    const fi = parseCommand("/FI");
    expect(fi?.kind === "list" && fi.rows.map((r) => r.key)).toEqual(["cmd:files"]);
  });

  it("runs a complete command followed by a space", () => {
    expect(parseCommand("/files upg")).toEqual({ kind: "run", tab: "files", rest: "upg" });
    expect(parseCommand("/text ")).toEqual({ kind: "run", tab: "text", rest: "" });
  });

  it("leaves paths and other queries alone", () => {
    expect(parseCommand("/Users/me/a.py")).toBeNull();
    expect(parseCommand("/fil x")).toBeNull();
    expect(parseCommand("upg")).toBeNull();
  });
});

describe("Search Everywhere initial text", () => {
  it("each tab starts with its own last query; closing remembers the text", async () => {
    const { hideSearchEverywhere, selectSearchEverywhereTab, showSearchEverywhere, useSearchEverywhere } =
      await import("../everywhere/store");
    localStorage.clear();
    showSearchEverywhere("files");
    useSearchEverywhere.setState({ query: "Order" });
    hideSearchEverywhere();
    showSearchEverywhere("classes");
    expect(useSearchEverywhere.getState().query).toBe("");
    useSearchEverywhere.setState({ query: "Pizza" });
    selectSearchEverywhereTab("symbols");
    hideSearchEverywhere();
    showSearchEverywhere("files");
    expect(useSearchEverywhere.getState().query).toBe("Order");
    hideSearchEverywhere();
    showSearchEverywhere("symbols", { query: "sel" });
    expect(useSearchEverywhere.getState().query).toBe("sel");
    hideSearchEverywhere();
    showSearchEverywhere("classes");
    expect(useSearchEverywhere.getState().query).toBe("");
    hideSearchEverywhere();
  });
});
