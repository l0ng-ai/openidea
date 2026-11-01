import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { foldable, getIndentation, language as languageFacet } from "@codemirror/language";
import { Tree, TreeFragment } from "@lezer/common";
import { highlightTree, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";
import { openideaHighlightStyle } from "./highlight";

const fixture = readFileSync("fixtures/astro-app/src/pages/index.astro", "utf8");

function tokens(doc: string, tree: Tree) {
  const result: { text: string; cls: string }[] = [];
  highlightTree(tree, openideaHighlightStyle, (from, to, cls) => result.push({ text: doc.slice(from, to), cls }));
  return result;
}

async function support() {
  const desc = findLanguageDescription("Astro", "/p/src/pages/index.astro")!;
  expect(desc.name).toBe("Astro");
  expect(findLanguageDescription(null, "/p/index.astro")?.name).toBe("Astro");
  return (await loadSupport(desc))!;
}

describe("Astro mode", () => {
  it("highlights TypeScript frontmatter, component attributes, JSX expressions and scoped CSS", async () => {
    const mode = await support();
    const found = tokens(fixture, mode.language.parser.parse(fixture));
    for (const [text, tag] of [
      ["import", t.keyword],
      ["interface", t.keyword],
      ["Props", t.typeName],
      ["string", t.typeName],
      ["Layout", t.typeName],
      ["h1", t.tagName],
      ["class", t.attributeName],
      ["item", t.variableName],
      ["color", t.propertyName],
    ] as const) {
      expect(found, text).toContainEqual({ text, cls: openideaHighlightStyle.style([tag]) });
    }
    expect(
      found.some((token) => token.text.includes("One") && token.cls === openideaHighlightStyle.style([t.string])),
    ).toBe(true);
    const state = EditorState.create({ doc: fixture, extensions: mode });
    expect(state.facet(languageFacet)?.name).toBe("astro");
    expect(state.languageDataAt("commentTokens", fixture.indexOf("const"))).toContainEqual({
      line: "//",
      block: { open: "/*", close: "*/" },
    });
    expect(state.languageDataAt("commentTokens", fixture.indexOf("color"))).toContainEqual({
      block: { open: "/*", close: "*/" },
    });
    expect(foldable(state, 0, 3)).not.toBeNull();
    expect(getIndentation(state, fixture.indexOf("  <h1>"))).toBe(2);
  });

  it("uses TypeScript in scripts and expressions and respects script attributes", async () => {
    const mode = await support();
    const doc =
      '<script>const count: number = 1;</script>\n<script lang="tsx">const node = <b />;</script>\n<p>{value as string}</p>';
    const found = tokens(doc, mode.language.parser.parse(doc));
    expect(found).toContainEqual({ text: "number", cls: openideaHighlightStyle.style([t.typeName]) });
    expect(found).toContainEqual({ text: "string", cls: openideaHighlightStyle.style([t.typeName]) });
    expect(found).toContainEqual({ text: "b", cls: openideaHighlightStyle.style([t.tagName]) });
  });

  it("keeps HTML comment delimiters inside frontmatter strings in TypeScript", async () => {
    const { parser } = (await support()).language;
    const doc = '---\nconst end = "-->";\ninterface Props { title: string }\n---\n<h1>{end}</h1>';
    const found = tokens(doc, parser.parse(doc));
    expect(found).toContainEqual({ text: "interface", cls: openideaHighlightStyle.style([t.keyword]) });
    expect(found).toContainEqual({ text: "Props", cls: openideaHighlightStyle.style([t.typeName]) });
    expect(found).toContainEqual({ text: "h1", cls: openideaHighlightStyle.style([t.tagName]) });
  });

  it.each([
    ["red", "rgb(255, 0, 0)"],
    ["{item}</p>", "{item.toLowerCase()}</p>"],
    ["title={title}", "title={title ?? 'Fallback'}"],
  ])("reparses changed embedded region %s", async (before, after) => {
    const { parser } = (await support()).language;
    const first = parser.parse(fixture);
    const from = fixture.indexOf(before);
    const edited = fixture.slice(0, from) + after + fixture.slice(from + before.length);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(first), [
      { fromA: from, toA: from + before.length, fromB: from, toB: from + after.length },
    ]);
    expect(tokens(edited, parser.parse(edited, fragments))).toEqual(tokens(edited, parser.parse(edited)));
  });

  it("reuses HTML subtrees and produces the same highlights after edits as a fresh parse", async () => {
    const { parser } = (await support()).language;
    const doc = fixture + "<section>\n<p>{title}</p>\n".repeat(300) + "</section>\n".repeat(300);
    const first = parser.parse(doc);
    const from = doc.indexOf("One");
    const updated = doc.slice(0, from) + "First" + doc.slice(from + 3);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(first), [
      { fromA: from, toA: from + 3, fromB: from, toB: from + 5 },
    ]);
    const incremental = parser.parse(updated, fragments);
    expect(tokens(updated, incremental)).toEqual(tokens(updated, parser.parse(updated)));
    const trees = (tree: Tree): Tree[] => [
      tree,
      ...tree.children.flatMap((child) => (child instanceof Tree ? trees(child) : [])),
    ];
    const original = new Set(trees(first));
    expect(trees(incremental).some((tree) => original.has(tree))).toBe(true);
    // A document changing language boundaries must also match a fresh parse.
    const noFence = updated.slice(3);
    const withoutFence = parser.parse(
      noFence,
      TreeFragment.applyChanges(TreeFragment.addTree(incremental), [{ fromA: 0, toA: 3, fromB: 0, toB: 0 }]),
    );
    expect(tokens(noFence, withoutFence)).toEqual(tokens(noFence, parser.parse(noFence)));
  });

  it.each([
    ["HTML", "index.html", "html"],
    ["TypeScript", "app.ts", "typescript"],
    ["JavaScript", "app.js", "javascript"],
    ["CSS", "app.css", "css"],
    ["Vue", "App.vue", "vue"],
    ["Angular Template", "app.html", "angular"],
  ])("preserves %s mode", async (name, path, expected) => {
    const mode = await loadSupport(findLanguageDescription(name, path)!);
    expect(mode?.language.name).toBe(expected);
  });
});
