import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, highlightingFor, syntaxHighlighting } from "@codemirror/language";
import { completedSyntaxState } from "@/test/syntax";
import { docCommentMarkup, docCommentTag, docCommentTagValue, openideaHighlightStyle } from "./highlight";
import { findLanguageDescription, loadSupport } from "./languages";
import { docCommentTagRanges, docCommentTags } from "./docCommentTags";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

async function state(language: string, path: string, doc: string) {
  const support = await loadSupport(findLanguageDescription(language, path)!);
  return completedSyntaxState(EditorState.create({ doc, extensions: [support!] }));
}

function ranges(s: EditorState, language: string, from = 0) {
  return docCommentTagRanges(s, language, from, s.doc.length).map((r) => [s.sliceDoc(r.from, r.to), r.kind]);
}

describe("doc comment tags", () => {
  it("marks JavaDoc block and inline tags, @param values and HTML markup", async () => {
    const s = await state(
      "Java",
      "/p/A.java",
      [
        "/**",
        " * Sums {@link Math#addExact} values, mail dev@example.com.",
        " * <p>Second @param paragraph, List<String> stays text.</p>",
        " * @param <T> the type",
        " * @param left the left",
        " * @return the sum",
        " * @throws ArithmeticException on overflow",
        " */",
        "/* @param plain */",
        "// @param line",
        'class A { String s = "/** @param x */"; /**/ }',
        "/** @deprecated use {@link B} */",
      ].join("\n"),
    );
    expect(ranges(s, "Java")).toEqual([
      ["@link", "tag"],
      ["<p>", "markup"],
      ["</p>", "markup"],
      ["@param", "tag"],
      ["<T>", "value"],
      ["@param", "tag"],
      ["left", "value"],
      ["@return", "tag"],
      ["@throws", "tag"],
      ["@deprecated", "tag"],
      ["@link", "tag"],
    ]);
  });

  it("marks KDoc tags, their subjects and [links], also when the comment starts above the range", async () => {
    const doc = [
      "/**",
      " * Adds [a] to b, see [Math.max] or [the docs](https://example.com).",
      " * @param a the a",
      " * @throws IllegalStateException never",
      " * @return the sum, {@link Foo} is not KDoc",
      " */",
      "fun f(a: Int) = a // @param x",
      "/* @param plain */",
    ].join("\n");
    const s = await state("Kotlin", "/p/a.kt", doc);
    expect(ranges(s, "Kotlin")).toEqual([
      ["[a]", "value"],
      ["[Math.max]", "value"],
      ["@param", "tag"],
      ["a", "value"],
      ["@throws", "tag"],
      ["IllegalStateException", "value"],
      ["@return", "tag"],
    ]);
    // The Kotlin lexer gives each comment line its own node: the opener is found above the range.
    expect(ranges(s, "Kotlin", doc.indexOf(" * @throws"))).toEqual([
      ["@throws", "tag"],
      ["IllegalStateException", "value"],
      ["@return", "tag"],
    ]);
  });

  it("marks JSDoc tags in JavaScript, TypeScript, JSX and TSX", async () => {
    const doc = [
      "/**",
      " * Formats {@link Date} values for user@example.com.",
      " * @param {string} name the name",
      " * @returns {string}",
      " */",
      "/* @param plain */",
      "const s = '/** @param x */';",
    ].join("\n");
    for (const [language, path] of [
      ["JavaScript", "/p/a.js"],
      ["TypeScript", "/p/a.ts"],
      ["JSX", "/p/a.jsx"],
      ["TSX", "/p/a.tsx"],
    ] as const) {
      const s = await state(language, path, doc);
      expect(ranges(s, language), language).toEqual([
        ["@link", "tag"],
        ["@param", "tag"],
        ["@returns", "tag"],
      ]);
    }
  });

  it("marks PHPDoc tags and the variable of @param and @var", async () => {
    const s = await state(
      "PHP",
      "/p/a.php",
      [
        "<?php",
        "/**",
        " * Finds a user, {@inheritDoc}",
        " * @param int|string $id the id",
        " * @param array<int, string> ...$rest",
        " * @var Foo&Bar $x",
        " * @return ?User",
        " */",
        "function find($id) {} # @param $y",
        "/* @param int $z */",
      ].join("\n"),
    );
    expect(ranges(s, "PHP")).toEqual([
      ["@inheritDoc", "tag"],
      ["@param", "tag"],
      ["$id", "value"],
      ["@param", "tag"],
      ["$rest", "value"],
      ["@var", "tag"],
      ["$x", "value"],
      ["@return", "tag"],
    ]);
  });

  it("gives other languages nothing", async () => {
    const s = await state("Rust", "/p/a.rs", "/** @param x */\nfn f() {}");
    expect(ranges(s, "Rust")).toEqual([]);
    expect(docCommentTags("Rust")).toEqual([]);
  });

  it("styles the tags with the highlight style's classes, inside the comment's own", async () => {
    const support = await loadSupport(findLanguageDescription("Java", "/p/A.java")!);
    const doc = "/**\n * See <b>this</b>.\n * @param id the id\n */\nclass A {}";
    const highlight = syntaxHighlighting(openideaHighlightStyle);
    // The language support brings the tags; whichever comes first, they nest inside the comment's marks.
    for (const extensions of [
      [support!, highlight],
      [highlight, support!],
    ]) {
      const view = new EditorView({
        parent: document.body,
        state: completedSyntaxState(EditorState.create({ doc, extensions })),
      });
      views.push(view);
      for (const [text, tag] of [
        ["@param", docCommentTag],
        ["id", docCommentTagValue],
        ["<b>", docCommentMarkup],
      ] as const) {
        const cls = highlightingFor(view.state, [tag])!;
        const span = view.contentDOM.querySelector(`.${cls}`);
        expect(span?.textContent).toBe(text);
        expect(span?.children.length).toBe(0);
      }
    }
  });

  it("keeps the tags of a line that a fold splits into two visible ranges", async () => {
    const support = await loadSupport(findLanguageDescription("Java", "/p/A.java")!);
    const doc = "/** See {@link A} and some text long enough to fold away, then {@link B}. */\nclass A {}";
    const view = new EditorView({
      parent: document.body,
      state: completedSyntaxState(
        EditorState.create({ doc, extensions: [support!, syntaxHighlighting(openideaHighlightStyle), codeFolding()] }),
      ),
    });
    views.push(view);
    view.dispatch({ effects: foldEffect.of({ from: doc.indexOf("some"), to: doc.indexOf(", then") }) });
    expect(view.visibleRanges.length).toBe(2);
    const cls = highlightingFor(view.state, [docCommentTag])!;
    expect([...view.contentDOM.querySelectorAll(`.${cls}`)].map((e) => e.textContent)).toEqual(["@link", "@link"]);
  });
});
