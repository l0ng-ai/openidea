import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSymbol } from "@/bindings";

const GOROOT = "/go/src";
const files: Record<string, string> = {
  "/p/cmd/main.go": 'package main\n\nimport (\n\t"fmt"\n\tst "example.com/p/store"\n\t_ "embed"\n)\n',
  "/p/store/store.go": 'package store\n\nimport "time"\n\ntype Note struct{ At time.Time }\n',
  "/p/conv/conv.go": 'package conv\n\nimport (\n\tam "example.com/p/a/model"\n\tbm "example.com/p/b/model"\n)\n',
  [`${GOROOT}/builtin/builtin.go`]:
    "package builtin\n\n// bool is…\ntype bool bool\n\nconst (\n\ttrue = 0 == 0\n)\n\ntype error interface {\n\tError() string\n}\n\nfunc len(v Type) int\n",
};

const sym = (name: string, container: string, path: string, line = 3): WorkspaceSymbol => ({
  name,
  kind: "struct",
  container,
  location: { path, range: { start: { line, col: 5 }, end: { line, col: 9 } } },
});

// What gopls answers per query (names come back qualified as the query is).
const index: Record<string, WorkspaceSymbol[]> = {
  "fmt.Println": [
    sym("fmt.Println", "fmt", "/go/src/fmt/print.go", 305),
    sym("fmt.Fprintln", "fmt", "/go/src/fmt/print.go"),
  ],
  "log.Logger.Printf": [sym("log.Logger.Printf", "log", "/go/src/log/log.go", 265)],
  "store.Note": [sym("store.Note", "example.com/p/store", "/p/store/store.go", 4)],
  "time.Time": [sym("time.Time", "time", "/go/src/time/time.go", 135)],
  Note: [
    sym("Note", "example.com/p/store", "/p/store/store.go", 4),
    sym("Note", "example.com/p/other", "/p/other/x.go"),
  ],
  "model.Item": [
    sym("model.Item", "example.com/p/a/model", "/p/a/model/model.go"),
    sym("model.Item", "example.com/p/b/model", "/p/b/model/model.go"),
  ],
  "yaml.Node": [sym("yaml.Node", "gopkg.in/yaml.v3", "/mod/yaml/yaml.go")],
};
const queries: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/platform/ipc", async (orig) => ({
  ...(await orig<typeof import("@/platform/ipc")>()),
  commands: {
    lspWorkspaceSymbols: async (_id: number, q: string) => {
      queries.push(q);
      return { status: "ok", data: index[q] ?? [] };
    },
    sdkProjectLibraries: async () => ({
      status: "ok",
      data: [{ name: "Go SDK", kind: "go", roots: [{ name: "src", path: GOROOT }] }],
    }),
  },
}));
vi.mock("../files", () => ({ readFileLines: async (p: string) => files[p]?.split("\n") ?? null }));

const { goImports, goPackageName, pkgGoDevLink, resolveGoRef, findInPackage, signatureRef } = await import("./go");

describe("pkg.go.dev links", () => {
  it.each([
    ["https://pkg.go.dev/fmt#Println", { importPath: "fmt", name: "Println" }],
    ["https://pkg.go.dev/log#Logger.Printf", { importPath: "log", name: "Logger.Printf" }],
    [
      "https://pkg.go.dev/golang.org/x/text@v0.14.0/language#Tag",
      { importPath: "golang.org/x/text/language", name: "Tag" },
    ],
    ["https://pkg.go.dev/fmt", null],
    ["https://pkg.go.dev/fmt#hdr-Printing", null],
    ["https://go.dev/doc#Println", null],
    ["file:///go/src/fmt/print.go#L1", null],
  ])("%s", (href, want) => expect(pkgGoDevLink(href)).toEqual(want));

  it.each([
    ["fmt", "Println", { path: "/go/src/fmt/print.go", line: 305, col: 5 }],
    ["log", "Logger.Printf", { path: "/go/src/log/log.go", line: 265, col: 5 }],
    ["example.com/nowhere", "Missing", null],
  ])("finds %s#%s only by its exact name in that package", async (path, name, want) => {
    expect(await findInPackage(path, name)).toEqual(want);
  });
});

describe("Go names", () => {
  it("reads import names, aliases and package names", () => {
    expect([...goImports(files["/p/cmd/main.go"]!)]).toEqual([
      ["fmt", "fmt"],
      ["st", "example.com/p/store"],
    ]);
    expect([...goImports('package x\nimport y "a/b"\nimport "c/d.v2"')]).toEqual([
      ["y", "a/b"],
      ["d", "c/d.v2"],
    ]);
    expect(["gopkg.in/yaml.v3", "github.com/google/go-cmp/cmp", "x/go-redis/v9", "a/b-go"].map(goPackageName)).toEqual([
      "yaml",
      "cmp",
      "redis",
      "b",
    ]);
  });

  it("splits a qualified name in a signature", () => {
    const text = "func (s *st.Store) Get(id int) (st.Note, error)";
    expect(signatureRef(text, 12, 17)).toEqual({ qualifier: "st", name: "Store" });
    expect(signatureRef(text, 26, 29)).toEqual({ qualifier: null, name: "int" });
  });

  const current = "/p/cmd/main.go";
  it.each<
    [string, { qualifier: string | null; name: string }, { declaring: string | null; current: string | null }, unknown]
  >([
    [
      "alias of the file asked in",
      { qualifier: "st", name: "Note" },
      { declaring: null, current },
      "/p/store/store.go",
    ],
    [
      "import of the declaring file",
      { qualifier: "time", name: "Time" },
      { declaring: "/p/store/store.go", current },
      "/go/src/time/time.go",
    ],
    [
      "package no file imports, unique",
      { qualifier: "yaml", name: "Node" },
      { declaring: null, current },
      "/mod/yaml/yaml.go",
    ],
    ["same package name twice: ambiguous", { qualifier: "model", name: "Item" }, { declaring: null, current }, null],
    [
      "unqualified, in the declaring package",
      { qualifier: null, name: "Note" },
      { declaring: "/p/store/store.go", current },
      "/p/store/store.go",
    ],
    [
      "unqualified, not in that package",
      { qualifier: null, name: "Note" },
      { declaring: "/p/cmd/main.go", current },
      null,
    ],
    ["not found", { qualifier: "st", name: "Missing" }, { declaring: null, current }, null],
    [
      "builtin type",
      { qualifier: null, name: "error" },
      { declaring: null, current },
      `${GOROOT}/builtin/builtin.go:9:5`,
    ],
    [
      "builtin constant",
      { qualifier: null, name: "true" },
      { declaring: null, current },
      `${GOROOT}/builtin/builtin.go:6:1`,
    ],
    [
      "builtin function",
      { qualifier: null, name: "len" },
      { declaring: null, current },
      `${GOROOT}/builtin/builtin.go:13:5`,
    ],
  ])("%s", async (_, ref, ctx, want) => {
    const t = await resolveGoRef(ref, ctx);
    const got = t && (t.path.includes("builtin") ? `${t.path}:${t.line}:${t.col}` : t.path);
    expect(got).toEqual(want);
  });

  it("an alias meaning different packages in the two files is ambiguous", async () => {
    files["/p/other.go"] = 'package other\n\nimport st "example.com/p/stuff"\n';
    expect(await resolveGoRef({ qualifier: "st", name: "Note" }, { declaring: "/p/other.go", current })).toBeNull();
    expect(queries).not.toContain("stuff.Note");
  });
});
