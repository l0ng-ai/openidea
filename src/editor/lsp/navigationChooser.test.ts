/**
 * Chooser rows (`locationItems`): lean `name  path:line` by default, like IDEA's
 * chooser; the signature preview, file name, path and full paths outside the
 * project come from Settings › Editor › Location Choosers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readManyFileLines } = vi.hoisted(() => ({
  readManyFileLines: vi.fn<() => Promise<Map<string, string[] | null>>>(async () => new Map()),
}));
vi.mock("./files", async (orig) => {
  const real = await orig<typeof import("./files")>();
  return { ...real, readManyFileLines };
});

const { locationItems } = await import("./navigation");
const { useProject } = await import("@/platform/project");

const target = (path: string, line: string): Parameters<typeof locationItems>[0][number] => ({
  path,
  uri: null,
  range: { start: { line: 1, col: line.indexOf("_StatefulDataset") }, end: { line: 1, col: line.length } },
});

/** Sets the project root and the chooser extras for one test. */
function project(chooser: Record<string, boolean>) {
  useProject.setState({
    project: { root: "/p" } as never,
    settings: { editor: { chooser } } as never,
  });
}

beforeEach(() => {
  useProject.setState({ project: null, settings: null });
});
afterEach(() => {
  useProject.setState({ project: null, settings: null });
  vi.restoreAllMocks();
});

describe("locationItems", () => {
  it("shows name and project-relative path:line only", async () => {
    const line = "class _StatefulDataset(Base):";
    readManyFileLines.mockResolvedValue(new Map([["/p/src/mod.py", ["", line]]]));
    project({});
    const item = (await locationItems([target("/p/src/mod.py", line)]))[0]!;
    expect(item.label).toBe("_StatefulDataset");
    expect(item.detail).toBe("src/mod.py:2");
    expect(item.preview).toBeUndefined();
  });

  it("truncates absolute paths outside the project to a tail", async () => {
    const line = "class _StatefulDataset(Base):";
    const path = "B:/Program/Open/torchitan/tests/unit_tests/test_data.py";
    readManyFileLines.mockResolvedValue(new Map([[path, ["", line]]]));
    project({});
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

  it("keeps index symbols' container detail", async () => {
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
