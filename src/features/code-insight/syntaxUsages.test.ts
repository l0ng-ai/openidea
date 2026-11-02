import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { IdeError, Locals, Range } from "@/bindings";

type R<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: IdeError }>;
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const err = (kind: IdeError["kind"]) =>
  Promise.resolve({ status: "error" as const, error: { kind, message: kind } as IdeError });

const cmd = {
  lspReferences: vi.fn((): R<unknown> => err("unavailable")),
  syntaxSupport: vi.fn(() => ok({ tree: true, locals: true })),
  syntaxLocals: vi.fn((): R<Locals> => ok({ status: "noIdentifier" })),
  syntaxIdentifiers: vi.fn((): R<unknown> => ok([])),
  syntaxIdentifiersInFiles: vi.fn((): R<unknown> => ok([])),
  fsReadText: vi.fn(() => ok("a\nb\nc")),
};
const filesMentioning = vi.fn(async () => ({ paths: ["/p/b.ts"], limitHit: false }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, ...cmd } };
});
vi.mock("./candidates", () => ({ filesMentioning: () => filesMentioning() }));

const { _addEditor } = await import("@/editor/api");
const { fetchUsages } = await import("./usages");
const { incompleteNote } = await import("@/editor/lsp/lsp");
const { LOCAL_NOTE, TEXT_NOTE } = await import("./syntaxUsages");

const r = (line: number, col: number, endCol: number): Range => ({ start: { line, col }, end: { line, col: endCol } });
const view = new EditorView({ state: EditorState.create({ doc: "let x = 1;\nx + y;" }) });
_addEditor({ view, ctx: { doc: 3, path: "/p/a.ts", language: "typescript", uiMode: null, readOnly: false } });
const caret = { doc: 3, path: "/p/a.ts", line: 1, col: 0, word: "x", view };

beforeEach(() => {
  for (const f of Object.values(cmd)) f.mockClear();
  filesMentioning.mockClear();
});

describe("Find Usages fallback", () => {
  it("uses the server when it answers, even with nothing", async () => {
    cmd.lspReferences.mockReturnValueOnce(ok({ locations: [], incomplete: null }));
    expect(await fetchUsages(caret)).toEqual({ groups: [], note: null });
    expect(cmd.syntaxLocals).not.toHaveBeenCalled();
  });

  it("searches project-wide under the given request and says when results may be incomplete", async () => {
    const usage = { path: "/p/a.ts", range: r(1, 0, 1) };
    cmd.lspReferences.mockReturnValueOnce(ok({ locations: [usage], incomplete: "indexing" }));
    const res = await fetchUsages(caret, 42 as never);
    expect(cmd.lspReferences).toHaveBeenCalledWith(42, 3, { line: 1, col: 0 }, false, true);
    expect(res.groups[0]!.usages.length).toBe(1);
    expect(res.note).toBe(incompleteNote("indexing", "x"));
    expect(incompleteNote("tooManyFiles", "x")).toBe(
      "May be incomplete: too many files mention 'x' to search them all",
    );
    expect(incompleteNote("filesSkipped", "x")).toBe(
      "May be incomplete: some files that mention 'x' are too large or unreadable",
    );
  });

  it("lists a certain local's references when the server is not ready", async () => {
    cmd.syntaxLocals.mockReturnValueOnce(
      ok({
        status: "local",
        symbol: {
          name: "x",
          kind: "var",
          definition: r(0, 4, 5),
          scope: r(0, 0, 20),
          references: [r(1, 0, 1)],
          certain: true,
          conflicts: [],
        },
      }),
    );
    const res = await fetchUsages(caret);
    expect(res.note).toBe(LOCAL_NOTE);
    expect(res.groups.map((g) => [g.path, g.usages.map((u) => [u.line, u.col, u.text])])).toEqual([
      ["/p/a.ts", [[1, 0, "x + y;"]]],
    ]);
    expect(filesMentioning).not.toHaveBeenCalled();
  });

  it("searches the project for identifier occurrences of non-locals", async () => {
    cmd.lspReferences.mockReturnValueOnce(err("internal"));
    cmd.syntaxLocals.mockReturnValueOnce(
      ok({ status: "notLocal", name: "y", range: r(1, 4, 5), reason: "unresolved" }),
    );
    cmd.syntaxIdentifiersInFiles.mockReturnValueOnce(
      ok([
        { path: "/p/b.ts", occurrences: [{ range: r(2, 0, 1), kind: "identifier", qualified: false }] },
        { path: "/p/a.ts", occurrences: [{ range: r(1, 4, 5), kind: "identifier", qualified: false }] },
      ]),
    );
    const res = await fetchUsages(caret);
    expect(res.note).toBe(TEXT_NOTE);
    expect(cmd.syntaxIdentifiersInFiles.mock.calls[0]).toEqual(expect.arrayContaining([["/p/b.ts", "/p/a.ts"], "y"]));
    expect(res.groups.map((g) => g.path)).toEqual(["/p/a.ts", "/p/b.ts"]);
  });

  it("keeps the server error when the language has no grammar", async () => {
    cmd.syntaxSupport.mockReturnValueOnce(ok({ tree: false, locals: false }));
    const other = new EditorView({ state: EditorState.create({ doc: "x" }) });
    _addEditor({
      view: other,
      ctx: { doc: 4, path: "/p/a.txt", language: "plaintext", uiMode: null, readOnly: false },
    });
    await expect(
      fetchUsages({ doc: 4, path: "/p/a.txt", line: 0, col: 0, word: "x", view: other }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
