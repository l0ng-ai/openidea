import { describe, expect, it } from "vitest";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

describe("language modes", () => {
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
});
