import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { SymbolKind, SymbolMatch } from "@/platform/ipc";
import { symbolRef } from "./conversation";
import { inTaskFolder, lookupSymbols, symbolTargets } from "./symbolLinks";

const symbol = (
  name: string,
  path: string,
  kind: SymbolKind = "class",
  container: string | null = null,
): SymbolMatch => ({
  name,
  kind,
  container,
  path,
  relPath: path.replace(/^\/repo\//, ""),
  range: { start: { line: 3, col: 6 }, end: { line: 3, col: 6 + name.length } },
  score: 0,
  indices: [],
});

afterEach(clearMocks);

describe("symbolTargets", () => {
  const views = [symbol("FooView", "/repo/web/view.ts"), symbol("FooView", "/repo/app/view.ts")];

  it("keeps only exact matches of the named kind, container and file", () => {
    const found = [
      symbol("load", "/repo/a.ts", "method", "Config"),
      symbol("load", "/repo/b.ts", "method", "Loader"),
      symbol("load", "/repo/c.ts", "variable"),
    ];
    expect(symbolTargets(symbolRef("Config.load")!, found, [], "/repo").map((found) => found.path)).toEqual([
      "/repo/a.ts",
    ]);
    expect(symbolTargets(symbolRef("b.ts#load")!, found, [], "/repo").map((found) => found.path)).toEqual([
      "/repo/b.ts",
    ]);
    expect(symbolTargets(symbolRef("load()")!, found, [], "/repo").map((found) => found.path)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ]);
    expect(symbolTargets(symbolRef("FooView")!, [symbol("FooView", "/repo/x.ts", "variable")], [], "/repo")).toEqual(
      [],
    );
  });

  it("prefers a file the reply names, then the task's folder", () => {
    const ref = symbolRef("FooView")!;
    expect(symbolTargets(ref, views, ["/app/view.ts"], "/repo/web").map((found) => found.path)).toEqual([
      "/repo/app/view.ts",
    ]);
    expect(symbolTargets(ref, views, [], "/repo/web").map((found) => found.path)).toEqual(["/repo/web/view.ts"]);
    expect(symbolTargets(ref, views, ["/other.ts"], "/repo")).toHaveLength(2);
  });

  it("puts a worktree task's targets under its own folder", () => {
    const [view] = views;
    expect(inTaskFolder(view!, "/repo", "/repo/web").path).toBe("/repo/web/view.ts");
    expect(inTaskFolder(view!, "/repo", "/worktrees/fix").path).toBe("/worktrees/fix/web/view.ts");
  });
});

describe("lookupSymbols", () => {
  it("asks the index once per name and folder, in one request", async () => {
    const asked: string[][] = [];
    mockIPC((cmd, args) => {
      if (cmd !== "find_symbols_named") return null;
      const { names } = args as { names: string[] };
      asked.push(names);
      return names.map((name) => symbol(name, `/repo/${name}.ts`));
    });
    const first = lookupSymbols("/batch", ["FooView", "load", "FooView"]);
    expect((await first.get("load"))!.map((found) => found.path)).toEqual(["/repo/load.ts"]);
    const second = lookupSymbols("/batch", ["load", "BarView"]);
    expect((await second.get("BarView"))!.map((found) => found.name)).toEqual(["BarView"]);
    await lookupSymbols("/elsewhere", ["load"]).get("load");
    expect(asked).toEqual([["FooView", "load"], ["BarView"], ["load"]]);
  });
});
