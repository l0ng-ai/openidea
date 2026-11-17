import { describe, expect, it, vi } from "vitest";
import type { Location, Pos } from "@/bindings";

const at = (path: string, line: number, col = 0): Location => ({
  path,
  range: { start: { line, col }, end: { line, col } },
});

const LIB = "/w/src/lib.rs";
const files: Record<string, string[]> = {
  [LIB]: [
    "use crate::model::Item;",
    "",
    "/// Takes the items.",
    "pub fn take(items: Vec<Item>,",
    "    on: Clock) -> Inventory { // an Order list",
    "    Order::all(items)",
    "}",
  ],
  "/w/src/c.ts": ["/** Note: Item is re-read. */", "export function f(x: Item): void {}"],
};
// What the server answers per `path:line:col`.
const defs: Record<string, Location[]> = {
  [`${LIB}:3:7`]: [at(LIB, 3, 7)], // take
  [`${LIB}:3:12`]: [at(LIB, 3, 12)], // items: the parameter
  [`${LIB}:3:19`]: [at("/rust/library/alloc/src/vec/mod.rs", 396, 11)], // Vec
  [`${LIB}:3:23`]: [at("/w/src/model.rs", 4, 11)], // Item
  [`${LIB}:4:8`]: [at("/w/src/clock.rs", 1, 11), at("/w/src/clock2.rs", 1, 11)], // Clock: two places
  [`${LIB}:4:18`]: [at("/w/src/inventory.rs", 2, 11)], // Inventory
  [`${LIB}:5:4`]: [at("/w/src/order.rs", 2, 11)], // Order, in the body
  "/w/src/c.ts:1:21": [at("/w/src/item.ts", 0, 17)], // Item; the comment's has no definition
};

let file = "";
vi.mock("../files", () => ({
  readFileLines: async (p: string) => files[p] ?? null,
  withDocument: async <T>(p: string, fn: (doc: number) => Promise<T>) => ((file = p), fn(1)),
}));
vi.mock("../lsp", () => ({ lspRequest: <T>(run: () => Promise<T>) => run() }));
vi.mock("@/platform/ipc", () => ({
  commands: { lspGoto: async (_doc: number, pos: Pos) => defs[`${file}:${pos.line}:${pos.col}`] ?? [] },
}));

const { signatureNameTarget } = await import("./signature");

describe("names in a signature", () => {
  it.each([
    ["a type from another file", "Item", { path: "/w/src/model.rs", line: 4, col: 11 }],
    ["a library type", "Vec", { path: "/rust/library/alloc/src/vec/mod.rs", line: 396, col: 11 }],
    ["a wrapped parameter's type", "Inventory", { path: "/w/src/inventory.rs", line: 2, col: 11 }],
    ["a parameter", "items", null],
    ["the symbol itself", "take", null],
    ["defined in two places", "Clock", null],
    ["inferred: not in the source", "Option", null],
    ["not a name", "a.b", null],
  ])("%s", async (_, name, want) => {
    expect(await signatureNameTarget(at(LIB, 3, 7), name, 1)).toEqual(want);
  });

  it("asks only near the declaration", async () => {
    expect(await signatureNameTarget(at(LIB, 3, 7), "Order", 1)).toEqual({ path: "/w/src/order.rs", line: 2, col: 11 });
    expect(await signatureNameTarget(at(LIB, 0, 0), "Order", -9)).toBeNull();
  });

  it("skips an occurrence the server has no definition for (a comment)", async () => {
    expect(await signatureNameTarget(at("/w/src/c.ts", 0), "Item", 1)).toEqual({
      path: "/w/src/item.ts",
      line: 0,
      col: 17,
    });
  });
});
