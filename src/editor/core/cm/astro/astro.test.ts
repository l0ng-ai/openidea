import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { buildParserFile } from "@lezer/generator";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "../languages";
import { pasteReindentFilter } from "../prefs";
import { astro, astroLanguage } from "./index";

const highlighter = tagHighlighter([
  { tag: t.processingInstruction, class: "fence" },
  { tag: t.definitionKeyword, class: "def-kw" },
  { tag: t.keyword, class: "keyword" },
  { tag: t.typeName, class: "type" },
  { tag: t.function(t.variableName), class: "call" },
  { tag: t.variableName, class: "var" },
  { tag: t.propertyName, class: "prop" },
  { tag: t.attributeName, class: "attr" },
  { tag: t.attributeValue, class: "value" },
  { tag: t.string, class: "str" },
  { tag: t.operator, class: "op" },
  { tag: t.brace, class: "brace" },
  { tag: t.tagName, class: "tag" },
  { tag: t.comment, class: "comment" },
  { tag: t.invalid, class: "invalid" },
]);

/** `text:class` of the styled tokens of `doc`. */
function tokens(doc: string): string[] {
  const out: string[] = [];
  highlightTree(astroLanguage.parser.parse(doc), highlighter, (from, to, cls) =>
    out.push(`${doc.slice(from, to)}:${cls}`),
  );
  return out;
}

/** A layout with what made HTML mode misread Astro components. */
const LAYOUT = `---
import '@/styles/global.css'
import Header from '@/components/Header.astro'

interface Props {
  title: string
  visibility?: 'public' | 'private'
}

const { title, visibility = 'private' } = Astro.props
// The canonical URL drops the trailing slash, as <link rel="canonical"> expects.
const pageUrl = new URL(Astro.url.pathname.replace(/(.)\\/$/u, '$1'), Astro.url).href
const image = { path: '/og.png', width: 1200 }
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    {visibility === 'private' && <meta name="robots" content="noindex" />}
    {visibility === 'public' && (
      <>
        <link rel="canonical" href={pageUrl} />
        <meta property="og:image" content={new URL(image.path, Astro.url).href} />
      </>
    )}
    <title>{title}</title>
  </head>
  <body class="page">
    <Header {title} {...Astro.props} />
    <slot />
  </body>
</html>

<style is:global>
  ::view-transition-old(root) {
    display: none;
  }
</style>

<script>
  document.addEventListener('astro:after-swap', () => {
    const style = document.head.querySelector('style[data-emotion]')
    if (!style) {
      return
    }
    style.remove()
  })
</script>
`;

describe("Astro components", () => {
  it("parses the frontmatter as TypeScript, markup in its comments included", () => {
    const doc = "---\ninterface P { title: string }\nconst a = 'x' // on <html>\n---\n<p>{a}</p>";
    const out = tokens(doc);
    expect(out).toEqual(
      expect.arrayContaining([
        "---:fence",
        "interface:def-kw",
        "string:type",
        "const:def-kw",
        "'x':str",
        "// on <html>:comment",
        "p:tag",
        "a:var",
      ]),
    );
    expect(out).not.toContain("html:tag");
  });

  it("parses expressions in text, fragments and markup inside them included", () => {
    const out = tokens(
      "<head>\n  {v === 'p' && <meta name=\"robots\" />}\n  {ok && (\n    <>\n      <b>{n}</b>\n    </>\n  )}\n</head>",
    );
    expect(out).toEqual(
      expect.arrayContaining(["v:var", "===:op", "'p':str", "&&:op", "meta:tag", "name:attr", "n:var"]),
    );
    expect(out.filter((s) => s.endsWith(":invalid"))).toEqual([]);
  });

  it("parses expressions in tags, with spaces, shorthands and spreads", () => {
    const out = tokens(
      '<meta content={new URL(img.path, Astro.url).href} title="{literal}" />\n<C {title} {...rest} />',
    );
    expect(out).toEqual(expect.arrayContaining(["content:attr", "new:keyword", "img:var", "title:var", "rest:var"]));
    expect(out).not.toContain("URL(img.path,:attr");
    expect(out).toContain('"{literal}":value');
  });

  it("parses scripts as TypeScript and leaves styles to CSS", () => {
    const out = tokens("<script>\n  const n: number = 1\n</script>\n<style>\n  p { color: red; }\n</style>");
    expect(out).toEqual(expect.arrayContaining(["const:def-kw", "number:type", "script:tag", "style:tag"]));
  });

  it("keeps a well-indented component unchanged when it is pasted", () => {
    const state = EditorState.create({
      extensions: [astro(), indentUnit.of("  "), EditorState.tabSize.of(2), pasteReindentFilter("indentEachLine")],
    });
    const pasted = state.update({ changes: { from: 0, insert: LAYOUT }, userEvent: "input.paste" }).state;
    expect(pasted.doc.toString()).toBe(LAYOUT);
  });

  it("is generated from astro.grammar", () => {
    const dir = import.meta.dirname;
    const { parser, terms } = buildParserFile(readFileSync(resolve(dir, "astro.grammar"), "utf8"), {
      fileName: "src/editor/core/cm/astro/astro.grammar",
      moduleStyle: "es",
      typeScript: true,
    });
    expect(parser).toBe(readFileSync(resolve(dir, "parser.ts"), "utf8"));
    expect(terms).toBe(readFileSync(resolve(dir, "parser.terms.ts"), "utf8"));
  });

  it("is the Astro mode", async () => {
    const desc = findLanguageDescription("Astro", "/site/src/pages/index.astro");
    expect((await loadSupport(desc!))?.language).toBe(astroLanguage);
  });
});
