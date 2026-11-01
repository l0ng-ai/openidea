import { describe, expect, it, vi } from "vitest";
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
import { dedentsToColumnZero, formatDocument, formattedLines } from "./format";

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
});
