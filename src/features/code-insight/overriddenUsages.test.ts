import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { IdeError, OutlineItem, Range } from "@/bindings";

type R = Promise<{ status: "ok"; data: unknown } | { status: "error"; error: IdeError }>;
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const err = (kind: IdeError["kind"]) =>
  Promise.resolve({ status: "error" as const, error: { kind, message: kind } as IdeError });
const python = vi.hoisted(() => ({ hierarchy: null as unknown }));
const IMPL_DOC = 9;
const BASE_DOC = 10;

const span = (line: number, col: number, len: number): Range => ({
  start: { line, col },
  end: { line, col: col + len },
});
const py = (name: string, kind: OutlineItem["kind"], line: number, end: number, children: OutlineItem[] = []) => ({
  name,
  kind,
  detail: null,
  range: { start: { line, col: 0 }, end: { line: end, col: 1 } },
  selection_range: span(line, kind === "class" ? 6 : 8, name.length),
  children,
});
const outlines: Record<number, OutlineItem[]> = {
  [IMPL_DOC]: [py("MysqlRepository", "class", 0, 2, [py("save", "method", 1, 2)])],
  [BASE_DOC]: [py("Repository", "class", 0, 2, [py("save", "method", 1, 2)])],
};
// `repo.save()` with `repo: Repository` binds to the base's declaration only.
const call = { path: "/p/service.py", range: span(4, 13, 4) };
// So does a sibling override's `super().save()`, which never runs MysqlRepository.save.
const superCall = { path: "/p/other.py", range: span(2, 16, 4) };
const FILES: Record<string, string> = {
  "/p/service.py": "\n\n\ndef use(repo: Repository):\n        repo.save()",
  "/p/other.py": "class Other(Repository):\n    def save(self):\n        super().save()",
};

const cmd = {
  lspReferences: vi.fn(
    (_request: number, doc: number, _pos: unknown, _declaration: boolean, _projectWide: boolean): R =>
      ok({ locations: doc === BASE_DOC ? [call, superCall] : [], incomplete: null }),
  ),
  docOutline: vi.fn((doc: number) => ok(outlines[doc] ?? [])),
  docOpen: vi.fn((path: string) => ok({ id: path === "/p/base.py" ? BASE_DOC : 0 })),
  docClose: vi.fn(() => ok(null)),
  fsReadText: vi.fn((path: string) => ok(FILES[path] ?? "")),
};

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, ...cmd } };
});
vi.mock("@/editor/navigation/pythonHierarchy", async (orig) => ({
  ...(await orig<object>()),
  projectPythonHierarchy: async () => python.hierarchy,
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const { _addEditor } = await import("@/editor/api");
const { fetchUsages } = await import("./usages");
const { pythonHierarchy } = await import("@/editor/navigation/pythonHierarchy");

python.hierarchy = pythonHierarchy(
  [
    { path: "/p/base.py", line: 0, col: 6, name: "Repository", bases: [] },
    { path: "/p/impl.py", line: 0, col: 6, name: "MysqlRepository", bases: ["Repository"] },
  ],
  { readFiles: async (paths) => new Map(paths.map((p) => [p, null])) },
);
const doc = "class MysqlRepository(Repository):\n    def save(self):\n        pass";
const view = new EditorView({ state: EditorState.create({ doc }) });
_addEditor({ view, ctx: { doc: IMPL_DOC, path: "/p/impl.py", language: "python", uiMode: null, readOnly: false } });
const caret = { doc: IMPL_DOC, path: "/p/impl.py", line: 1, col: 9, word: "save", view };
const shown = (res: { groups: { usages: { path: string; line: number }[] }[] }) =>
  res.groups.flatMap((g) => g.usages.map((u) => `${u.path}:${u.line}`));

beforeEach(() => {
  cmd.lspReferences.mockClear();
});

describe("Find Usages of a Python method that overrides a base's", () => {
  it("adds the calls bound to the base's method but not super() calls, under the same request", async () => {
    const res = await fetchUsages(caret, 42 as never);
    expect(shown(res)).toEqual(["/p/service.py:4"]);
    expect(cmd.lspReferences.mock.calls.map((c) => [c[0], c[1], c[2], c[4]])).toEqual([
      [42, IMPL_DOC, { line: 1, col: 9 }, true],
      [42, BASE_DOC, { line: 1, col: 8 }, true],
    ]);
  });

  it("stops when the base's search is cancelled, without the syntax fallback", async () => {
    cmd.lspReferences
      .mockReturnValueOnce(ok({ locations: [], incomplete: null }))
      .mockReturnValueOnce(err("cancelled"));
    await expect(fetchUsages(caret, 43 as never)).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("keeps the method's own usages and says more may exist when the base's search fails", async () => {
    cmd.lspReferences
      .mockReturnValueOnce(ok({ locations: [call], incomplete: null }))
      .mockReturnValueOnce(err("protocol"));
    const res = await fetchUsages(caret, 44 as never);
    expect(shown(res)).toEqual(["/p/service.py:4"]);
    expect(res.note).toBe("May be incomplete: the language server could not check this name");
  });
});
