import { afterEach, describe, expect, it } from "vitest";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, HighlightStyle, highlightingFor, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
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
    // The stream parser retains the doc-comment flag when the opener is above the range.
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

  it.each(["Java", "Kotlin", "TypeScript", "PHP"])("rejects non-doc lookalikes in %s", async (language) => {
    const path = { Java: "A.java", Kotlin: "a.kt", TypeScript: "a.ts", PHP: "a.php" }[language]!;
    const s = await state(
      language,
      path,
      [
        language === "PHP" ? "<?php" : "",
        "@Override class A {}",
        "// @Override {@link X}",
        "/* @Override {@link X} */",
        "/* plain",
        " * @param falsePositive",
        " */",
        'const s = "/** @param string */";',
        "/**/",
        "/** dev@example.com",
        " * @return unfinished",
      ].join("\n"),
    );
    // Java and PHP do not expose unterminated block comments as comment syntax nodes.
    expect(ranges(s, language)).toEqual(language === "Java" || language === "PHP" ? [] : [["@return", "tag"]]);
  });

  it.each(["Java", "Kotlin"])("keeps tags deep inside a long %s doc comment", async (language) => {
    const doc = ["/**", ...Array.from({ length: 19997 }, () => " * @param item description"), " */", ""].join("\n");
    const s = await state(language, language === "Java" ? "A.java" : "a.kt", doc);
    expect(
      docCommentTagRanges(s, language, s.doc.line(19000).from, s.doc.line(19001).to).filter((r) => r.kind === "tag"),
    ).toHaveLength(2);
  });

  it("keeps Kotlin nested comments in their outer comment's dialect", async () => {
    const doc = "/* plain\n/** @param hidden */\n * @return hidden\n */\n/** docs\n/* nested */\n * @return shown\n */";
    const s = await state("Kotlin", "a.kt", doc);
    expect(ranges(s, "Kotlin")).toEqual([["@return", "tag"]]);
  });

  it("rebuilds decorations when the highlighter is reconfigured", async () => {
    const support = await loadSupport(findLanguageDescription("Java", "A.java")!);
    const theme = new Compartment();
    const view = new EditorView({
      parent: document.body,
      state: completedSyntaxState(
        EditorState.create({
          doc: "/** @return result */",
          extensions: [support!, theme.of(syntaxHighlighting(openideaHighlightStyle))],
        }),
      ),
    });
    views.push(view);
    const replacement = HighlightStyle.define([{ tag: docCommentTag, color: "red" }]);
    view.dispatch({ effects: theme.reconfigure(syntaxHighlighting(replacement)) });
    const cls = highlightingFor(view.state, [docCommentTag])!;
    expect(view.contentDOM.querySelector(`.${cls}`)?.textContent).toBe("@return");
    view.dispatch({ changes: { from: 2, to: 3, insert: "" } });
    expect(view.contentDOM.querySelector(`.${cls}`)).toBeNull();
  });

  it("removes decorations when switching to an unsupported language", async () => {
    const language = new Compartment();
    const support = await loadSupport(findLanguageDescription("Java", "A.java")!);
    const view = new EditorView({
      parent: document.body,
      state: completedSyntaxState(
        EditorState.create({
          doc: "/** @return result */",
          extensions: [language.of(support!), syntaxHighlighting(openideaHighlightStyle)],
        }),
      ),
    });
    views.push(view);
    const cls = highlightingFor(view.state, [docCommentTag])!;
    expect(view.contentDOM.querySelector(`.${cls}`)?.textContent).toBe("@return");
    view.dispatch({ effects: language.reconfigure([]) });
    expect(view.contentDOM.querySelector(`.${cls}`)).toBeNull();
  });

  it("keeps tag marks inside backend syntax and semantic comment marks", async () => {
    const support = await loadSupport(findLanguageDescription("Java", "A.java")!);
    const doc = "/** @return result */";
    const view = new EditorView({
      parent: document.body,
      state: completedSyntaxState(
        EditorState.create({
          doc,
          extensions: [
            support!,
            syntaxHighlighting(openideaHighlightStyle),
            Prec.high(
              EditorView.decorations.of(
                Decoration.set(Decoration.mark({ class: "backend-comment" }).range(0, doc.length)),
              ),
            ),
            Prec.highest(
              EditorView.decorations.of(
                Decoration.set(Decoration.mark({ class: "cm-sem-comment" }).range(0, doc.length)),
              ),
            ),
          ],
        }),
      ),
    });
    views.push(view);
    const cls = highlightingFor(view.state, [docCommentTag])!;
    const tag = view.contentDOM.querySelector(`.${cls}`)!;
    expect(tag.textContent).toBe("@return");
    expect(tag.closest(".backend-comment")).not.toBeNull();
    expect(tag.closest(".cm-sem-comment")).not.toBeNull();
    expect(tag.children.length).toBe(0);
  });

  it("gives other languages nothing", async () => {
    const s = await state("Rust", "/p/a.rs", "/** @param x */\nfn f() {}");
    expect(ranges(s, "Rust")).toEqual([]);
    for (const language of ["Rust", "PluginLanguage", "constructor", "toString"]) {
      expect(ranges(s, language)).toEqual([]);
      expect(docCommentTags(language)).toEqual([]);
    }
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

  it("gives a doc comment's text the doc comment style, as IntelliJ does, and a plain comment none", async () => {
    // Lezer grammars have one node for `/* */` and `/** */` alike, so without this a JavaDoc
    // would take the plain comment colour.
    for (const [language, path, prefix] of [
      ["Java", "/p/A.java", ""],
      ["JavaScript", "/p/a.js", ""],
      ["TypeScript", "/p/a.ts", ""],
      ["PHP", "/p/a.php", "<?php\n"],
    ] as const) {
      const support = await loadSupport(findLanguageDescription(language, path)!);
      const doc = `${prefix}/**\n * Books a room.\n * @param id the id\n */\n/* Plain note. */\n`;
      const view = new EditorView({
        parent: document.body,
        state: completedSyntaxState(
          EditorState.create({ doc, extensions: [support!, syntaxHighlighting(openideaHighlightStyle)] }),
        ),
      });
      views.push(view);
      const cls = highlightingFor(view.state, [tags.docComment])!;
      const styled = [...view.contentDOM.querySelectorAll(`.${cls}`)].map((e) => e.textContent).join("|");
      expect(styled, language).toContain("Books a room.");
      expect(styled, language).not.toContain("Plain note.");
      // The tags keep their own style, nested inside the doc comment's.
      const tag = view.contentDOM.querySelector(`.${highlightingFor(view.state, [docCommentTag])!}`);
      expect(tag?.textContent, language).toBe("@param");
      expect(tag?.closest(`.${cls}`), language).not.toBeNull();
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
