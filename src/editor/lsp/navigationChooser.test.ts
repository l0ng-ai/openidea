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
    expect(item.detail).toBe("_StatefulDataset · src/mod.py:4");
    // No signature preview line in the row.
    expect(item.preview).toBeUndefined();
  });

  it("truncates absolute paths outside the project to a tail", async () => {
    const path = "B:/Program/Open/torchitan/tests/unit_tests/test_data.py";
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([[path, lines]]));
    project("/p");
    const item = (await locationItems([target(path, "refresh", 3)]))[0]!;
    expect(item.detail).toBe("_StatefulDataset · …/unit_tests/test_data.py:4");
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
    expect(item.detail).not.toContain("does");
    expect(item.detail).toContain("_StatefulDataset");
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
    expect(item.detail).not.toContain("factory");
    expect(item.detail).not.toContain("helper");
    expect(item.detail).toContain("_StatefulDataset");
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
    expect(item.detail).toContain("_StatefulDataset");
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
    expect(item.detail).not.toContain("class");
    expect(item.detail).toContain("DatasetMixin");
  });

  it("falls back to the enclosing-type heuristic when the index misses", async () => {
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    findSymbols.mockResolvedValue([]);
    project("/p");
    const item = (await locationItems([target("/p/src/mod.py", "refresh", 3)]))[0]!;
    expect(item.detail).toContain("_StatefulDataset");
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
    expect(item.detail).toBe("config · src/mod.py:1");
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
