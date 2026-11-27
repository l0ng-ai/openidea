import { describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ executeAction: vi.fn() }));
vi.mock("@/platform/actions", () => actions);
vi.mock("@/editor/api", () => ({ CONTRIBUTED_DEFINITION: "openideaDefinition" }));

import { EditorState, Text } from "@codemirror/state";
import { goModModuleAt, goModNavigationExtension } from "./goModNavigation";
import { goModuleRoot } from "./index";

const DEFINITION = "openideaDefinition";

const gomod = `module example.com/app // require x.dev/not v1

go 1.24

require golang.org/x/text v0.21.0

require (
\tgithub.com/Org/Lib/v2 v2.1.0 // indirect
\t"example.com/quoted" v1.0.0
\t\`example.com/raw\` v1.0.0
\t// github.com/commented/out v1.0.0
)

replace example.com/old => ../old

replace (
\texample.com/a v1.0.0 => example.com/b v1.1.0
)

exclude example.com/bad v0.1.0

tool golang.org/x/tools/cmd/stringer
`;

const at = (needle: string, delta = 0) => gomod.indexOf(needle) + delta;
const doc = Text.of(gomod.split("\n"));
const moduleAt = (offset: number) => goModModuleAt(doc, offset)?.path ?? null;

describe("goModModuleAt", () => {
  it("finds the module path of single-line and block require entries, edges included", () => {
    const start = at("golang.org/x/text");
    expect(goModModuleAt(doc, start)).toEqual({
      path: "golang.org/x/text",
      version: "v0.21.0",
      from: start,
      to: start + "golang.org/x/text".length,
    });
    expect(moduleAt(start + "golang.org/x/text".length)).toBe("golang.org/x/text");
    expect(moduleAt(at("Org/Lib"))).toBe("github.com/Org/Lib/v2");
    expect(moduleAt(at("example.com/quoted", 3))).toBe("example.com/quoted");
    expect(moduleAt(at("example.com/raw", 3))).toBe("example.com/raw");
    expect(moduleAt(at("`example.com/raw"))).toBeNull();
  });

  it("finds the replaced module of replace entries, not the replacement", () => {
    expect(moduleAt(at("example.com/old"))).toBe("example.com/old");
    expect(moduleAt(at("example.com/a v1"))).toBe("example.com/a");
    expect(moduleAt(at("example.com/b"))).toBeNull();
    expect(goModModuleAt(doc, at("example.com/old"))?.version).toBeNull();
    expect(goModModuleAt(doc, at("example.com/a v1"))?.version).toBe("v1.0.0");
    expect(moduleAt(at("../old"))).toBeNull();
  });

  it("ignores versions, keywords, comments and other directives", () => {
    expect(moduleAt(at("v0.21.0", 2))).toBeNull();
    expect(moduleAt(at("require golang", 2))).toBeNull();
    expect(moduleAt(at("x.dev/not"))).toBeNull();
    expect(moduleAt(at("github.com/commented"))).toBeNull();
    expect(moduleAt(at("example.com/app"))).toBeNull();
    expect(moduleAt(at("example.com/bad"))).toBeNull();
    expect(moduleAt(at("golang.org/x/tools"))).toBeNull();
    expect(moduleAt(at("require (", 8))).toBeNull();
    expect(moduleAt(at(")\n\nreplace"))).toBeNull();
  });
});

describe("goModuleRoot", () => {
  const groups = [
    { name: "Go SDK 1.24", kind: "go", roots: [{ name: "src", path: "/go/src" }] },
    {
      name: "Go Modules",
      kind: "goModules",
      roots: [
        { name: "golang.org/x/text@v0.21.0", path: "/mod/golang.org/x/text@v0.21.0" },
        { name: "golang.org/x/text/v2@v2.0.0", path: "/mod/golang.org/x/text/v2@v2.0.0" },
        { name: "example.com/vendored", path: "/p/vendor/example.com/vendored" },
      ],
    },
  ];

  it("finds the downloaded version of a module, or its vendored folder", () => {
    expect(goModuleRoot(groups, "golang.org/x/text", "v0.21.0")).toBe("/mod/golang.org/x/text@v0.21.0");
    expect(goModuleRoot(groups, "golang.org/x/text/v2", "v2.0.0")).toBe("/mod/golang.org/x/text/v2@v2.0.0");
    expect(goModuleRoot(groups, "example.com/vendored", "v1.0.0")).toBe("/p/vendor/example.com/vendored");
    // A replace without a version names every version of the module.
    expect(goModuleRoot(groups, "golang.org/x/text", null)).toBe("/mod/golang.org/x/text@v0.21.0");
  });

  it("finds no folder for another version, a path prefix or another group", () => {
    expect(goModuleRoot(groups, "golang.org/x/text", "v0.3.0")).toBeNull();
    expect(goModuleRoot(groups, "golang.org/x", null)).toBeNull();
    expect(goModuleRoot(groups, "src", null)).toBeNull();
    expect(goModuleRoot([], "golang.org/x/text", "v0.21.0")).toBeNull();
  });
});

describe("goModNavigationExtension", () => {
  const roots: Record<string, string> = { "golang.org/x/text@v0.21.0": "/mod/golang.org/x/text@v0.21.0" };
  const state = (path = "/p/app/go.mod", virtual = false) =>
    EditorState.create({
      doc: gomod,
      extensions: [
        goModNavigationExtension(
          (m, v) => roots[`${m}@${v}`] ?? null,
          (p) => p.startsWith("/mod/"),
        )({ path, virtual } as Parameters<ReturnType<typeof goModNavigationExtension>>[0]),
      ],
    });
  const definitionAt = (s: EditorState, pos: number) =>
    s.languageDataAt<(v: { state: EditorState }, p: number) => boolean>(DEFINITION, pos)[0];

  it("selects a downloaded module's folder in the project view", () => {
    actions.executeAction.mockClear();
    const s = state();
    const pos = at("golang.org/x/text", 4);
    expect(definitionAt(s, pos)!({ state: s }, pos)).toBe(true);
    expect(actions.executeAction).toHaveBeenCalledWith(
      "navigate.selectInProjectView",
      "/mod/golang.org/x/text@v0.21.0",
    );
  });

  it("leaves modules that are not downloaded, other positions and other files to the language server", () => {
    expect(definitionAt(state(), at("Org/Lib"))).toBeUndefined();
    expect(definitionAt(state(), at("v0.21.0"))).toBeUndefined();
    expect(definitionAt(state("/p/app/go.work"), at("golang.org/x/text"))).toBeUndefined();
    expect(definitionAt(state("/p/app/not-go.mod.txt"), at("golang.org/x/text"))).toBeUndefined();
    expect(definitionAt(state("/p/app/go.mod", true), at("golang.org/x/text"))).toBeUndefined();
    // A dependency's own go.mod resolves in its own module graph, not the project's.
    expect(definitionAt(state("/mod/example.com/dep@v1.0.0/go.mod"), at("golang.org/x/text"))).toBeUndefined();
  });
});
