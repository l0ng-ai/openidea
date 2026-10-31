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

async function tokens(source: string, fileName = "services.neon") {
  const support = await loadSupport(findLanguageDescription("NEON", fileName)!);
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

  // The cases below come from intellij-neon's NeonHighlightingLexerTest.
  const value = async (text: string) => (await tokens(`[${text}]`))[0];

  it("takes a value after `=` for a key, and keeps an entity's name a plain string", async () => {
    expect((await tokens("key= val"))[0]).toEqual(["key", "key"]);
    expect(await tokens("Foo(key: val)")).toEqual([
      ["Foo", "string"],
      ["key", "key"],
      ["val", "string"],
    ]);
  });

  it.each("true True TRUE yes Yes YES on On ON false False FALSE no No NO off Off OFF null Null NULL".split(" "))(
    "colours %s as a constant",
    async (text) => {
      expect(await value(text)).toEqual([text, "constant"]);
    },
  );

  it("does not take mixed case or a quoted keyword for a constant", async () => {
    expect(await value("TruE")).toEqual(["TruE", "string"]);
    expect(await value('"true"')).toEqual(['"true"', "string"]);
  });

  it.each(["42", "-1", "3.14", "0", "-0.5", "1.5e3", "1.5E-3", "0xff", "0xFF", "0o777", "0b1010"])(
    "colours %s as a number",
    async (text) => {
      expect(await value(text)).toEqual([text, "number"]);
    },
  );

  it.each(["42px", "-1e", "1e+-1", "--1"])("does not take %s for a number", async (text) => {
    expect(await value(text)).toEqual([text, "string"]);
  });

  it.each([
    "2025-10-20",
    "2025-1-5",
    "2025-10-20T11:44:55",
    "2025-10-20 11:44:55",
    "2025-10-20 11:44:55.1234",
    "2025-10-20 11:44:55+0200",
    "2025-10-20 11:44:55Z",
  ])("colours the date %s as a number", async (text) => {
    expect(await value(text)).toEqual([text, "number"]);
  });

  it.each(["2025-10", "10-20-2025", "hello", "mariadb-11.8.2", "Europe/Prague", "date.timezone", "app/Model"])(
    "leaves %s a plain string",
    async (text) => {
      expect(await value(text)).toEqual([text, "string"]);
    },
  );

  it.each(["@routerFactory", "@App\\Model\\Handler", "@factory::create"])("marks %s as a service", async (text) => {
    expect(await value(text)).toEqual([text, "service"]);
  });

  it.each(["App\\Model\\Foo", "app/Model/Foo.php", "src/test.neon", "services.neon", "Foo.php"])(
    "marks %s as a class or file",
    async (text) => {
      expect(await value(text)).toEqual([text, "class"]);
    },
  );

  // From intellij-neon's parser fixtures.
  it("reads the edge cases of strings and colons", async () => {
    expect(
      await tokens(`a: 'fo''o'
b: "\\"x"
c: the"string#literal
d: the"string #literal
e: :abc
f: a:bc
g: !hello
`),
    ).toEqual([
      ["a", "key"],
      ["'fo''o'", "string"],
      ["b", "key"],
      ['"\\"x"', "string"],
      ["c", "key"],
      ['the"string#literal', "string"],
      ["d", "key"],
      ['the"string', "string"],
      ["#literal", "comment"],
      ["e", "key"],
      [":abc", "string"],
      ["f", "key"],
      ["a:bc", "string"],
      ["g", "key"],
      ["!hello", "string"],
    ]);
  });

  it("marks a parameter next to escaped percents in one string", async () => {
    expect(await tokens(`a: '%%escaped%% and %realVar%'\n`)).toEqual([
      ["a", "key"],
      ["'%%escaped%% and ", "string"],
      ["%realVar%", "variable"],
      ["'", "string"],
    ]);
  });

  it("does not open a multiline string when text follows the quotes", async () => {
    expect(await tokens(`a: """b"""\nc: 1\n`)).toContainEqual(["c", "key"]);
  });

  // From intellij-neon's testTranslationValuesArePlainStrings and testTranslationKeepsKeysAndKeywords.
  it.each(["messages.cs.neon", "messages+intl-icu.cs.neon"])("reads the values of %s as prose", async (fileName) => {
    for (const text of ["@routerFactory", "App\\Model\\Foo", "app/Model/Foo.php"]) {
      expect((await tokens(`[${text}]`, fileName))[0]).toEqual([text, "string"]);
    }
    expect(await tokens("key: no\n", fileName)).toEqual([
      ["key", "key"],
      ["no", "constant"],
    ]);
  });

  it("marks %name% in a catalogue, but not in an ICU one", async () => {
    expect(await tokens("a: Hi %name%\n", "messages.cs.neon")).toContainEqual(["%name%", "variable"]);
    expect(await tokens("a: Hi %name%\n", "messages+intl-icu.cs.neon")).toEqual([
      ["a", "key"],
      ["Hi %name%", "string"],
    ]);
  });

  it("keeps a config with a locale-like name a config", async () => {
    expect((await tokens("[@a]", "config.dev.neon"))[0]).toEqual(["@a", "service"]);
    expect((await tokens("[@a]", "phpstan.cs.neon"))[0]).toEqual(["@a", "service"]);
  });

  it("flags a character NEON has no token for", async () => {
    expect(await tokens("a: `b\n")).toContainEqual(["`", "invalid"]);
  });
});
