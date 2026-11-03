import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import fixture from "../../../../fixtures/folding/regions.json";
import { createMemoryBackend } from "../backend";
import { commentTokens } from "./languages";
import { foldsFromRanges } from "./folding";
import { customRegions, regionMarker, regionNameAt, type RegionCommentTokens } from "./regions";

const definitions = import.meta.glob<string>("../../../../languages/*.toml", {
  query: "?raw",
  import: "default",
  eager: true,
});

function language(id: string) {
  const source = definitions[`../../../../languages/${id}.toml`]!;
  const lineComment = /^line-comment = (".*")$/m.exec(source)?.[1];
  const blockComment = /^block-comment = (\[.*\])$/m.exec(source)?.[1];
  return {
    id,
    name: id,
    extensions: [],
    uiMode: null,
    indent: null,
    lineComment: lineComment ? (JSON.parse(lineComment) as string) : null,
    blockComment: blockComment ? (JSON.parse(blockComment) as [string, string]) : null,
  };
}

const make = (doc: string, id = "java") => EditorState.create({ doc, extensions: commentTokens(language(id)) });

// The native folding suite consumes this same marker contract and the TOML tokens.
describe.each(fixture.languages)("custom regions in %s", (id) => {
  const info = language(id);
  const tokens: RegionCommentTokens = {
    line: info.lineComment ?? undefined,
    block: info.blockComment ? { open: info.blockComment[0], close: info.blockComment[1] } : undefined,
  };
  const delimiters: [string, string][] = [];
  if (tokens.line) delimiters.push([tokens.line, ""]);
  if (tokens.block) delimiters.push([tokens.block.open, tokens.block.close]);

  it.each(delimiters)("uses %s … %s with optional spaces", (open, close) => {
    for (const space of ["", " ", "  "]) {
      if (!space && /[a-z0-9]$/i.test(open)) continue;
      const wrap = (body: string) => `  ${open}${space}${body}${space}${close}`;
      for (const marker of fixture.markers) {
        const start = wrap(marker.start);
        const end = wrap(marker.end);
        expect(regionMarker(start, tokens)).toEqual({ start: true, name: marker.name });
        expect(regionMarker(end, tokens)).toEqual({ start: false });
        const state = make(`${start}\n\n${end}\n`, id);
        expect(customRegions(state)).toEqual([{ name: marker.name, startLine: 1, endLine: 3 }]);
        expect(regionNameAt(state, 2)).toBe(marker.name || null);
        expect(regionNameAt(state, 5)).toBeNull();
        const [fold] = foldsFromRanges(state, [{ start_line: 0, end_line: 2, kind: "region" }]);
        expect(fold).toMatchObject({ from: 2, to: state.doc.line(3).to, custom: true });
        const nested = make(`${end}\n\n${start}\n${start}\n\n${end}\n${end}\n${start}\n`, id);
        expect(customRegions(nested)).toEqual([
          { name: marker.name, startLine: 3, endLine: 7 },
          { name: marker.name, startLine: 4, endLine: 6 },
        ]);
      }
      for (const invalid of fixture.invalid) expect(regionMarker(wrap(invalid), tokens)).toBeNull();
    }
  });
});

describe("regionMarker", () => {
  it.each(["///region Docs", "/**region Docs*/", "// #region Docs"])("preserves %s", (text) => {
    expect(regionMarker(text, { line: "//", block: { open: "/*", close: "*/" } })).toEqual({
      start: true,
      name: "Docs",
    });
  });

  it.each(["const region = 1;", "region Name", "//region Wrong language", "<!--region Missing close"])(
    "rejects %s in XML",
    (text) => {
      expect(regionMarker(text, { block: { open: "<!--", close: "-->" } })).toBeNull();
    },
  );

  it("preserves C# region directives and their names", () => {
    const state = make('#region "Fields"\nint a;\n#endregion', "csharp");
    expect(customRegions(state)).toEqual([{ name: "Fields", startLine: 1, endLine: 3 }]);
    expect(regionNameAt(state, 0)).toBe("Fields");
    expect(foldsFromRanges(state, [{ start_line: 0, end_line: 2, kind: "region" }])[0]?.custom).toBe(true);
  });

  it("does not list plain text as a region without comment tokens", () => {
    expect(customRegions(EditorState.create({ doc: "region Name\n\nendregion" }))).toEqual([]);
  });
});

describe("memory backend custom folding", () => {
  it.each(["xml", "svg", "html", "vue", "css", "java", "py", "ts"])("folds %s markers", async (extension) => {
    const path = `/project/file.${extension}`;
    const css = extension === "css";
    const line = extension === "py" ? "#" : ["java", "ts"].includes(extension) ? "//" : null;
    const open = line ?? (css ? "/*" : "<!--");
    const close = line ? "" : css ? "*/" : "-->";
    const backend = createMemoryBackend({ [path]: `${open}region Name${close}\ncontent\n${open}endregion${close}\n` });
    const doc = await backend.open(path);
    expect(await backend.folding(doc.id)).toEqual([{ start_line: 0, end_line: 2, kind: "region" }]);
  });
});
