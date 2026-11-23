import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { kotlin } from "@codemirror/legacy-modes/mode/clike";
import { highlightTree } from "@lezer/highlight";
import { lineLiteralAt, literalAt, literalsExtension } from "./literals";
import { setSyntaxHighlights } from "./syntaxHighlight";

vi.mock("@lezer/highlight", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lezer/highlight")>();
  return { ...original, highlightTree: vi.fn(original.highlightTree) };
});

const highlighted = vi.mocked(highlightTree);
beforeEach(() => {
  highlighted.mockClear();
});

/** The `[from, to]` window of every `highlightTree` call since the last `beforeEach`. */
const windows = () => highlighted.mock.calls.map(([tree, , , from = 0, to = tree.length]) => [from, to]);

const code = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `const v${i} = "value ${i}"; // note ${i}\nlet n${i} = ${i};`).join("\n") +
  "\nconst text = `first\nsecond`;\n";

const typescript = () => [javascript({ typescript: true })];

describe("lineLiteralAt", () => {
  it("finds the string literal or comment at a position, as literalAt does", () => {
    const state = EditorState.create({ doc: code(20), extensions: typescript() });
    const at = (needle: string, shift = 0) => state.doc.toString().indexOf(needle) + shift;
    for (const [pos, kind] of [
      [at('"value 7"', 3), "string"],
      [at("// note 7", 4), "comment"],
      [at("const v7", 2), null],
      [at("n7 = 7", 4), null],
    ] as const) {
      expect(lineLiteralAt(state, pos)?.kind ?? null).toBe(kind);
      expect(lineLiteralAt(state, pos)).toEqual(literalAt(state, pos));
    }
  });

  it("returns a literal that goes on past the line cut at the line break", () => {
    const state = EditorState.create({ doc: code(3), extensions: typescript() });
    const doc = state.doc.toString();
    const open = doc.indexOf("`first");
    const lit = lineLiteralAt(state, open + 2)!;
    expect(lit.kind).toBe("string");
    expect(lit.from).toBe(open);
    expect(state.doc.lineAt(lit.to).number).not.toBe(state.doc.lineAt(lit.from).number);
    const second = doc.indexOf("second");
    const rest = lineLiteralAt(state, second + 2)!;
    expect(state.doc.lineAt(rest.from).number).not.toBe(state.doc.lineAt(rest.to).number);
  });

  it("highlights the line and its line breaks, not the document", () => {
    // `literalAt` asks for the whole document: a rebuilt scan of every line for each Enter typed.
    const sizes = [200, 4000].map((lines) => {
      const state = EditorState.create({ doc: code(lines), extensions: typescript() });
      const pos = state.doc.toString().indexOf('"value 150"') + 3;
      const line = state.doc.lineAt(pos);
      highlighted.mockClear();
      expect(lineLiteralAt(state, pos)?.kind).toBe("string");
      const covered = windows().map(([from, to]) => to! - from!);
      expect(Math.max(...covered)).toBeLessThanOrEqual(line.length + 2);
      return covered.length;
    });
    expect(sizes[1]).toBe(sizes[0]);
  });

  it("finds literals of languages with a stream parser", () => {
    const doc = 'val a = 1\nval s = "hi there" // done\n';
    const state = EditorState.create({ doc, extensions: [StreamLanguage.define(kotlin)] });
    expect(lineLiteralAt(state, doc.indexOf("hi") + 1)).toEqual({
      from: doc.indexOf('"hi'),
      to: doc.indexOf(" //"),
      kind: "string",
    });
    expect(lineLiteralAt(state, doc.indexOf("done"))?.kind).toBe("comment");
    expect(lineLiteralAt(state, doc.indexOf("val a"))).toBeNull();
  });

  it("falls back to the highlights of the backend for languages without a parser", () => {
    const doc = "plain\nx = 'quoted'\n";
    const state = EditorState.create({ doc, extensions: [literalsExtension] }).update({
      effects: setSyntaxHighlights.of({ kinds: ["string"], data: [doc.indexOf("'q"), doc.indexOf("'\n") + 1, 0] }),
    }).state;
    expect(lineLiteralAt(state, doc.indexOf("quoted"))).toEqual({
      from: doc.indexOf("'q"),
      to: doc.indexOf("'\n") + 1,
      kind: "string",
    });
    expect(lineLiteralAt(state, 2)).toBeNull();
  });
});
