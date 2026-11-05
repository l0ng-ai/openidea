import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { fragmentOffset, linkReference, looksLikePath, resolvePath, textReference } from "./links";

const at = (src: string, marker = "|") => {
  const offset = src.indexOf(marker);
  return { text: Text.of(src.replace(marker, "").split("\n")), offset };
};

describe("text references", () => {
  it("finds URLs, trimming trailing punctuation", () => {
    const { text, offset } = at("// see https://exa|mple.com/a?b=1.");
    expect(textReference(text, offset)).toMatchObject({ kind: "url", url: "https://example.com/a?b=1" });
  });

  it("finds quoted paths in any language", () => {
    const { text, offset } = at('df = open("data/x|.csv")');
    expect(textReference(text, offset)).toMatchObject({ kind: "path", value: "data/x.csv" });
    expect(textReference(...(Object.values(at("<link href='sty|le.css'>")) as [Text, number]))).toMatchObject({
      value: "style.css",
    });
  });

  it("finds Markdown link targets and unquoted CSS urls", () => {
    let { text, offset } = at("See [theme](css/the|me.css#L1) now");
    expect(textReference(text, offset)).toMatchObject({ kind: "path", value: "css/theme.css#L1" });
    ({ text, offset } = at(".a { background: url(img/lo|go.svg); }"));
    expect(textReference(text, offset)).toMatchObject({ kind: "path", value: "img/logo.svg" });
  });

  it("finds fragment-only link targets", () => {
    for (const source of ["[artist::order](#Artist-or|der)", '<a href="#Artist-or|der">order</a>']) {
      const { text, offset } = at(source);
      expect(textReference(text, offset)).toMatchObject({ kind: "path", value: "#Artist-order" });
    }
  });

  it("does not treat arbitrary fragment strings as links", () => {
    for (const source of ['const color = "#ff|f"', '<a id="Artist-or|der">', "url(#ic|on)"]) {
      const { text, offset } = at(source);
      expect(textReference(text, offset)).toBeNull();
    }
  });

  it("ignores prose and identifiers", () => {
    expect(looksLikePath("hello world.txt")).toBe(false);
    expect(looksLikePath("utf-8")).toBe(false);
    expect(looksLikePath("main")).toBe(false);
    expect(looksLikePath("http://x")).toBe(false);
    expect(looksLikePath("../a/b")).toBe(true);
    expect(looksLikePath("logo.svg#icon")).toBe(true);
    const { text, offset } = at('log("do|ne")');
    expect(textReference(text, offset)).toBeNull();
  });
});

describe("links and fragments", () => {
  it("resolves local fragments without probing the filesystem", async () => {
    const ref = { kind: "path" as const, from: 5, to: 20, value: "#Artist%2Dorder" };
    expect(await resolvePath(ref, "/p/notes.md")).toEqual({
      kind: "file",
      from: 5,
      to: 20,
      path: "/p/notes.md",
      fragment: "Artist-order",
    });
    expect(await resolvePath({ ...ref, value: "#bad%" }, "/p/notes.md")).toBeNull();
  });

  it("picks the server link around the offset", () => {
    const text = Text.of(['<a href="b.html#top">']);
    const range = { start: { line: 0, col: 9 }, end: { line: 0, col: 19 } };
    const link = { range, path: "/p/b.html", fragment: "top", url: null, tooltip: null };
    expect(linkReference(text, [link], 12)).toMatchObject({ kind: "file", path: "/p/b.html", fragment: "top" });
    expect(linkReference(text, [link], 2)).toBeNull();
  });

  it("locates line, element id and Markdown heading fragments", () => {
    expect(fragmentOffset("a\nbc\nd", "/x.ts", "L2")).toBe(2);
    expect(fragmentOffset("a\nbc\nd", "/x.ts", "L2,2")).toBe(3);
    const html = '<p>\n<div class="x" id="main">';
    expect(fragmentOffset(html, "/i.html", "main")).toBe(html.indexOf("id="));
    expect(fragmentOffset("# Intro\n\n## Getting Started!\n", "/r.md", "getting-started")).toBe(9);
    for (const path of ["/r.md", "/r.markdown", "/r.mdx"]) {
      for (const attr of ["id", "name"]) {
        const source = `[artist::order](#Artist-order)\n\n<a ${attr}="Artist-order"></a>`;
        expect(fragmentOffset(source, path, "Artist-order")).toBe(source.indexOf(`${attr}=`));
      }
    }
    expect(fragmentOffset("x", "/i.html", "nope")).toBeNull();
  });
});
