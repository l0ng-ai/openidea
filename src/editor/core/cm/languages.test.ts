import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { LanguageDescription, type Language } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { getIndentation } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { logWarning } from "./highlight";
import { fencedCodeMode, findLanguageDescription, loadSupport } from "./languages";

describe("language modes", () => {
  it("highlights Julia declarations, calls, types, macros and literals without semantic tokens", async () => {
    const description = findLanguageDescription("Julia", "/tmp/palette.jl");
    expect(description?.name).toBe("Julia");
    const support = await loadSupport(description!);
    const source = [
      "struct Point end",
      "function distance(p::Point)",
      '  label = "point"',
      "  norm(p)",
      "  return 3, 3.5",
      "end",
      "@show distance(Point())",
      "# comment",
    ].join("\n");
    const found: Array<[string, string]> = [];
    highlightTree(
      support!.language.parser.parse(source),
      tagHighlighter([
        { tag: t.keyword, class: "keyword" },
        { tag: t.function(t.definition(t.variableName)), class: "function-definition" },
        { tag: t.function(t.variableName), class: "function-call" },
        { tag: t.definition(t.typeName), class: "type-definition" },
        { tag: t.typeName, class: "type-reference" },
        { tag: t.macroName, class: "macro" },
        { tag: t.integer, class: "integer" },
        { tag: t.float, class: "float" },
        { tag: t.string, class: "string" },
        { tag: t.lineComment, class: "comment" },
      ]),
      (from, to, style) => found.push([source.slice(from, to), style]),
    );

    expect(found).toEqual([
      ["struct", "keyword"],
      ["Point", "type-definition"],
      ["end", "keyword"],
      ["function", "keyword"],
      ["distance", "function-definition"],
      ["Point", "type-reference"],
      ['"point"', "string"],
      ["norm", "function-call"],
      ["return", "keyword"],
      ["3", "integer"],
      ["3.5", "float"],
      ["end", "keyword"],
      ["@show", "macro"],
      ["distance", "function-call"],
      ["Point", "function-call"],
      ["# comment", "comment"],
    ]);
  });

  it("distinguishes PHP classes, method declarations and fields for imported schemes", async () => {
    const support = await loadSupport(findLanguageDescription("PHP", "/tmp/palette.php")!);
    const source = "<?php class Palette extends BasePalette { var $name; function example() {} }";
    const found: Array<[string, string]> = [];
    highlightTree(
      support!.language.parser.parse(source),
      tagHighlighter([
        { tag: t.className, class: "class" },
        { tag: t.function(t.definition(t.variableName)), class: "function" },
        { tag: t.definition(t.propertyName), class: "field" },
      ]),
      (from, to, style) => found.push([source.slice(from, to), style]),
    );
    expect(found).toEqual([
      ["Palette", "class"],
      ["BasePalette", "class"],
      ["$name", "field"],
      ["example", "function"],
    ]);
  });

  it("parses YAML into large tree buffers and highlights mappings after comment lines", async () => {
    for (const path of ["/p/application.yml", "/p/compose.yaml"]) {
      const support = await loadSupport(findLanguageDescription("YAML", path)!);
      // @lezer/yaml can invert a node's range on a tree buffer boundary; one buffer avoids it.
      expect((support!.language.parser as unknown as { bufferLength: number }).bufferLength).toBe(1 << 16);
    }
    const support = await loadSupport(findLanguageDescription("YAML", "/p/application.yml")!);
    const source = "spring:\n  datasource:\n  # driver: a\n  # url: b\n    driver: c # d\n    url: e\n";
    const found: Array<[string, string]> = [];
    highlightTree(
      support!.language.parser.parse(source),
      tagHighlighter([
        { tag: t.lineComment, class: "comment" },
        { tag: t.definition(t.propertyName), class: "key" },
      ]),
      (from, to, style) => found.push([source.slice(from, to), style]),
    );
    expect(found.filter(([, style]) => style === "comment").map(([text]) => text)).toEqual([
      "# driver: a",
      "# url: b",
      "# d",
    ]);
  });

  it("recognizes AsciiDoc files and loads their lightweight syntax mode", async () => {
    for (const path of ["/docs/guide.adoc", "/docs/guide.asciidoc"]) {
      const description = findLanguageDescription("AsciiDoc", path);
      expect(description?.name).toBe("AsciiDoc");
      const support = await loadSupport(description!);
      expect(support?.language).toBeTruthy();
    }
  });

  it("highlights log levels, timestamps, exception names and stack frames", async () => {
    const description = findLanguageDescription("Log", "/var/log/server.log");
    expect(description?.name).toBe("Log");
    const support = await loadSupport(description!);
    const doc = [
      "2024-05-01 12:00:00,123 ERROR [main] Boom: java.lang.IllegalStateException: bad",
      "\tat com.acme.Main.run(Main.java:42)",
      "\t... 3 more",
      "12:00:01.5 [warn] retry https://acme.test/x",
      "ts=1 level=info msg=started",
      "INFOS and errors stay plain, DEBUG does not",
    ].join("\n");
    const highlighter = tagHighlighter([
      { tag: t.invalid, class: "error" },
      { tag: logWarning, class: "warn" },
      { tag: t.string, class: "info" },
      { tag: t.comment, class: "dim" },
      { tag: t.number, class: "time" },
      { tag: t.typeName, class: "type" },
      { tag: t.link, class: "link" },
    ]);
    const highlighted: [string, string][] = [];
    highlightTree(support!.language.parser.parse(doc), highlighter, (from, to, style) => {
      highlighted.push([doc.slice(from, to), style]);
    });
    expect(highlighted).toEqual([
      ["2024-05-01 12:00:00,123", "time"],
      ["ERROR", "error"],
      ["java.lang.IllegalStateException", "type"],
      ["\tat com.acme.Main.run(Main.java:42)", "dim"],
      ["\t... 3 more", "dim"],
      ["12:00:01.5", "time"],
      ["warn", "warn"],
      ["https://acme.test/x", "link"],
      ["info", "info"],
      ["DEBUG", "dim"],
    ]);
  });

  it("assigns highlight tags to AsciiDoc syntax", async () => {
    const support = await loadSupport(findLanguageDescription("AsciiDoc", "/docs/guide.adoc")!);
    const doc = [
      "= Guide",
      ":toc: left",
      "----",
      "const example = true;",
      "----",
      "*bold* _italic_ `code` https://example.com",
      "// Comment",
    ].join("\n");
    const highlighter = tagHighlighter([
      { tag: t.heading, class: "heading" },
      { tag: t.attributeName, class: "attribute" },
      { tag: t.meta, class: "meta" },
      { tag: t.monospace, class: "monospace" },
      { tag: t.strong, class: "strong" },
      { tag: t.emphasis, class: "emphasis" },
      { tag: t.link, class: "link" },
      { tag: t.comment, class: "comment" },
    ]);
    const highlighted: [string, string][] = [];
    highlightTree(support!.language.parser.parse(doc), highlighter, (from, to, style) => {
      highlighted.push([doc.slice(from, to), style]);
    });
    expect(highlighted).toEqual([
      ["= Guide", "heading"],
      [":toc: left", "attribute"],
      ["----", "meta"],
      ["const example = true;", "monospace"],
      ["----", "meta"],
      ["*bold*", "strong"],
      ["_italic_", "emphasis"],
      ["`code`", "monospace"],
      ["https://example.com", "link"],
      ["// Comment", "comment"],
    ]);
  });

  it("recognizes reStructuredText files and highlights their syntax", async () => {
    expect(findLanguageDescription("reStructuredText", "/docs/index.rst")?.name).toBe("reStructuredText");
    const support = await loadSupport(findLanguageDescription("reStructuredText", "/docs/index.rst")!);
    const state = EditorState.create({ extensions: support!.language });
    expect(state.languageDataAt("commentTokens", 0)).toEqual([{ line: ".." }]);
    const doc = [
      "=====",
      "Guide",
      "=====",
      "",
      "Intro",
      "-----",
      "",
      "Some **bold**, *em*, ``code``, :py:func:`len`, `Docs <https://example.com>`_ and target_.",
      "See https://example.com and |sub|.",
      "",
      "Example::",
      "",
      "   Not a title",
      "   -----------",
      "",
      ".. code-block:: python",
      "   :linenos:",
      "",
      "   x = 1",
      "",
      ".. _target:",
      "",
      ".. a comment",
      "   continued",
      "",
      ":field: value",
      "",
      "A paragraph",
      "-----",
      "",
      "Two lines of",
      "a paragraph",
      "------------",
    ].join("\n");
    const highlighter = tagHighlighter([
      { tag: t.heading, class: "heading" },
      { tag: t.strong, class: "strong" },
      { tag: t.emphasis, class: "emphasis" },
      { tag: t.monospace, class: "monospace" },
      { tag: t.keyword, class: "keyword" },
      { tag: t.string, class: "string" },
      { tag: t.link, class: "link" },
      { tag: t.url, class: "url" },
      { tag: t.variableName, class: "variable" },
      { tag: t.attributeName, class: "attribute" },
      { tag: t.labelName, class: "label" },
      { tag: t.comment, class: "comment" },
    ]);
    const highlighted: [string, string][] = [];
    highlightTree(support!.language.parser.parse(doc), highlighter, (from, to, style) => {
      highlighted.push([doc.slice(from, to), style]);
    });
    expect(highlighted).toEqual([
      ["=====\nGuide\n=====", "heading"],
      ["Intro\n-----", "heading"],
      ["**bold**", "strong"],
      ["*em*", "emphasis"],
      ["``code``", "monospace"],
      [":py:func:", "keyword"],
      ["`len`", "string"],
      ["`Docs <https://example.com>`_", "link"],
      ["target_", "link"],
      ["https://example.com", "url"],
      ["|sub|", "variable"],
      ["Not a title", "monospace"],
      ["-----------", "monospace"],
      [".. code-block::", "keyword"],
      [":linenos:", "attribute"],
      ["x = 1", "monospace"],
      [".. _target:", "label"],
      [".. a comment", "comment"],
      ["continued", "comment"],
      [":field:", "attribute"],
      ["A paragraph\n-----", "heading"],
    ]);
  });

  it("preserves Unicode heading offsets with CRLF and skips escaped markup", async () => {
    const support = await loadSupport(findLanguageDescription("reStructuredText", "guide.rst")!);
    const doc =
      "=========\r\n 中文😀\r\n=========\r\n\r\n子章节\r\n------\r\n\r\n\\*plain* and \\`plain` and **strong**";
    const highlighted: [string, string][] = [];
    highlightTree(
      support!.language.parser.parse(doc),
      tagHighlighter([
        { tag: t.heading, class: "heading" },
        { tag: t.strong, class: "strong" },
        { tag: t.emphasis, class: "emphasis" },
        { tag: t.string, class: "string" },
      ]),
      (from, to, style) => highlighted.push([doc.slice(from, to), style]),
    );
    expect(highlighted).toEqual([
      ["=========\r\n 中文😀\r\n=========", "heading"],
      ["子章节\r\n------", "heading"],
      ["**strong**", "strong"],
    ]);
  });

  it("counts the indentation of short overlined titles", async () => {
    const support = await loadSupport(findLanguageDescription("reStructuredText", "guide.rst")!);
    const doc = "===\n  Hi\n===";
    const headings: string[] = [];
    highlightTree(
      support!.language.parser.parse(doc),
      tagHighlighter([{ tag: t.heading, class: "heading" }]),
      (from, to) => headings.push(doc.slice(from, to)),
    );
    expect(headings).toEqual([]);
  });

  it("styles `?.` like `.` in JavaScript and TypeScript", async () => {
    const highlighter = tagHighlighter([{ tag: t.derefOperator, class: "deref" }]);
    for (const [mode, path] of [
      ["JavaScript", "/p/a.js"],
      ["TypeScript", "/p/a.ts"],
      ["JSX", "/p/a.jsx"],
      ["TSX", "/p/a.tsx"],
    ] as const) {
      const support = await loadSupport(findLanguageDescription(mode, path)!);
      const doc = "a?.b.c?.();";
      const derefs: string[] = [];
      highlightTree(support!.language.parser.parse(doc), highlighter, (from, to) => derefs.push(doc.slice(from, to)));
      expect(derefs, mode).toEqual(["?.", ".", "?."]);
    }
  });

  it('keeps C++ namespace and extern "C" contents at the level of their braces', async () => {
    const support = await loadSupport(findLanguageDescription("C++", "/p/a.cpp")!);
    const doc = [
      "namespace foo {",
      "class Bar {",
      "  int x;",
      "};",
      "namespace inner {",
      "void f() {",
      "  g();",
      "}",
      "}  // namespace inner",
      "}  // namespace foo",
      'extern "C" {',
      "int h();",
      "}",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: [support!, EditorState.tabSize.of(2)] });
    const indent = (line: number) => getIndentation(state, state.doc.line(line).from);
    expect([2, 3, 4, 5, 6, 7, 9, 10, 12, 13].map(indent)).toEqual([0, 2, 0, 0, 0, 2, 0, 0, 0, 0]);
  });

  it("keeps an annotation above a declaration on its own indentation after Enter", async () => {
    const support = await loadSupport(findLanguageDescription("Java", "/p/A.java")!);
    const enter = (doc: string, at = doc.length) => {
      const view = new EditorView({
        state: EditorState.create({
          doc,
          selection: EditorSelection.cursor(at),
          extensions: [support!],
        }),
        parent: document.body,
      });
      insertNewlineAndIndent(view);
      const out = view.state.doc.toString();
      view.destroy();
      return out;
    };
    // An annotation ends the declaration it annotates: the next line keeps its indentation.
    expect(enter("@RestController")).toBe("@RestController\n");
    expect(enter("@RestController\npublic class A {}", 15)).toBe("@RestController\n\npublic class A {}");
    expect(enter('@RequestMapping("/zhyz/zhyzposition")')).toBe('@RequestMapping("/zhyz/zhyzposition")\n');
    expect(enter('@Api(value = "PositionController", tags = "职位")')).toBe(
      '@Api(value = "PositionController", tags = "职位")\n',
    );
    expect(enter('@Api(\n    value = "x"\n)')).toBe('@Api(\n    value = "x"\n)\n');
    expect(enter("class A {\n    @Override")).toBe("class A {\n    @Override\n    ");
    expect(enter("class A {\n    @Override\n    void f() {}\n}", 23)).toBe(
      "class A {\n    @Override\n    \n    void f() {}\n}",
    );
    expect(enter('class A {\n    void f() {\n        @SuppressWarnings("x")')).toBe(
      'class A {\n    void f() {\n        @SuppressWarnings("x")\n        ',
    );
    // An incomplete annotation still continues onto an indented line, and code indents as usual.
    expect(enter("@Api(")).toBe("@Api(\n  ");
    expect(enter("class A {\n  void f() {\n    if (x) {")).toBe("class A {\n  void f() {\n    if (x) {\n      ");
    expect(enter("@interface Foo {")).toBe("@interface Foo {\n  ");
  });

  it("colours `this`, `super` and Rust's `self` as keywords", async () => {
    const highlighter = tagHighlighter([
      { tag: t.keyword, class: "keyword" },
      { tag: t.self, class: "self" },
      { tag: t.atom, class: "atom" },
    ]);
    for (const [mode, path, doc, expected] of [
      ["Java", "/p/A.java", "class A extends B { A() { super(); this.a = 1; } }", ["super", "this"]],
      ["JavaScript", "/p/a.js", "class A extends B { m() { super.m(); this.a = 1; } }", ["super", "this"]],
      ["TypeScript", "/p/a.ts", "class A extends B { m() { super.m(); this.a = 1; } }", ["super", "this"]],
      ["C++", "/p/a.cpp", "void A::m() { this->a = 1; }", ["this"]],
      ["Rust", "/p/a.rs", "impl A { fn m(&self) { self.a = 1; } }", ["self", "self"]],
    ] as const) {
      const support = await loadSupport(findLanguageDescription(mode, path)!);
      const found: Array<[string, string]> = [];
      highlightTree(support!.language.parser.parse(doc), highlighter, (from, to, style) =>
        found.push([doc.slice(from, to), style]),
      );
      const words = new Set<string>(expected);
      expect(
        found.filter(([text]) => words.has(text)),
        mode,
      ).toEqual(expected.map((word) => [word, "keyword"]));
    }
  });

  it("recognizes go.mod and go.work files by mode and filename", async () => {
    for (const [mode, path] of [
      ["GoMod", "/project/go.mod"],
      [null, "/project/go.mod"],
      ["GoMod", "/project/go.work"],
      [null, "/project/go.work"],
    ] as const) {
      const desc = findLanguageDescription(mode, path);
      expect(desc?.name).toBe("GoMod");
      const support = await loadSupport(desc!);
      expect(support?.language).toBeTruthy();
    }
  });

  const keywordHighlighter = tagHighlighter([{ tag: t.keyword, class: "keyword" }]);

  function keywords(language: Language, source: string) {
    const found: string[] = [];
    highlightTree(language.parser.parse(source), keywordHighlighter, (from, to) => found.push(source.slice(from, to)));
    return found;
  }

  it("colours Go's `default` branch like the other keywords", async () => {
    const support = await loadSupport(findLanguageDescription("Go", "/p/main.go")!);
    expect(keywords(support!.language, "switch x {\ncase 1:\ndefault:\n}")).toEqual(["switch", "case", "default"]);
  });

  it("colours TOML keys as keywords in files, lock files and ```toml code blocks", async () => {
    for (const path of ["/p/Cargo.toml", "/p/uv.lock"]) {
      const support = await loadSupport(findLanguageDescription("TOML", path)!);
      expect(keywords(support!.language, '[package]\nname = "x"'), path).toEqual(["package", "name"]);
    }
    const fenced = fencedCodeMode("toml")!;
    expect(fenced.name).toBe("TOML");
    const language =
      fenced.language instanceof LanguageDescription ? (await fenced.language.load()).language : fenced.language;
    expect(keywords(language, 'name = "x"')).toEqual(["name"]);
  });

  const propertiesHighlighter = tagHighlighter([
    { tag: t.keyword, class: "keyword" },
    { tag: t.operator, class: "operator" },
    { tag: t.string, class: "string" },
    { tag: t.comment, class: "comment" },
    { tag: t.heading, class: "heading" },
  ]);

  function highlightProperties(language: Language, source: string) {
    const found: Array<[string, string]> = [];
    highlightTree(language.parser.parse(source), propertiesHighlighter, (from, to, style) =>
      found.push([source.slice(from, to), style]),
    );
    return found;
  }

  it("colours properties and .env keys as keywords, the first separator as an operator and the whole value as a string", async () => {
    const support = await loadSupport(findLanguageDescription("Properties files", "/p/.env")!);
    const source = [
      "APP_NAME=core-user",
      "DATABASE_URL=postgres://u:p@h:5432/db",
      "APP_KEY=base64:abc==",
      "key = value",
      "key: value",
      "export A=b",
      "# c",
      "[section]",
      "a=b\\",
      "  c",
      "=x",
      // A blank line ends a continued value.
      "d=e\\",
      "",
      "f=g",
    ].join("\n");
    expect(highlightProperties(support!.language, source)).toEqual([
      ["APP_NAME", "keyword"],
      ["=", "operator"],
      ["core-user", "string"],
      ["DATABASE_URL", "keyword"],
      ["=", "operator"],
      ["postgres://u:p@h:5432/db", "string"],
      ["APP_KEY", "keyword"],
      ["=", "operator"],
      ["base64:abc==", "string"],
      ["key ", "keyword"],
      ["=", "operator"],
      [" value", "string"],
      ["key", "keyword"],
      [":", "operator"],
      [" value", "string"],
      ["export A", "keyword"],
      ["=", "operator"],
      ["b", "string"],
      ["# c", "comment"],
      ["[section]", "heading"],
      ["a", "keyword"],
      ["=", "operator"],
      ["b\\", "string"],
      ["  c", "string"],
      ["=", "operator"],
      ["x", "string"],
      ["d", "keyword"],
      ["=", "operator"],
      ["e\\", "string"],
      ["f", "keyword"],
      ["=", "operator"],
      ["g", "string"],
    ]);
  });

  it("colours properties keys in ```ini and ```properties code blocks", async () => {
    for (const info of ["ini", "properties"]) {
      const fenced = fencedCodeMode(info)!;
      expect(fenced.name, info).toBe("Properties files");
      const language =
        fenced.language instanceof LanguageDescription ? (await fenced.language.load()).language : fenced.language;
      expect(highlightProperties(language, "a=b"), info).toEqual([
        ["a", "keyword"],
        ["=", "operator"],
        ["b", "string"],
      ]);
    }
  });
  it("colours Typst markup, embedded code and math", async () => {
    const support = await loadSupport(findLanguageDescription("Typst", "/p/notes.typ")!);
    const highlighter = tagHighlighter([
      { tag: t.keyword, class: "keyword" },
      { tag: t.comment, class: "comment" },
      { tag: t.heading, class: "heading" },
      { tag: t.strong, class: "strong" },
      { tag: t.emphasis, class: "emphasis" },
      { tag: t.string, class: "string" },
      { tag: t.number, class: "number" },
      { tag: t.function(t.variableName), class: "function" },
      { tag: t.labelName, class: "label" },
      { tag: t.monospace, class: "raw" },
      { tag: t.atom, class: "atom" },
    ]);
    const source = [
      "#set page(width: 10cm)",
      "// note",
      "= Intro <intro>",
      "Some *bold* and _it_ in snake_case, `raw` and $x^2$ see @intro.",
      "#let total = 1 + 2",
      "#if true [yes]",
      "```rust",
      "let x = 1;",
      "```",
    ].join("\n");
    const found: string[] = [];
    highlightTree(support!.language.parser.parse(source), highlighter, (from, to, cls) =>
      found.push(`${source.slice(from, to)}:${cls}`),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "#set:keyword",
        "page:function",
        "10cm:number",
        "// note:comment",
        "= Intro :heading",
        "<intro>:label",
        "*bold*:strong",
        "_it_:emphasis",
        "`raw`:raw",
        "$:keyword",
        "@intro:label",
        "#let:keyword",
        "1:number",
        "#if:keyword",
        "true:atom",
        "```rust:raw",
        "let x = 1;:raw",
      ]),
    );
    expect(found.filter((f) => f.endsWith(":emphasis"))).toEqual(["_it_:emphasis"]);
    expect(found).not.toContain("yes:keyword");
  });
});
