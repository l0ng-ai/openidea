import { beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { referenceAt } from "./links";

const backend = vi.hoisted(() => ({ existing: new Map<string, string>(), files: new Set<string>() }));

vi.mock("@/editor/api", () => ({ whenSynced: async () => {} }));
vi.mock("./lsp", () => ({ lspRequest: async () => [] }));
vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: (result: unknown) => result,
  commands: {
    lspDocumentLinks: () => [],
    fsResolveReference: async (_from: string, value: string) => backend.existing.get(value) ?? null,
    fsProbe: async (path: string) => {
      if (!backend.files.has(path)) throw new Error("not a file");
    },
  },
}));

const doc: EditorDocContext = {
  doc: 1,
  path: "/p/conf/phpstan.neon",
  language: "neon",
  uiMode: "NEON",
  readOnly: false,
};

function at(source: string, context = doc) {
  const offset = source.indexOf("|");
  const text = Text.of(source.replace("|", "").split("\n"));
  const view = { state: { doc: text, sliceDoc: (a: number, b: number) => text.sliceString(a, b) } };
  return referenceAt(view as unknown as EditorView, context, offset);
}

describe("referenceAt in a NEON file", () => {
  beforeEach(() => {
    backend.existing.clear();
    backend.files.clear();
  });

  it("opens a file beside the config first", async () => {
    backend.existing.set("a.php", "/p/conf/a.php");
    backend.existing.set("/a.php", "/p/a.php");
    backend.files.add("/p/conf/a.php");
    expect(await at("- a.p|hp")).toMatchObject({ kind: "file", path: "/p/conf/a.php" });
  });

  it("falls back to the project root", async () => {
    backend.existing.set("/app/a.php", "/p/app/a.php");
    backend.files.add("/p/app/a.php");
    expect(await at("- app/a.p|hp")).toMatchObject({ kind: "file", path: "/p/app/a.php" });
  });

  it("opens a stub and reveals a folder", async () => {
    backend.existing.set("plugin.stub", "/p/conf/plugin.stub");
    backend.files.add("/p/conf/plugin.stub");
    expect(await at("- plugin.st|ub")).toMatchObject({ kind: "file", path: "/p/conf/plugin.stub" });
    backend.existing.set("/app", "/p/app");
    expect(await at("- ap|p")).toMatchObject({ kind: "folder", path: "/p/app" });
  });

  it("has nothing for a value that names nothing, or in another language", async () => {
    expect(await at("- Europe/Pra|gue")).toBeNull();
    backend.existing.set("app", "/p/app");
    expect(await at("- ap|p", { ...doc, language: "yaml" })).toBeNull();
  });
});
