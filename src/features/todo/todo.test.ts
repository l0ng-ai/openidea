import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { FileMatches } from "@/platform/ipc";
import {
  buildTodoQuery,
  changedPaths,
  todoSearchScope,
  countItems,
  DEFAULT_TODO_SETTINGS,
  groupTodos,
  itemsFromMatches,
  looksLikeComment,
  mergeLive,
  scanText,
  todoRegexSource,
  type TodoItem,
  type TodoSettings,
} from "./model";
import { todoDecorations } from "./highlight";

const S = DEFAULT_TODO_SETTINGS;

describe("comment markers", () => {
  const keep = [
    "// TODO",
    "/* TODO */",
    " * TODO", // Javadoc continuation
    "/** TODO: document this */", // doc comment led by the keyword
    "# TODO", // line-start Python/Shell
    "foo() # TODO", // trailing Python/Shell comment
    "SELECT 1 -- TODO", // trailing SQL comment
    "<!-- TODO -->",
    "  ; TODO", // line-start ini comment
    "  % TODO", // line-start LaTeX comment
    '""" TODO', // Python docstring
    "''' TODO",
    "x = 1; // TODO", // marker after whitespace, not just line start
    "x (* TODO *)", // OCaml trailing comment
    "x {- TODO -}", // Haskell trailing comment
    // IDEA's default pattern matches anywhere inside a comment, so mentions count too:
    "/** 业务类别：WORK_NOTICE 工作通知，TODO 待办。 */", // documents an enum value
    "// fixed the TODO bug",
    "/* see the TODO list */",
  ];
  const drop = [
    "foo(); TODO", // statement separator
    "if (a % 2) TODO", // modulo
    "i--; TODO", // postfix decrement
    'let s = "a#b"; TODO', // # inside a string, no preceding space
    "x = a--b; TODO", // -- with no preceding space
    "see http://example.com TODO", // // inside a URL
    '"//"; TODO', // // inside a string
    "f(*) TODO", // OCaml-style wildcard
    "a * b; TODO", // infix multiplication
  ];

  it.each(keep)("keeps %s", (line) => expect(looksLikeComment(`${line.slice(0, line.indexOf("TODO"))}`)).toBe(true));
  it.each(drop)("drops %s", (line) => expect(looksLikeComment(`${line.slice(0, line.indexOf("TODO"))}`)).toBe(false));

  it("falls back to the lenient rule on truncated lines", () => {
    // A 600-char shell line truncated by the backend: the window starts
    // mid-line, so the leading rule cannot apply — any marker counts.
    expect(looksLikeComment("very long code # remainder ", true)).toBe(true);
    expect(looksLikeComment("very long code % remainder ", true)).toBe(true);
    expect(looksLikeComment("i-- ", true)).toBe(true);
  });
});

describe("query", () => {
  it("builds the keyword regex from enabled patterns", () => {
    expect(todoRegexSource(S)).toBe("\\b(TODO|FIXME|HACK|XXX)\\b.*");
    const q = buildTodoQuery({ ...S, caseSensitive: false }, { kind: "files", paths: ["/a"] })!;
    expect(q).toMatchObject({ isRegex: true, caseSensitive: false, scope: { kind: "files", paths: ["/a"] } });
    const none: TodoSettings = { ...S, patterns: S.patterns.map((p) => ({ ...p, enabled: false })) };
    expect(buildTodoQuery(none)).toBeNull();
  });
});

describe("matches → items", () => {
  const fm: FileMatches = {
    path: "/p/src/a.ts",
    relPath: "src/a.ts",
    matches: [
      { line: 3, text: "  // TODO: fix this", ranges: [[5, 19]], textOffset: 0 },
      { line: 9, text: "const TODO_LIST = 1; /* FIXME later */", ranges: [[24, 38]], textOffset: 0 },
      { line: 12, text: 'const s = "TODO nope";', ranges: [[11, 21]], textOffset: 0 },
      { line: 20, text: "…x # HACK around", ranges: [[5, 16]], textOffset: 100 },
    ],
  };

  it("keeps comment matches with keyword, position and clean text", () => {
    const items = itemsFromMatches(fm, S);
    expect(items).toEqual([
      { path: "/p/src/a.ts", line: 3, col: 5, keyword: "TODO", text: "TODO: fix this" },
      { path: "/p/src/a.ts", line: 9, col: 24, keyword: "FIXME", text: "FIXME later" },
      { path: "/p/src/a.ts", line: 20, col: 105, keyword: "HACK", text: "HACK around" },
    ]);
  });

  it("includes non-comment matches when configured", () => {
    expect(itemsFromMatches(fm, { ...S, commentsOnly: false })).toHaveLength(4);
  });
});

describe("local scan", () => {
  it("finds items with 0-based lines and columns", () => {
    const text = "fn a() {}\n// todo lower\n    // TODO: one\n/* XXX two */\nlet TODO = 1;";
    expect(scanText("/f.rs", text, S)).toEqual([
      { path: "/f.rs", line: 2, col: 7, keyword: "TODO", text: "TODO: one" },
      { path: "/f.rs", line: 3, col: 3, keyword: "XXX", text: "XXX two" },
    ]);
    const ci = scanText("/f.rs", text, { ...S, caseSensitive: false });
    expect(ci.map((i) => [i.line, i.keyword])).toEqual([
      [1, "TODO"],
      [2, "TODO"],
      [3, "XXX"],
    ]);
  });
});

describe("grouping and filters", () => {
  const item = (path: string, line: number, keyword: string): TodoItem => ({
    path,
    line,
    col: 0,
    keyword,
    text: keyword,
  });
  const map = new Map<string, TodoItem[]>([
    ["/p/b.ts", [item("/p/b.ts", 5, "TODO"), item("/p/b.ts", 1, "FIXME")]],
    ["/p/a.ts", [item("/p/a.ts", 2, "HACK")]],
    ["/p/c.ts", []],
  ]);

  it("groups by file sorted by path, items by line", () => {
    const groups = groupTodos(map, { keywords: null });
    expect(groups.map((g) => g.path)).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(groups[1]!.items.map((i) => i.line)).toEqual([1, 5]);
    expect(countItems(groups)).toBe(3);
  });

  it("filters by keyword and current file", () => {
    expect(countItems(groupTodos(map, { keywords: new Set(["TODO"]) }))).toBe(1);
    expect(groupTodos(map, { keywords: null, path: "/p/b.ts" }).map((g) => g.path)).toEqual(["/p/b.ts"]);
    expect(groupTodos(map, { keywords: null, path: null })).toEqual([]);
    expect(groupTodos(map, { keywords: new Set(["HACK"]), path: "/p/b.ts" })).toEqual([]);
  });

  it("layers live editor results over the scan", () => {
    const merged = mergeLive(map, new Map([["/p/a.ts", []]]));
    expect(countItems(groupTodos(merged, { keywords: null }))).toBe(2);
  });
});

describe("editor highlighting", () => {
  it("decorates TODO comments only", async () => {
    const desc = languages.find((l) => l.name === "JavaScript")!;
    const doc = 'const TODO = "TODO";\n// TODO: refactor\n/* FIXME now */';
    const state = EditorState.create({ doc, extensions: [await desc.load()] });
    ensureSyntaxTree(state, doc.length, 5000);
    const view = new EditorView({ state, parent: document.body });
    const ranges: Array<[number, number, string]> = [];
    todoDecorations(view, S).between(0, doc.length, (from, to, d) => {
      ranges.push([from, to, String(d.spec.class)]);
    });
    const line2 = doc.indexOf("TODO: refactor");
    const fixme = doc.indexOf("FIXME");
    ranges.sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]));
    expect(ranges).toEqual([
      [line2, line2 + "TODO: refactor".length, "cm-openidea-todo"],
      [line2, line2 + 4, "cm-openidea-todo-keyword"],
      [fixme, fixme + "FIXME now".length, "cm-openidea-todo"],
      [fixme, fixme + 5, "cm-openidea-todo-keyword"],
    ]);
    view.destroy();
  });
});

describe("scope based and changes tabs", () => {
  it("maps scopes to backend scopes", () => {
    const custom = [{ name: "Web", pattern: "file:web//*" }];
    expect(todoSearchScope("projectFiles", custom, [])).toEqual({ kind: "project" });
    expect(todoSearchScope("testFiles", custom, [])).toEqual({ kind: "fileSet", set: "test" });
    expect(todoSearchScope("openFiles", custom, [])).toBeNull();
    expect(todoSearchScope("openFiles", custom, ["/p/a.ts"])).toEqual({ kind: "files", paths: ["/p/a.ts"] });
    expect(todoSearchScope("custom:Web", custom, [])).toEqual({ kind: "pattern", pattern: "file:web//*" });
    expect(todoSearchScope("custom:Gone", custom, [])).toBeNull();
  });

  it("keeps only files of the chosen change list (the active one by default)", () => {
    const lists = [
      {
        id: "default",
        name: "Changes",
        active: true,
        files: [{ path: "/p/a.ts" }, { path: "/p/new.ts" }, { path: "/p/gone.ts", deleted: true }],
      },
      { id: "ui", name: "UI", active: false, files: [{ path: "/p/b.ts" }] },
    ];
    const changed = changedPaths(lists);
    expect([...changed]).toEqual(["/p/a.ts", "/p/new.ts"]);
    const item = (path: string) => ({ path, line: 0, col: 0, keyword: "TODO", text: "TODO" });
    const map = new Map(["/p/a.ts", "/p/b.ts"].map((p) => [p, [item(p)]]));
    expect(groupTodos(map, { keywords: null, paths: changed }).map((g) => g.path)).toEqual(["/p/a.ts"]);
    expect([...changedPaths(lists, "ui")]).toEqual(["/p/b.ts"]);
    expect([...changedPaths(lists, "gone")]).toEqual(["/p/a.ts", "/p/new.ts"]);
    expect(changedPaths([]).size).toBe(0);
  });
});
