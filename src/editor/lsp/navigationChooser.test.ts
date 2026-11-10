/**
 * Chooser rows (`locationItems`): every extra the pre-settings rows showed is on
 * by default (seamless upgrade); Settings › Editor › Location Choosers turns the
 * signature preview, file name, path and full outside paths off for lean rows.
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

const target = (path: string, line: string): Parameters<typeof locationItems>[0][number] => ({
  path,
  uri: null,
  range: { start: { line: 1, col: line.indexOf("_StatefulDataset") }, end: { line: 1, col: line.length } },
});

/** Sets the project root and the chooser extras for one test (unset keys fall back to the defaults). */
function project(chooser: Record<string, boolean>) {
  useProject.setState({
    project: { root: "/p" } as never,
    settings: { editor: { chooser } } as never,
  });
}

/** The lean row: extras off except the (truncatable) path. */
function lean() {
  return project({ signature: false, fileName: false, fullPath: false });
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
  it("keeps the pre-settings rows by default (seamless upgrade)", async () => {
    const line = "class _StatefulDataset(Base):";
    const path = "B:/Program/Open/torchitan/tests/unit_tests/test_data.py";
    readManyFileLines.mockResolvedValue(new Map([[path, ["", line]]]));
    project({});
    const item = (await locationItems([target(path, line)]))[0]!;
    expect(item.label).toBe("_StatefulDataset");
    expect(item.detail).toBe(`${path.split("/").pop()} · ${path}:2`);
    expect(item.preview).toBe(line);
  });

  it("shows name and project-relative path:line with the extras off", async () => {
    const line = "class _StatefulDataset(Base):";
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", ["", line]]]));
    lean();
    const item = (await locationItems([target("/p/src/mod.py", line)]))[0]!;
    expect(item.label).toBe("_StatefulDataset");
    expect(item.detail).toBe("src/mod.py:2");
    expect(item.preview).toBeUndefined();
  });

  it("truncates absolute paths outside the project to a tail", async () => {
    const line = "class _StatefulDataset(Base):";
    const path = "B:/Program/Open/torchitan/tests/unit_tests/test_data.py";
    readManyFileLines.mockResolvedValue(new Map([[path, ["", line]]]));
    lean();
    const item = (await locationItems([target(path, line)]))[0]!;
    expect(item.detail).toBe("…/unit_tests/test_data.py:2");
  });

  it("shows full paths, file names and signature previews when enabled", async () => {
    const line = "class _StatefulDataset(Base):";
    const path = "B:/Program/Open/torchitan/tests/unit_tests/test_data.py";
    readManyFileLines.mockResolvedValue(new Map([[path, ["", line]]]));
    project({ signature: true, fileName: true, path: true, fullPath: true });
    const item = (await locationItems([target(path, line)]))[0]!;
    expect(item.detail).toBe(`${path.split("/").pop()} · ${path}:2`);
    expect(item.preview).toBe(line);
  });

  it("hides the path, keeping the file name, when the path is off", async () => {
    const line = "class _StatefulDataset(Base):";
    const path = "/p/src/mod.py";
    readManyFileLines.mockResolvedValue(new Map([[path, ["", line]]]));
    project({ fileName: true, path: false });
    const item = (await locationItems([target(path, line)]))[0]!;
    expect(item.detail).toBe("mod.py");
  });

  it("reduces index symbols to the container when the path is off", async () => {
    project({ path: false });
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
    expect(item.detail).toBe("config");
  });

  it("drops the container of index symbols when the container is off", async () => {
    readManyFileLines.mockResolvedValue(new Map());
    project({ container: false });
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
    expect(item.detail).toBe("src/mod.py:1");
  });

  it("shows the enclosing type of server targets when the container is on", async () => {
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    project({});
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 3, col: 8 }, end: { line: 3, col: 15 } },
        },
      ])
    )[0]!;
    expect(item.label).toBe("refresh");
    expect(item.detail).toBe("_StatefulDataset · mod.py · src/mod.py:4");
  });

  it("hides the container of server targets when the container is off", async () => {
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    project({ container: false, fileName: false });
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 3, col: 8 }, end: { line: 3, col: 15 } },
        },
      ])
    )[0]!;
    expect(item.detail).toBe("src/mod.py:4");
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
    project({});
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 5, col: 8 }, end: { line: 5, col: 15 } },
        },
      ])
    )[0]!;
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
    project({});
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 8, col: 8 }, end: { line: 8, col: 15 } },
        },
      ])
    )[0]!;
    expect(item.detail).not.toContain("factory");
    expect(item.detail).not.toContain("helper");
    expect(item.detail).toContain("_StatefulDataset");
  });

  it("prefers the index container over the enclosing-type heuristic", async () => {
    const line = "    def refresh(self) -> None:";
    const lines = ["", "class _StatefulDataset(Base):", "", "    # a class does mention here", line];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    findSymbols.mockResolvedValue([
      {
        name: "refresh",
        kind: "method",
        container: "DatasetMixin",
        path: "/p/src/mod.py",
        range: { start: { line: 4, col: 4 } },
      },
    ]);
    project({});
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 4, col: 4 }, end: { line: 4, col: 11 } },
        },
      ])
    )[0]!;
    // The index's answer wins even though the heuristic would answer from the comment.
    expect(item.detail).not.toContain("class");
    expect(item.detail).toContain("DatasetMixin");
  });

  it("falls back to the enclosing-type heuristic when the index misses", async () => {
    const lines = ["", "class _StatefulDataset(Base):", "", "    def refresh(self) -> None:"];
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", lines]]));
    findSymbols.mockResolvedValue([]);
    project({});
    const item = (
      await locationItems([
        {
          path: "/p/src/mod.py",
          uri: null,
          range: { start: { line: 3, col: 8 }, end: { line: 3, col: 15 } },
        },
      ])
    )[0]!;
    expect(item.detail).toContain("_StatefulDataset");
  });

  it("keeps index symbols' container detail", async () => {
    readManyFileLines.mockResolvedValue(new Map());
    project({});
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
    expect(item.preview).toBeUndefined();
  });
});
