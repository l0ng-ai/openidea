import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

const highlighter = tagHighlighter([
  { tag: t.propertyName, class: "key" },
  { tag: t.atom, class: "constant" },
  { tag: t.number, class: "number" },
  { tag: t.string, class: "string" },
  { tag: t.className, class: "class" },
  { tag: t.meta, class: "service" },
  { tag: t.variableName, class: "variable" },
  { tag: t.comment, class: "comment" },
  { tag: t.invalid, class: "invalid" },
]);

async function tokens(source: string) {
  const support = await loadSupport(findLanguageDescription("NEON", "services.neon")!);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const out: [string, string][] = [];
  highlightTree(syntaxTree(state), highlighter, (from, to, style) =>
    out.push([state.doc.sliceString(from, to), style]),
  );
  return out;
}

describe("NEON highlighting", () => {
  it("resolves by name and by extension", () => {
    expect(findLanguageDescription(null, "config/common.neon")?.name).toBe("NEON");
  });

  it("tells keys from values, services, classes and files", async () => {
    const out = await tokens(`# services
parameters:
\tdebug: true
\tlimit: 0x1F
\tsince: 2026-10-31 12:00:00
\ttitle: some plain words
services:
\trouter: App\\Router(@factory::create, mode=off)
\t- include.neon
`);
    expect(out).toEqual([
      ["# services", "comment"],
      ["parameters", "key"],
      ["debug", "key"],
      ["true", "constant"],
      ["limit", "key"],
      ["0x1F", "number"],
      ["since", "key"],
      ["2026-10-31 12:00:00", "number"],
      ["title", "key"],
      ["some plain words", "string"],
      ["services", "key"],
      ["router", "key"],
      ["App\\Router", "class"],
      ["@factory::create", "service"],
      ["mode", "key"],
      ["off", "constant"],
      ["include.neon", "class"],
    ]);
  });

  it("keeps a colon inside a value and treats a quoted key as a key", async () => {
    expect(await tokens(`url: http://example.com:8080/a\n"quoted key": 'value'\n`)).toEqual([
      ["url", "key"],
      ["http://example.com:8080/a", "string"],
      ['"quoted key"', "key"],
      ["'value'", "string"],
    ]);
  });

  it("marks %parameters% inside literals and strings, but not an escaped %%", async () => {
    expect(await tokens(`a: %appDir%/log\nb: "x %env.NAME%"\nc: 100%%\n`)).toEqual([
      ["a", "key"],
      ["%appDir%", "variable"],
      ["/log", "string"],
      ["b", "key"],
      ['"x ', "string"],
      ["%env.NAME%", "variable"],
      ['"', "string"],
      ["c", "key"],
      ["100%%", "string"],
    ]);
  });

  it("stays in a multiline string until its closing quotes", async () => {
    expect(await tokens(`text: """\n\tkey: %v%\n\t"""\nnext: 1\n`)).toEqual([
      ["text", "key"],
      ['"""', "string"],
      ["\tkey: ", "string"],
      ["%v%", "variable"],
      ['\t"""', "string"],
      ["next", "key"],
      ["1", "number"],
    ]);
  });

  it("flags a character NEON has no token for", async () => {
    expect(await tokens("a: `b\n")).toContainEqual(["`", "invalid"]);
  });
});
