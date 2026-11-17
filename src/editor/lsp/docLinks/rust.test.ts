import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSymbol } from "@/bindings";

const LIB = "/rust/lib/rustlib/src/rust/library";
const REG = "/home/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f";
const files: Record<string, string> = {
  [`${LIB}/std/src/ffi/mod.rs`]: "\n\npub use self::os_str::{OsStr, OsString};\n",
};

const sym = (name: string, path: string, container: string | null = null, line = 3): WorkspaceSymbol => ({
  name,
  kind: "struct",
  container,
  location: { path, range: { start: { line, col: 11 }, end: { line, col: 14 } } },
});

// What rust-analyzer answers per query (`*` = the dependencies instead of the workspace, `#` = every kind).
const index: Record<string, WorkspaceSymbol[]> = {
  "ExitCode*": [
    sym("ExitCode", `${LIB}/std/src/process.rs`),
    sym("ExitCode", `${LIB}/std/src/sys/process/mod.rs`),
    sym("ExitCode", `${LIB}/std/src/sys/process/unix/common.rs`),
  ],
  "HashMap*": [
    sym("HashMap", `${LIB}/vendor/hashbrown-0.17.1/src/map.rs`),
    sym("HashMap", `${LIB}/std/src/collections/mod.rs`),
    sym("HashMap", `${LIB}/std/src/collections/hash/map.rs`),
  ],
  "OsString*": [sym("OsString", `${LIB}/std/src/ffi/os_str.rs`), sym("OsString", `${LIB}/std/src/ffi/mod.rs`, null, 2)],
  "From*": [sym("From", `${LIB}/core/src/convert/mod.rs`)],
  "push*#": [
    sym("push", `${LIB}/alloc/src/vec/mod.rs`, "Vec<T, A>"),
    sym("push", `${LIB}/alloc/src/string.rs`, "String"),
  ],
  "None*#": [sym("None", `${LIB}/core/src/option.rs`, "Option")],
  "exit*#": [sym("exit", `${LIB}/std/src/process.rs`), sym("exit", `${REG}/libc-0.2.170/src/unix/mod.rs`)],
  Sku: [sym("Sku", "/work/rust-app/src/lib.rs")],
  "Sku*": [sym("Sku", `${REG}/other-1.0.0/src/lib.rs`)],
  "parse#": [sym("parse", "/work/rust-app/src/parser.rs"), sym("parse", "/work/rust-app/src/lib.rs", "Sku")],
  "Value*": [sym("Value", `${REG}/serde_json-1.0.140/src/value/mod.rs`)],
  Twice: [sym("Twice", "/work/a/src/lib.rs"), sym("Twice", "/work/b/src/lib.rs")],
};

vi.mock("@/platform/ipc", async (orig) => ({
  ...(await orig<typeof import("@/platform/ipc")>()),
  commands: { lspWorkspaceSymbols: async (_id: number, q: string) => ({ status: "ok", data: index[q] ?? [] }) },
}));
vi.mock("../files", () => ({ readFileLines: async (p: string) => files[p]?.split("\n") ?? [] }));

const { rustDocLink, findRustItem } = await import("./rust");
const { docUrlResolver } = await import("./index");

describe("rustdoc links", () => {
  it.each([
    [
      "https://doc.rust-lang.org/stable/std/process/struct.ExitCode.html",
      { crate: "std", modules: ["process"], kind: "struct", name: "ExitCode", member: null },
    ],
    [
      "https://doc.rust-lang.org/nightly/alloc/vec/struct.Vec.html#method.push",
      { crate: "alloc", modules: ["vec"], kind: "struct", name: "Vec", member: "push" },
    ],
    [
      "https://doc.rust-lang.org/stable/alloc/vec/struct.Vec.html#capacity-and-reallocation",
      { crate: "alloc", modules: ["vec"], kind: "struct", name: "Vec", member: null },
    ],
    [
      "https://docs.rs/inventory/0.1.0/inventory/struct.Sku.html",
      { crate: "inventory", modules: [], kind: "struct", name: "Sku", member: null },
    ],
    [
      "https://docs.rs/serde-json/latest/serde_json/value/enum.Value.html",
      { crate: "serde_json", modules: ["value"], kind: "enum", name: "Value", member: null },
    ],
    ["https://doc.rust-lang.org/stable/alloc/fmt/index.html", null],
    ["https://doc.rust-lang.org/nightly/core/primitive.char.html", null],
    ["https://doc.rust-lang.org/stable/core/iter/book/ch03-05-control-flow.html", null],
    ["https://docs.rs/serde", null],
    ["https://crates.io/keywords/hasher", null],
    ["https://docs.rs/x/1/x/struct.%E0%A4%A.html", null],
  ])("%s", (href, want) => expect(rustDocLink(href)).toEqual(want));

  const at = (path: string, line = 3) => ({ path, line, col: 11 });
  it.each([
    [
      "std struct, among private copies",
      "https://doc.rust-lang.org/stable/std/process/struct.ExitCode.html",
      at(`${LIB}/std/src/process.rs`),
    ],
    [
      "module path into a private submodule's file",
      "https://doc.rust-lang.org/stable/std/collections/hash/map/struct.HashMap.html",
      at(`${LIB}/std/src/collections/hash/map.rs`),
    ],
    [
      "re-export left out",
      "https://doc.rust-lang.org/stable/std/ffi/struct.OsString.html",
      at(`${LIB}/std/src/ffi/os_str.rs`),
    ],
    ["trait", "https://doc.rust-lang.org/stable/core/convert/trait.From.html", at(`${LIB}/core/src/convert/mod.rs`)],
    [
      "method of its type only",
      "https://doc.rust-lang.org/stable/alloc/vec/struct.Vec.html#method.push",
      at(`${LIB}/alloc/src/vec/mod.rs`),
    ],
    [
      "enum variant",
      "https://doc.rust-lang.org/stable/core/option/enum.Option.html#variant.None",
      at(`${LIB}/core/src/option.rs`),
    ],
    [
      "function, other crate's same name left out",
      "https://doc.rust-lang.org/stable/std/process/fn.exit.html",
      at(`${LIB}/std/src/process.rs`),
    ],
    [
      "the project's own crate (docs.rs)",
      "https://docs.rs/inventory/0.1.0/inventory/struct.Sku.html",
      at("/work/rust-app/src/lib.rs"),
    ],
    [
      "own module function, not a method",
      "https://docs.rs/inventory/0.1.0/inventory/parser/fn.parse.html",
      at("/work/rust-app/src/parser.rs"),
    ],
    [
      "registry crate",
      "https://docs.rs/serde_json/1.0.140/serde_json/value/enum.Value.html",
      at(`${REG}/serde_json-1.0.140/src/value/mod.rs`),
    ],
    ["registry crate of another version name", "https://docs.rs/serde_json/1.0.140/other/value/enum.Value.html", null],
    ["two local crates: ambiguous", "https://docs.rs/a/0.1.0/a/struct.Twice.html", null],
    ["not found", "https://doc.rust-lang.org/stable/std/process/struct.Missing.html", null],
    ["member not found", "https://doc.rust-lang.org/stable/alloc/string/struct.String.html#method.push_front", null],
  ])("%s", async (_, href, want) => {
    expect(await findRustItem(rustDocLink(href)!)).toEqual(want);
  });

  it("is one of the languages documentation links resolve for", async () => {
    expect(docUrlResolver("https://example.com/x")).toBeNull();
    expect(await docUrlResolver("https://doc.rust-lang.org/stable/core/convert/trait.From.html")!()).toEqual(
      at(`${LIB}/core/src/convert/mod.rs`),
    );
  });
});
