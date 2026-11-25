import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { beforeEach, expect, it, vi } from "vitest";
import type { Location, PythonFacts, References } from "@/platform/ipc";

const lspReferences = vi.fn<(...args: unknown[]) => Promise<References>>();
const readManyFileLines = vi.fn(async (_paths: readonly string[]) => new Map<string, string[] | null>());
const showHint = vi.fn();
const executeAction = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, lspReferences } };
});
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/editor/lsp/lsp", () => ({ lspRequest: (run: () => Promise<unknown>) => run() }));
vi.mock("@/editor/lsp/files", () => ({ readManyFileLines: (paths: readonly string[]) => readManyFileLines(paths) }));
vi.mock("@/editor/lsp/hint", () => ({ showHint: (...args: unknown[]) => showHint(...args) }));
vi.mock("@/platform/actions", () => ({ executeAction: (...args: unknown[]) => executeAction(...args) }));

const { breakingUsages, makeMethodStatic, makeStaticChanges } = await import("./makeStatic");

const SRC = "class C:\n    # note\n    def helper(self, x):\n        return x * 2\n";
const pos = (line: number, col: number) => ({ line, col });
const FACTS: PythonFacts = {
  suppressions: [],
  classes: [
    {
      name: "C",
      selection: { start: pos(0, 6), end: pos(0, 7) },
      definitionLine: 0,
      bases: [],
      methods: [
        {
          name: "helper",
          selection: { start: pos(2, 8), end: pos(2, 14) },
          definitionLine: 2,
          params: ["self", "x"],
          abstractMethod: false,
          overrideDecorated: false,
          body: { kind: "other" },
          unusedReceiver: { start: pos(2, 15), end: pos(2, 21) },
        },
      ],
    },
  ],
};
const STATIC = "class C:\n    # note\n    @staticmethod\n    def helper(x):\n        return x * 2\n";

/** The usage of `helper` on `line` of `text` (its first occurrence there). */
const usageIn = (path: string, text: string, line: number): Location => {
  const col = text.split("\n")[line]!.indexOf("helper");
  return { path, range: { start: pos(line, col), end: pos(line, col + 6) } };
};

it("adds @staticmethod and removes the receiver", () => {
  const state = EditorState.create({ doc: SRC });
  const fix = makeStaticChanges(state.doc, FACTS, state.doc.line(3).from + 10);
  expect(fix).toMatchObject({ name: "helper", at: pos(2, 8) });
  expect(state.update({ changes: fix!.changes }).state.doc.toString()).toBe(STATIC);
  expect(makeStaticChanges(state.doc, FACTS, 3)).toBeNull();
});

it("keeps only the calls through an instance", () => {
  const lines = [
    "self.helper(1)",
    "super().helper(1)",
    "super(Sub, self).helper(1)",
    "C.helper(C(), 1)",
    "Alias.helper(Alias(), 1)",
    "Sub.helper(Sub(), 1)",
    "type(obj).helper(obj, 1)",
    "cls.helper(obj, 1)",
    "self.other.helper(obj, 1)",
    "obj.helper(1)",
    "fn = C.helper",
  ];
  const text = lines.join("\n");
  const usages = lines.map((_, i) => usageIn("a.py", text, i));
  const breaking = breakingUsages(usages, () => text.split("\n"));
  expect(breaking.map((u) => lines[u.range.start.line])).toEqual(lines.slice(3));
  // A file that could not be read is not known to keep working.
  expect(breakingUsages(usages.slice(0, 1), () => null)).toHaveLength(1);
});

const viewOf = (text: string) => {
  const view = {
    state: EditorState.create({ doc: text }),
    dispatch: vi.fn((spec: { changes: never }) => {
      view.state = view.state.update(spec).state;
    }),
  };
  return view;
};
const refs = (locations: Location[]): References => ({ locations, incomplete: null });

beforeEach(() => {
  vi.clearAllMocks();
});

it("makes the method static when every usage calls it through an instance", async () => {
  const own = SRC + "    def run(self):\n        return self.helper(1)\n";
  const other = "from a import C\nC().helper(2)\nclass D(C):\n    def go(self):\n        return super().helper(3)\n";
  const view = viewOf(own);
  lspReferences.mockResolvedValue(refs([usageIn("/p/a.py", own, 5), usageIn("/p/b.py", other, 4)]));
  readManyFileLines.mockResolvedValue(new Map([["/p/b.py", other.split("\n")]]));
  const fix = makeStaticChanges(view.state.doc, FACTS, view.state.doc.line(3).from + 10)!;
  await makeMethodStatic(view as unknown as EditorView, "/p/a.py", 1, fix);
  expect(readManyFileLines).toHaveBeenCalledWith(["/p/b.py"]);
  expect(view.state.doc.toString()).toBe(STATIC + "    def run(self):\n        return self.helper(1)\n");
  expect(showHint).not.toHaveBeenCalled();
});

it("refuses when a usage elsewhere calls it through an alias or a subclass", async () => {
  const other =
    "from a import C\nclass Sub(C): pass\nAlias = C\nprint(Alias.helper(Alias(), 1))\nprint(Sub.helper(Sub(), 2))\n";
  const view = viewOf(SRC);
  const breaking = [usageIn("/p/b.py", other, 3), usageIn("/p/b.py", other, 4)];
  lspReferences.mockResolvedValue(refs(breaking));
  readManyFileLines.mockResolvedValue(new Map([["/p/b.py", other.split("\n")]]));
  const fix = makeStaticChanges(view.state.doc, FACTS, view.state.doc.line(3).from + 10)!;
  await makeMethodStatic(view as unknown as EditorView, "/p/a.py", 1, fix);
  expect(view.dispatch).not.toHaveBeenCalled();
  expect(showHint.mock.lastCall![1]).toBe("Cannot make 'helper' static: 2 usages may call it through a class");
  expect(executeAction).toHaveBeenCalledWith("find.showUsageResults", { symbol: "helper", locations: breaking });
});

it("refuses when the usages cannot be searched completely", async () => {
  const view = viewOf(SRC);
  const fix = makeStaticChanges(view.state.doc, FACTS, view.state.doc.line(3).from + 10)!;
  lspReferences.mockRejectedValueOnce(new Error("no server"));
  await makeMethodStatic(view as unknown as EditorView, "/p/a.py", 1, fix);
  lspReferences.mockResolvedValueOnce({ locations: [], incomplete: "indexing" } as unknown as References);
  await makeMethodStatic(view as unknown as EditorView, "/p/a.py", 1, fix);
  expect(view.dispatch).not.toHaveBeenCalled();
  expect(showHint).toHaveBeenCalledTimes(2);
});
