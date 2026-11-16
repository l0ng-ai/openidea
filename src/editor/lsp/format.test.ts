import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CONTRIBUTED_FORMAT } from "@/editor/api";
import { useProject } from "@/platform/project";
import type { Settings } from "@/bindings";
import {
  formatExcluded,
  guardFormatChanges,
  guardTextEdits,
  protectedRegions,
  type FormatGuardOptions,
} from "@/platform/formatGuard";
import { indentExtension } from "@/editor/core/cm/setup";
import { IpcError } from "@/platform/ipc";
import type { TextEdit } from "@/bindings";
import { dedentsToColumnZero, formatDocument, formatOptionsOf, formattedLines } from "./format";
import { formatsOnSave } from "./actions";
import * as lsp from "./lsp";

describe("formatOptionsOf", () => {
  const stateWith = (...args: Parameters<typeof indentExtension>) =>
    EditorState.create({ extensions: indentExtension(...args) });

  it("asks for the Code Style override, not the indent detected in the file", () => {
    // Code Style › Java: tab character, tab size 1; the file was indented with 4 spaces.
    const state = stateWith({ tabSize: 4, insertSpaces: true }, { tabSize: 1, insertSpaces: false, indentSize: 1 });
    expect(formatOptionsOf(state)).toEqual({ tabSize: 1, insertSpaces: false });
  });

  it("sends the tab size with tabs and the indent size with spaces", () => {
    const editor = { tabSize: 8, insertSpaces: true };
    expect(formatOptionsOf(stateWith(editor, { tabSize: 4, insertSpaces: false, indentSize: 2 }))).toEqual({
      tabSize: 4,
      insertSpaces: false,
    });
    expect(formatOptionsOf(stateWith(editor, { tabSize: 4, insertSpaces: true, indentSize: 2 }))).toEqual({
      tabSize: 2,
      insertSpaces: true,
    });
  });

  it("keeps the editor's indent without an override", () => {
    expect(formatOptionsOf(stateWith({ tabSize: 4, insertSpaces: true, indentSize: 2 }))).toEqual({
      tabSize: 2,
      insertSpaces: true,
    });
    expect(formatOptionsOf(stateWith({ tabSize: 3, insertSpaces: false }))).toEqual({
      tabSize: 3,
      insertSpaces: false,
    });
  });
});

describe("formattedLines", () => {
  const doc = Text.of(["fn  main(){", "let x=1;", "}", "", "fn other() {}"]);
  const lineStart = (n: number) => doc.line(n).from;

  it("counts the lines of the result the changes touched", () => {
    expect(
      formattedLines(doc, [
        { from: lineStart(1) + 2, to: lineStart(1) + 4, insert: " " },
        { from: lineStart(1) + 10, to: lineStart(1) + 10, insert: " " },
        { from: lineStart(2), to: lineStart(2), insert: "    " },
      ]),
    ).toBe(2);
  });

  it("numbers lines as in the new text when a change adds lines", () => {
    // `{}` split over two lines, then a change on (old) line 5 = new line 6.
    expect(
      formattedLines(doc, [
        { from: lineStart(5) + 11, to: lineStart(5) + 12, insert: "{\n" },
        { from: lineStart(1), to: lineStart(1) + 1, insert: "f" },
      ]),
    ).toBe(3);
  });
});

describe("formatter markers and Do not format", () => {
  const on: FormatGuardOptions = {
    doNotFormat: [],
    formatterTagsEnabled: true,
    formatterOffTag: "@formatter:off",
    formatterOnTag: "@formatter:on",
    formatterTagsRegexp: false,
  };
  const lines = ["a  =  1", "// @formatter:off", "b  =  2", "// @formatter:on", "c  =  3"];
  const text = lines.join("\n");
  const at = (line: number, col = 0) => lines.slice(0, line).join("\n").length + (line ? 1 : 0) + col;
  const apply = (t: string, cs: readonly { from: number; to: number; insert: string }[]) =>
    [...cs].sort((x, y) => y.from - x.from).reduce((s, c) => s.slice(0, c.from) + c.insert + s.slice(c.to), t);
  const formatted = ["a = 1", "// @formatter:off", "b = 2", "// @formatter:on", "c = 3"].join("\n");
  const expected = ["a = 1", "// @formatter:off", "b  =  2", "// @formatter:on", "c = 3"].join("\n");

  it("finds the regions between markers in comments", () => {
    expect(protectedRegions(text, on)).toEqual([{ from: at(1), to: at(3, "// @formatter:on".length) }]);
    expect(protectedRegions(text, { ...on, formatterTagsEnabled: false })).toEqual([]);
    expect(protectedRegions('s = "@formatter:off"\nx', on)).toEqual([]);
    // Without an on marker the region runs to the end.
    expect(protectedRegions("x\n# @formatter:off\ny", on)).toEqual([{ from: 2, to: 20 }]);
    const regexp = { ...on, formatterOffTag: "fmt:\\s*off", formatterOnTag: "fmt:\\s*on", formatterTagsRegexp: true };
    expect(protectedRegions("// fmt: off\nx\n// fmt:on", regexp)).toEqual([{ from: 0, to: 23 }]);
  });

  it("drops edits inside a region and keeps the others", () => {
    const changes = [
      { from: at(0, 1), to: at(0, 3), insert: " " },
      { from: at(2, 1), to: at(2, 3), insert: " " },
      { from: at(4, 1), to: at(4, 3), insert: " " },
    ];
    expect(apply(text, guardFormatChanges(text, changes, on))).toBe(
      ["a =  1", "// @formatter:off", "b  =  2", "// @formatter:on", "c =  3"].join("\n"),
    );
    expect(guardFormatChanges(text, changes, { ...on, formatterTagsEnabled: false })).toEqual(changes);
  });

  it("splits a whole-file replacement around the regions", () => {
    expect(apply(text, guardFormatChanges(text, [{ from: 0, to: text.length, insert: formatted }], on))).toBe(expected);
    const edits = guardTextEdits(
      text,
      [{ range: { start: { line: 0, col: 0 }, end: { line: 4, col: 7 } }, new_text: formatted }],
      on,
    );
    const asChanges = edits.map((e) => ({
      from: at(e.range.start.line, e.range.start.col),
      to: at(e.range.end.line, e.range.end.col),
      insert: e.new_text,
    }));
    expect(apply(text, asChanges)).toBe(expected);
  });

  it("matches Do not format globs against names and project paths", () => {
    const globs = ["*.min.js", "generated", "src/vendor/**", "docs/"];
    expect(formatExcluded("/p/web/app.min.js", "/p", globs)).toBe(true);
    expect(formatExcluded("/p/a/generated/x.ts", "/p", globs)).toBe(true);
    expect(formatExcluded("/p/src/vendor/lib/x.ts", "/p", globs)).toBe(true);
    expect(formatExcluded("/p/docs/a.md", "/p", globs)).toBe(true);
    expect(formatExcluded("/p/src/app.js", "/p", globs)).toBe(false);
    expect(formatExcluded("/p/other/docs.md", "/p", globs)).toBe(false);
  });
});

describe("dedentsToColumnZero", () => {
  it("spots range formatting done without the surrounding code", () => {
    expect(dedentsToColumnZero("\n    override fun f() { }\n", "\noverride fun f() {}\n")).toBe(true);
    expect(dedentsToColumnZero("\n\tfun f() {\n\t}\n", "\n    fun f() {\n    }\n")).toBe(false);
    expect(dedentsToColumnZero("fun f() {}\n", "fun f() { }\n")).toBe(false);
  });
});

describe("format on save provider isolation", () => {
  it("does not enable contributed formatters when only Prettier save is enabled", async () => {
    const previous = useProject.getState();
    const formatter = vi.fn(() => [{ from: 0, to: 6, insert: "SELECT" }]);
    const view = new EditorView({
      state: EditorState.create({
        doc: "select",
        extensions: [EditorState.languageData.of(() => [{ [CONTRIBUTED_FORMAT]: formatter }])],
      }),
    });
    try {
      const settings = { editor: { formatOnSave: false }, languages: { prettier: { runOnSave: true } } } as Settings;
      useProject.setState({ settings });
      expect((await formatDocument(view, { explicit: false, onSave: true })).applied).toBe(false);
      expect(formatter).not.toHaveBeenCalled();
      useProject.setState({ settings: { ...settings, editor: { ...settings.editor, formatOnSave: true } } });
      expect((await formatDocument(view, { explicit: false, onSave: true })).applied).toBe(true);
      expect(view.state.doc.toString()).toBe("SELECT");
    } finally {
      view.destroy();
      useProject.setState(previous);
    }
  });

  it("formats on save for the languages whose Prettier or oxfmt Run on save is on", () => {
    const settings = (languages: Settings["languages"], formatOnSave = false) =>
      ({ editor: { formatOnSave }, languages }) as Settings;
    const oxfmt = settings({ oxfmt: { runOnSave: true, languages: ["typescript"] } });
    expect(formatsOnSave(oxfmt, "typescript")).toBe(true);
    expect(formatsOnSave(oxfmt, "markdown")).toBe(false);
    expect(formatsOnSave(settings({ prettier: { runOnSave: true } }), "markdown")).toBe(true);
    expect(formatsOnSave(settings({ ruff: { runOnSave: true } }), "python")).toBe(true);
    expect(formatsOnSave(settings({ ruff: { runOnSave: true } }), "typescript")).toBe(false);
    expect(formatsOnSave(settings({}), "typescript")).toBe(false);
    expect(formatsOnSave(settings({}, true), "rust")).toBe(true);
    expect(formatsOnSave(null, "typescript")).toBe(false);
  });
});

describe("formatting given ranges (Only VCS changed text)", () => {
  const lines = ["a  =  1", "b  =  2", "c  =  3"];
  const viewOf = () =>
    new EditorView({
      state: EditorState.create({
        doc: lines.join("\n"),
        extensions: [lsp.lspDoc.of({ doc: 1, path: "/p/a.py", language: "python", uiMode: null, readOnly: false })],
      }),
    });
  /** A server answering every request, range or not, with edits for the whole file. */
  const wholeFile = (): TextEdit[] =>
    lines.map((_, line) => ({ range: { start: { line, col: 1 }, end: { line, col: 3 } }, new_text: " " }));
  const lineRange = (view: EditorView, n: number) => ({
    from: view.state.doc.line(n).from,
    to: view.state.doc.line(n).to,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("changes only the lines inside the ranges, one request per range", async () => {
    const request = vi.spyOn(lsp, "lspRequest").mockImplementation(async () => wholeFile());
    const view = viewOf();
    try {
      const ranges = [lineRange(view, 1), lineRange(view, 3)];
      expect((await formatDocument(view, { explicit: false, ranges })).applied).toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      expect(view.state.doc.toString()).toBe(["a =  1", "b  =  2", "c =  3"].join("\n"));
    } finally {
      view.destroy();
    }
  });

  it("formats nothing for no ranges, as in a file without changes", async () => {
    const request = vi.spyOn(lsp, "lspRequest").mockImplementation(async () => wholeFile());
    const view = viewOf();
    try {
      expect((await formatDocument(view, { explicit: false, ranges: [] })).applied).toBe(false);
      expect(request).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(lines.join("\n"));
    } finally {
      view.destroy();
    }
  });

  it("tells a file without a formatter apart from one already formatted", async () => {
    const view = viewOf();
    try {
      vi.spyOn(lsp, "lspRequest").mockRejectedValue(
        new IpcError({ kind: "unavailable", message: "No language server available" }),
      );
      expect(await formatDocument(view, { explicit: false })).toMatchObject({ applied: false, noFormatter: true });
      // The file's formatter (Prettier here) is not installed.
      vi.spyOn(lsp, "lspRequest").mockRejectedValue(
        new IpcError({
          kind: "notFound",
          message: "prettier is not installed",
          data: { type: "tool", tool: "prettier", missing: true },
        } as ConstructorParameters<typeof IpcError>[0]),
      );
      expect(await formatDocument(view, { explicit: false })).toMatchObject({ applied: false, noFormatter: true });
      vi.spyOn(lsp, "lspRequest").mockResolvedValue([]);
      expect((await formatDocument(view, { explicit: false })).noFormatter).toBeUndefined();
    } finally {
      view.destroy();
    }
  });
});
