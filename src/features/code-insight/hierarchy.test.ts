import { describe, expect, it, vi } from "vitest";
import type { HierarchyItem, OutlineItem, ReferencesIncomplete, SymbolKind } from "@/bindings";

const hint = vi.fn();
const hide = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ show: () => undefined, hide }),
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
// Subtypes by the line of the type asked about: the caret's type → Long (30), Striped64 (40); Striped64 → LongAdder (50).
const typeItem = (name: string, line: number): HierarchyItem => ({
  ...item(name),
  kind: "class",
  path: "/p/Types.java",
  selectionRange: range(line, 0, line, name.length),
});
const typeHierarchy = vi.fn((pos: { line: number; col: number }): HierarchyItem[] =>
  pos.line === 40
    ? [typeItem("LongAdder", 50)]
    : pos.line < 30
      ? [typeItem("Long", 30), typeItem("Striped64", 40)]
      : [],
);
// The positions a hierarchy request is answered at; anything else is "no symbol".
let servedAt = (pos: { line: number; col: number }) => pos.line === 2 && pos.col === 7;

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: async <T>(p: Promise<T>) => p,
    commands: {
      ...real.commands,
      docOutline: async () => OUTLINE,
      cancelRequest,
      lspTypeHierarchy: async (_doc: number, pos: { line: number; col: number }) => typeHierarchy(pos),
      lspCallHierarchy: async (_request: number, _doc: number, pos: { line: number; col: number }) => {
        // The server prepares a hierarchy only on the method name.
        if (!servedAt(pos)) throw new real.IpcError({ kind: "notFound", message: "No symbol" });
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
  loadChildren,
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

  it("keeps a caller that repeats an ancestor a recursion leaf", async () => {
    servedAt = () => true; // `main` calls itself: every level answers with the same item.
    try {
      useHierarchy.setState({ mode: "call", direction: "incoming" });
      await showHierarchy("call");
      const [top] = useHierarchy.getState().children.get(ROOT_ID) ?? [];
      expect(top?.item.name).toBe("main");
      expect(top?.recursion).toBeUndefined();
      await loadChildren(top!);
      const nested = useHierarchy.getState().children.get(top!.id)?.[0];
      expect(nested?.item.name).toBe("main");
      expect(nested?.recursion).toBe(true);
      // The leaf carries no expandable children, so the tree never requests it again.
      expect(useHierarchy.getState().children.get(nested!.id)).toEqual([]);
      expect(useHierarchy.getState().failed.size).toBe(0);
    } finally {
      servedAt = (pos) => pos.line === 2 && pos.col === 7;
    }
  });
});

describe("type hierarchy", () => {
  it("loads each shown type's level ahead, so a type without subtypes shows no expand arrow", async () => {
    servedAt = () => true;
    try {
      useHierarchy.setState({ mode: "type", direction: "outgoing" });
      await showHierarchy("type");
      const [long, striped] = useHierarchy.getState().children.get(ROOT_ID) ?? [];
      await vi.waitFor(() => {
        const { children } = useHierarchy.getState();
        expect(children.get(long!.id)).toEqual([]);
        expect(children.get(striped!.id)?.map((n) => n.item.name)).toEqual(["LongAdder"]);
      });
      const { children } = useHierarchy.getState();
      // Only the shown levels: LongAdder's subtypes wait until Striped64 is expanded.
      expect(children.has(children.get(striped!.id)![0]!.id)).toBe(false);
    } finally {
      servedAt = (pos) => pos.line === 2 && pos.col === 7;
      useHierarchy.setState({ mode: "call", direction: "incoming" });
    }
  });
});

describe("closing the hierarchy tab", () => {
  it("clears the tree and hides the tool window", async () => {
    const { closeHierarchy, useHierarchy } = await import("./hierarchy");
    useHierarchy.setState({ root: { name: "Number", path: "/p/Number.java", line: 0, col: 0 } as never });
    closeHierarchy();
    expect(useHierarchy.getState().root).toBeNull();
    expect(hide).toHaveBeenCalledWith("hierarchy");
  });
});
