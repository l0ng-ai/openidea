/**
 * Chooser rows (`locationItems`): icon + name, the container, and `path:line`,
 * like IDEA's Choose Declaration / Implementation (no row details to configure;
 * no signature preview line).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readManyFileLines, findSymbols } = vi.hoisted(() => ({
  readManyFileLines: vi.fn<() => Promise<Map<string, string[] | null>>>(async () => new Map()),
  findSymbols: vi.fn<
    (
      query: string,
      filter: string,
      limit: number,
    ) => Promise<
      Array<{
        name: string;
        kind: string;
        container: string | null;
        path: string;
        range: { start: { line: number; col: number } };
      }>
    >
  >(async () => []),
}));
vi.mock("./files", async (orig) => {
  const real = await orig<typeof import("./files")>();
  return { ...real, readManyFileLines };
});
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, call: (p: Promise<unknown>) => p, commands: { ...real.commands, findSymbols } };
});

const { locationItems } = await import("./navigation");
const { useProject } = await import("@/platform/project");

/** A server target on the line that holds `name` (col at the identifier). */
const target = (path: string, name: string, at = 1): Parameters<typeof locationItems>[0][number] => {
  const line = `    def ${name}(self) -> None:`;
  return {
    path,
    uri: null,
    range: { start: { line: at, col: line.indexOf(name) }, end: { line: at, col: line.length } },
  };
};

/** Sets the project root for one test. */
function project(root: string) {
  useProject.setState({ project: { root } as never });
}

beforeEach(() => {
  useProject.setState({ project: null, settings: null });
  findSymbols.mockReset();
  findSymbols.mockResolvedValue([]);
});
afterEach(() => {
  useProject.setState({ project: null, settings: null });
  vi.restoreAllMocks();
});

describe("locationItems", () => {
  it("shows the name, container and project-relative path:line", async () => {
    const line = "class _StatefulDataset(Base):";
    const lines = ["", line, "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 3)]))[0]!;
    expect(item.label).toBe("refresh");
    expect(item.target).toEqual({ container: "_StatefulDataset", path: "src/mod.py:4" });
    // No signature preview line in the row.
    expect(item.preview).toBeUndefined();
  });

  it("truncates absolute paths outside the project to a tail", async () => {
    const path = "B:/Program/Open/torchitan/tests/unit_tests/test_data.py";
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([[path, lines]]));
    project("/p");
    const item = (await locationItems([target(path, "refresh", 3)]))[0]!;
    expect(item.target).toEqual({ container: "_StatefulDataset", path: "…/unit_tests/test_data.py:4" });
  });

  it("does not take the container from a line comment mentioning 'class'", async () => {
    const lines = [
      "",
      "class _StatefulDataset(Base):",
      "",
      "    # the base class does all that is needed.",
      "",
      "    def refresh(self) -> None:",
    ];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 5)]))[0]!;
    expect(item.target?.container).toBe("_StatefulDataset");
  });

  it("does not take the container from a docstring mentioning 'class'", async () => {
    const lines = [
      "",
      "class _StatefulDataset(Base):",
      "",
      '    """Wrapper around the class factory.',
      "",
      "    Use the class helper first.",
      '    """',
      "",
      "    def refresh(self) -> None:",
    ];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 8)]))[0]!;
    expect(item.target?.container).toBe("_StatefulDataset");
  });

  it("does not open a docstring fence inside a comment", async () => {
    const lines = [
      "",
      "class _StatefulDataset(Base):",
      "",
      '    # mentions """ below, which must not open a docstring',
      "    # (unterminated-fence paranoia)",
      "    def refresh(self) -> None:",
    ];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 5)]))[0]!;
    // The scan must still reach the class declaration above the comment lines.
    expect(item.target?.container).toBe("_StatefulDataset");
  });

  it("prefers the index container over the enclosing-type heuristic", async () => {
    const lines = [
      "",
      "class _StatefulDataset(Base):",
      "",
      "    # a class does mention here",
      "    def refresh(self) -> None:",
    ];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    findSymbols.mockResolvedValue([
      {
        name: "refresh",
        kind: "method",
        container: "DatasetMixin",
        path: "/p/src/mod.py",
        range: { start: { line: 4, col: 8 } },
      },
    ]);
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 4)]))[0]!;
    // The index's answer wins even though the heuristic would answer from the comment.
    expect(item.target?.container).toBe("DatasetMixin");
  });

  it("falls back to the enclosing-type heuristic when the index misses", async () => {
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    findSymbols.mockResolvedValue([]);
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 3)]))[0]!;
    expect(item.target?.container).toBe("_StatefulDataset");
  });

  it("keeps index symbols' own container detail", async () => {
    readManyFileLines.mockResolvedValue(new Map());
    project("/p");
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 0, col: 0 }, end: { line: 0, col: 3 } },
          name: "Configurable",
          kind: "class" as never,
          container: "config",
        },
      ])
    )[0]!;
    expect(item.label).toBe("Configurable");
    expect(item.target).toEqual({ container: "config", path: "src/mod.py:1" });
  });

  it("names same-named targets (a method's implementations) by their containers", async () => {
    const lines = (cls: string) => ["", `class ${cls}(Base):`, "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(
      new Map([
        ["/p/src/a.py", lines("Cached")],
        ["/p/src/b.py", lines("Remote")],
      ]),
    );
    project("/p");
    const items = await locationItems([target("/p/src/a.py", "refresh", 3), target("/p/src/b.py", "refresh", 3)]);
    expect(items.map((i) => [i.label, i.target])).toEqual([
      ["Cached", { container: null, path: "src/a.py:4" }],
      ["Remote", { container: null, path: "src/b.py:4" }],
    ]);
    // A single target, or targets with different names, keep their own names.
    expect((await locationItems([target("/p/src/a.py", "refresh", 3)]))[0]!.label).toBe("refresh");
  });

  describe("takes the container only from a type whose body holds the target", () => {
    const cart = [
      'import { type Cents } from "./money.ts";',
      "",
      "export interface Product {",
      "  id: string;",
      "  price: Cents;",
      "}",
      "",
      "export interface CartLine {",
      "  product: Product;",
      "  quantity: number;",
      "}",
      "",
      'export type Discount = { kind: "percent"; percent: number } | { kind: "fixed"; amount: Cents };',
      "",
      "export class Cart {",
      "  private discount: Discount | null = null;",
      "",
      "  total(): Cents {",
      "    return 0;",
      "  }",
      "}",
    ];
    const at = (line: number, col: number) => ({
      path: "/p/src/cart.ts",
      uri: null,
      range: { start: { line, col }, end: { line, col: col + 1 } },
    });
    beforeEach(() => {
      readManyFileLines.mockResolvedValue(new Map([["/p/src/cart.ts", cart]]));
      project("/p");
    });

    it("anonymous targets after a closed interface", async () => {
      const union = cart[12]!;
      const items = await locationItems([at(12, union.indexOf("{")), at(12, union.lastIndexOf("{ kind"))]);
      expect(items.map((i) => [i.label, i.target])).toEqual([
        ["cart.ts", { container: null, path: "src/cart.ts:13" }],
        ["cart.ts", { container: null, path: "src/cart.ts:13" }],
      ]);
    });

    it("a named target after a closed interface", async () => {
      const item = (await locationItems([at(7, cart[7]!.indexOf("CartLine"))]))[0]!;
      expect([item.label, item.target]).toEqual(["CartLine", { container: null, path: "src/cart.ts:8" }]);
    });

    it("a member after a closed type, inside its own class", async () => {
      const item = (await locationItems([at(17, cart[17]!.indexOf("total"))]))[0]!;
      expect([item.label, item.target]).toEqual(["total", { container: "Cart", path: "src/cart.ts:18" }]);
    });

    it("indentation-delimited bodies: a function after a class, a method after a dict literal", async () => {
      const lines = [
        "class Config:",
        "    defaults = {}",
        "",
        "    def load(self) -> None:",
        "        pass",
        "",
        "def main() -> None:",
        "    pass",
      ];
      readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
      const items = await locationItems([target("/p/src/mod.py", "load", 3), target("/p/src/mod.py", "main", 6)]);
      expect(items.map((i) => i.target)).toEqual([
        { container: "Config", path: "src/mod.py:4" },
        { container: null, path: "src/mod.py:7" },
      ]);
      const main = {
        ...target("/p/src/mod.py", "main", 6),
        range: { start: { line: 6, col: 0 }, end: { line: 6, col: 3 } },
      };
      expect((await locationItems([main]))[0]!.target).toEqual({ container: null, path: "src/mod.py:7" });
    });

    it("Go: a method's container is its receiver, declared outside the struct's body", async () => {
      const lines = [
        "type Square struct {",
        "\tside float64",
        "}",
        "",
        "func (s *Square) Area() float64 {",
        "\treturn 0",
        "}",
      ];
      readManyFileLines.mockResolvedValue(new Map([["/p/shapes.go", lines]]));
      const at = { path: "/p/shapes.go", uri: null, range: { start: { line: 4, col: 17 }, end: { line: 4, col: 21 } } };
      expect((await locationItems([at]))[0]!.target).toEqual({ container: "Square", path: "shapes.go:5" });
    });
  });

  it("does not query the index for index symbols, which carry their container", async () => {
    readManyFileLines.mockResolvedValue(new Map());
    project("/p");
    await locationItems([
      {
        path: "/p/src/mod.py",
        uri: null,
        range: { start: { line: 0, col: 0 }, end: { line: 0, col: 3 } },
        name: "Configurable",
        kind: "class" as never,
        container: "config",
      },
    ]);
    expect(findSymbols).not.toHaveBeenCalled();
  });
});
