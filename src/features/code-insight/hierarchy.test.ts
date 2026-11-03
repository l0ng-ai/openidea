import { describe, expect, it, vi } from "vitest";
import type { HierarchyItem, OutlineItem, ReferencesIncomplete, SymbolKind } from "@/bindings";

const hint = vi.fn();
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ show: () => undefined }),
}));

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, col: c1 },
  end: { line: l2, col: c2 },
});
const outlineItem = (
  name: string,
  kind: SymbolKind,
  r: ReturnType<typeof range>,
  nameAt: [number, number],
  children: OutlineItem[] = [],
): OutlineItem => ({
  name,
  detail: null,
  kind,
  range: r,
  selection_range: range(nameAt[0], nameAt[1], nameAt[0], nameAt[1] + name.length),
  children,
});
// class Orders { void list() { int x = 1; } }  — class on lines 0-10, `list` on lines 2-6.
const OUTLINE = [
  outlineItem(
    "Orders",
    "class",
    range(0, 0, 10, 1),
    [0, 6],
    [
      outlineItem("list", "method", range(2, 2, 6, 3), [2, 7]),
      outlineItem("count", "field", range(8, 2, 8, 12), [8, 6]),
    ],
  ),
];

const item = (name: string, fromRanges: HierarchyItem["fromRanges"] = []): HierarchyItem => ({
  name,
  kind: "method",
  detail: null,
  path: "/p/Caller.java",
  range: range(10, 0, 20, 1),
  selectionRange: range(10, 7, 10, 7 + name.length),
  fromRanges,
});

const callHierarchy = vi.fn((): { items: HierarchyItem[]; incomplete: ReferencesIncomplete | null } => ({
  items: [item("main", [range(12, 4, 12, 8)])],
  incomplete: null,
}));
const cancelRequest = vi.fn(async () => undefined);

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: async <T>(p: Promise<T>) => p,
    commands: {
      ...real.commands,
      docOutline: async () => OUTLINE,
      cancelRequest,
      lspCallHierarchy: async (_request: number, _doc: number, pos: { line: number; col: number }) => {
        // The server prepares a hierarchy only on the method name.
        if (pos.line !== 2 || pos.col !== 7) throw new real.IpcError({ kind: "notFound", message: "No symbol" });
        return callHierarchy();
      },
    },
  };
});
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  caretContext: () => ({ doc: 1, path: "/p/Orders.java", line: 4, col: 10, word: "x", view: null }),
  withDocument: async <T>(_path: string, fn: (doc: number) => Promise<T>) => fn(1),
  lspRequest: async <T>(run: () => Promise<T>) => run(),
  hint: (...a: unknown[]) => hint(...a),
}));

const {
  enclosingDeclaration,
  hierarchyTarget,
  refreshHierarchy,
  resetHierarchy,
  showHierarchy,
  useHierarchy,
  ROOT_ID,
} = await import("./hierarchy");

describe("hierarchy", () => {
  it("finds the innermost enclosing declaration of the wanted kinds", () => {
    const calls = new Set<SymbolKind>(["method", "function", "constructor"]);
    const types = new Set<SymbolKind>(["class"]);
    expect(enclosingDeclaration(OUTLINE, { line: 4, col: 10 }, calls)?.name).toBe("list");
    expect(enclosingDeclaration(OUTLINE, { line: 4, col: 10 }, types)?.name).toBe("Orders");
    expect(enclosingDeclaration(OUTLINE, { line: 8, col: 4 }, calls)).toBeNull();
    expect(enclosingDeclaration(OUTLINE, { line: 12, col: 0 }, types)).toBeNull();
  });

  it("navigates callers to their call site, other nodes to the symbol", () => {
    const caller = item("main", [range(12, 4, 12, 8), range(14, 4, 14, 8)]);
    expect(hierarchyTarget("call", "incoming", caller)).toEqual({ path: "/p/Caller.java", line: 12, col: 4 });
    expect(hierarchyTarget("call", "outgoing", caller)).toEqual({ path: "/p/Caller.java", line: 10, col: 7 });
    expect(hierarchyTarget("type", "incoming", item("Base"))).toEqual({ path: "/p/Caller.java", line: 10, col: 7 });
  });

  it("retries at the enclosing method when nothing is at the caret", async () => {
    useHierarchy.setState({ mode: "call", direction: "incoming" });
    await showHierarchy("call");
    const s = useHierarchy.getState();
    expect(s.root).toEqual({ name: "list", path: "/p/Orders.java", line: 2, col: 7 });
    expect(s.children.get(ROOT_ID)?.map((n) => n.item.name)).toEqual(["main"]);
    expect(s.failed.size).toBe(0);
    expect(s.notes.size).toBe(0);
    expect(hint).not.toHaveBeenCalled();
  });

  it("notes a level whose callers may be incomplete, until it is loaded again", async () => {
    useHierarchy.setState({ mode: "call", direction: "incoming" });
    callHierarchy.mockReturnValueOnce({ items: [item("main")], incomplete: "tooManyFiles" });
    await showHierarchy("call");
    expect(useHierarchy.getState().notes.get(ROOT_ID)).toBe(
      "May be incomplete: too many files mention 'list' to search them all",
    );
    refreshHierarchy();
    await vi.waitFor(() => expect(useHierarchy.getState().children.get(ROOT_ID)).toBeDefined());
    expect(useHierarchy.getState().notes.size).toBe(0);
  });

  it("cancels the requests of a tree that is replaced", async () => {
    useHierarchy.setState({ mode: "call", direction: "incoming" });
    await showHierarchy("call");
    cancelRequest.mockClear();
    let answer: (v: ReturnType<typeof callHierarchy>) => void = () => {};
    callHierarchy.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    refreshHierarchy();
    await vi.waitFor(() => expect(callHierarchy).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    resetHierarchy();
    expect(cancelRequest).toHaveBeenCalledTimes(1);
    answer({ items: [item("stale")], incomplete: null });
  });
});
