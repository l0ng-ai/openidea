import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setSearchQuery } from "@codemirror/search";
import { StreamLanguage } from "@codemirror/language";
import { literalKindAt } from "./literals";
import {
  countMatches,
  findResultLines,
  excludeCurrent,
  findExcluded,
  isExcluded,
  toggleFindExcluded,
  findExtension,
  findNext,
  findPrevious,
  findScope,
  makeQuery,
  mapScope,
  replaceAll,
  replaceNext,
  setFindScope,
  type FindOptions,
} from "./find";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function make(doc: string, o: Partial<FindOptions>, scope?: { from: number; to: number }) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [findExtension()] }),
    parent: document.body,
  });
  views.push(view);
  const q = makeQuery({ search: "", caseSensitive: false, wholeWord: false, regexp: false, replace: "", ...o });
  view.dispatch({ effects: [setSearchQuery.of(q), ...(scope ? [setFindScope.of(scope)] : [])] });
  return view;
}

const sel = (v: EditorView) => [v.state.selection.main.from, v.state.selection.main.to];

describe("find in selection", () => {
  const doc = "a1 a2\na3 a4\na5 a6\n";
  // Scope: the second line only.
  const scope = { from: 6, to: 11 };

  it("counts only matches inside the scope", () => {
    expect(countMatches(make(doc, { search: "a" }).state).total).toBe(6);
    expect(countMatches(make(doc, { search: "a" }, scope).state).total).toBe(2);
  });

  it("next / previous wrap around inside the scope", () => {
    const v = make(doc, { search: "a" }, scope);
    findNext(v);
    expect(sel(v)).toEqual([6, 7]);
    findNext(v);
    expect(sel(v)).toEqual([9, 10]);
    findNext(v);
    expect(sel(v)).toEqual([6, 7]);
    findPrevious(v);
    expect(sel(v)).toEqual([9, 10]);
  });

  it("replace all touches the scope only, with regex groups", () => {
    const v = make(doc, { search: "a(\\d)", regexp: true, replace: "b$1" }, scope);
    expect(replaceAll(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("a1 a2\nb3 b4\na5 a6\n");
    expect(v.state.field(findScope)).toEqual({ from: 6, to: 11 });
  });

  it("replace next replaces the selected match and selects the next one in scope", () => {
    const v = make(doc, { search: "a", replace: "xyz" }, scope);
    findNext(v);
    replaceNext(v);
    expect(v.state.doc.toString()).toBe("a1 a2\nxyz3 a4\na5 a6\n");
    expect(sel(v)).toEqual([11, 12]);
    replaceNext(v);
    expect(v.state.doc.toString()).toBe("a1 a2\nxyz3 xyz4\na5 a6\n");
    expect(v.state.field(findScope)).toEqual({ from: 6, to: 15 });
  });

  it("plain-text search is literal", () => {
    const v = make("a\\nb\na\nb", { search: "a\\nb", replace: "\\t" });
    expect(countMatches(v.state).total).toBe(1);
    replaceAll(v);
    expect(v.state.doc.toString()).toBe("\\t\na\nb");
  });

  it("maps the scope through edits without growing at its edges", () => {
    const s = EditorState.create({ doc: "0123456789" });
    const ins = (at: number) => s.changes({ from: at, insert: "xx" });
    expect(mapScope({ from: 2, to: 5 }, ins(2))).toEqual({ from: 4, to: 7 });
    expect(mapScope({ from: 2, to: 5 }, ins(5))).toEqual({ from: 2, to: 5 });
    expect(mapScope({ from: 2, to: 5 }, s.changes({ from: 2, to: 5 }))).toBeNull();
  });
});

describe("search context, exclude and preserve case", () => {
  const lang = StreamLanguage.define<null>({
    token(stream) {
      if (stream.match("//")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^"[^"]*"/)) return "string";
      stream.next();
      return null;
    },
  });
  const code = 'foo("foo") // foo\nfoo';
  const base = { search: "", caseSensitive: false, wholeWord: false, regexp: false, replace: "" };
  function makeCode(o: Partial<FindOptions>) {
    const view = new EditorView({
      state: EditorState.create({ doc: code, extensions: [lang, findExtension()] }),
      parent: document.body,
    });
    views.push(view);
    view.dispatch({ effects: setSearchQuery.of(makeQuery({ ...base, search: "foo", ...o })) });
    return view;
  }
  const starts = (v: EditorView) => countMatches(v.state).starts;

  it.each(["inComments", "inStringLiterals", "exceptComments", "exceptCommentsAndStringLiterals"] as const)(
    "exports the same %s syntax filter as the bar",
    (context) => {
      const v = makeCode({ context });
      const lines = findResultLines(v.state, { ...base, search: "foo", context });
      expect(lines.flatMap((m) => m.ranges.map(([from]) => v.state.doc.line(m.line + 1).from + from))).toEqual(
        starts(v),
      );
    },
  );

  it("filters matches by comment / string literal", () => {
    expect(starts(makeCode({}))).toEqual([0, 5, 14, 18]);
    expect(starts(makeCode({ context: "inComments" }))).toEqual([14]);
    expect(starts(makeCode({ context: "inStringLiterals" }))).toEqual([5]);
    expect(starts(makeCode({ context: "exceptComments" }))).toEqual([0, 5, 18]);
    expect(starts(makeCode({ context: "exceptCommentsAndStringLiterals" }))).toEqual([0, 18]);
    expect(literalKindAt(makeCode({}).state, 14)).toBe("comment");
  });

  it("excluded matches are skipped by next and replace all, until the query changes", () => {
    const v = makeCode({ replace: "bar" });
    findNext(v);
    expect(sel(v)).toEqual([0, 3]);
    excludeCurrent(v);
    expect(sel(v)).toEqual([5, 8]);
    expect(isExcluded(v.state, 0, 3)).toBe(true);
    expect(countMatches(v.state).total).toBe(3);
    replaceAll(v, false);
    expect(v.state.doc.toString()).toBe('foo("bar") // bar\nbar');
    v.dispatch({ effects: setSearchQuery.of(makeQuery({ ...base, search: "o" })) });
    expect(v.state.field(findExcluded)).toEqual([]);
  });

  it("excluding an excluded match includes it again", () => {
    const v = makeCode({});
    v.dispatch({ effects: toggleFindExcluded.of({ from: 0, to: 3 }), selection: { anchor: 0, head: 3 } });
    excludeCurrent(v);
    expect(isExcluded(v.state, 0, 3)).toBe(false);
  });

  it("preserve case keeps each occurrence's case", () => {
    const v = make("foo Foo FOO", { search: "foo", replace: "bar" });
    replaceAll(v, true);
    expect(v.state.doc.toString()).toBe("bar Bar BAR");
    const w = make("Foo foo", { search: "foo", replace: "bar" });
    findNext(w);
    replaceNext(w, true);
    expect(w.state.doc.toString()).toBe("Bar foo");
    expect(sel(w)).toEqual([4, 7]);
  });
});

describe("in-file Find result lines", () => {
  it.each([
    [
      { search: "foo" },
      [
        [
          0,
          [
            [3, 6],
            [7, 10],
            [11, 14],
          ],
        ],
        [1, [[0, 3]]],
      ],
    ],
    [
      { search: "foo", caseSensitive: true },
      [
        [
          0,
          [
            [3, 6],
            [11, 14],
          ],
        ],
        [1, [[0, 3]]],
      ],
    ],
    [
      { search: "foo", wholeWord: true },
      [
        [
          0,
          [
            [3, 6],
            [7, 10],
          ],
        ],
        [1, [[0, 3]]],
      ],
    ],
    [
      { search: "f.o", regexp: true, caseSensitive: true },
      [
        [
          0,
          [
            [3, 6],
            [11, 14],
          ],
        ],
        [1, [[0, 3]]],
      ],
    ],
    [{ search: "missing" }, []],
    [{ search: "" }, []],
    [{ search: "[", regexp: true }, []],
  ] as const)("preserves matching options %j and UTF-16 columns", (options, expected) => {
    const v = make("😀 foo FOO foobar\nfoo", options);
    expect(findResultLines(v.state, { ...useOptions, ...options }).map((m) => [m.line, m.ranges])).toEqual(expected);
  });

  const useOptions: FindOptions = { search: "foo", regexp: false, caseSensitive: false, wholeWord: false, replace: "" };

  it("searches edited text in the selection scope, grouping ranges on the same line", () => {
    const v = make("foo\nfoo foo\nfoo", useOptions, { from: 4, to: 11 });
    v.dispatch({ changes: { from: 4, to: 7, insert: "FOO" } });
    expect(findResultLines(v.state, useOptions)).toEqual([
      {
        line: 1,
        text: "FOO foo",
        textOffset: 0,
        ranges: [
          [0, 3],
          [4, 7],
        ],
      },
    ]);
  });

  it("splits multiline matches into highlighted result lines", () => {
    const v = make("before foo\nbar after", { search: "foo\nbar" });
    expect(findResultLines(v.state, { ...useOptions, search: "foo\nbar" })).toEqual([
      { line: 0, text: "before foo", textOffset: 0, ranges: [[7, 10]] },
      { line: 1, text: "bar after", textOffset: 0, ranges: [[0, 3]] },
    ]);
  });

  it("retains excluded occurrences", () => {
    const v = make("foo foo foo", useOptions);
    v.dispatch({ effects: toggleFindExcluded.of({ from: 4, to: 7 }) });
    expect(findResultLines(v.state, useOptions)[0]?.ranges).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("exports every match beyond the bar counter limit", () => {
    const v = make("foo\n".repeat(10_005), useOptions);
    expect(findResultLines(v.state, useOptions)).toHaveLength(10_005);
  });
});
