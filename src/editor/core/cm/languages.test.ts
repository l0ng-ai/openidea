import { describe, expect, it } from "vitest";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { logWarning } from "./highlight";
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
});
