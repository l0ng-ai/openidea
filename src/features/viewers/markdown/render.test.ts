import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMath } from "@/editor/lsp/markdownMath";
import {
  createMarkdownRenderer,
  frontMatter,
  joinPath,
  previewLineAtOffset,
  previewOffsetForLine,
  renderMarkdown,
  resolveLink,
  slugify,
} from "./render";

describe("front matter", () => {
  const skill =
    "---\nname: review\ndescription: Reviews a diff: bugs first\ntools:\n  - Read\n  - Grep\nmeta:\n  owner: team\n---\n\n# Review\n\nBody\n";

  it("shows every top-level field above the body, nested values as written", () => {
    expect(frontMatter(skill)).toEqual({
      fields: [
        ["name", "review"],
        ["description", "Reviews a diff: bugs first"],
        ["tools", "  - Read\n  - Grep"],
        ["meta", "  owner: team"],
      ],
      lines: 9,
    });
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(skill);
    const blocks = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")];
    expect(blocks.map((b) => [b.dataset.line, b.firstElementChild?.tagName])).toEqual([
      ["0", "TABLE"],
      ["10", "H1"],
      ["12", "P"],
    ]);
    const rows = [...root.querySelectorAll("table[data-front-matter] tr")].map((r) => [
      r.querySelector("th")?.textContent,
      r.querySelector("td")?.textContent,
    ]);
    expect(rows[1]).toEqual(["description", "Reviews a diff: bugs first"]);
    expect(root.querySelector("td pre")?.textContent).toBe("- Read\n- Grep");
  });

  it("leaves a document without front matter, or a thematic break, alone", () => {
    expect(frontMatter("# Title\n---\nx: y\n---\n")).toBeNull();
    expect(frontMatter("---\nJust a paragraph between rules.\n---\n")).toBeNull();
    expect(frontMatter("---\n---\n")).toBeNull();
  });
});

describe("markdown preview rendering", () => {
  it("links repeated footnote references to a multiline definition and back to each citation", () => {
    const text = [
      "Ayer et al. [^10], again [^10].",
      "",
      "[^10]: Ayer et al. (1955).",
      "",
      "    [Paper](https://doi.org/10.1214/aoms/1177728423).",
      "",
      "## Appendix",
    ].join("\n");
    const root = document.createElement("div");
    root.innerHTML = createMarkdownRenderer()(text);
    const note = root.querySelector('[role="doc-footnote"]')!;
    const citations = [...root.querySelectorAll('sup > [role="doc-noteref"]')];
    const backlinks = [...note.querySelectorAll('[role="doc-backlink"]')];
    expect(citations.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["[1]", "#user-content-footnote:1"],
      ["[1]", "#user-content-footnote:1"],
    ]);
    expect(note.id).toBe("user-content-footnote:1");
    expect(note.closest("[data-line]")?.getAttribute("data-line")).toBe("6");
    expect(note.querySelector('a[href^="https:"]')?.textContent).toBe("Paper");
    expect(backlinks.map((link) => link.getAttribute("href"))).toEqual(citations.map((link) => "#" + link.id));
    expect(backlinks.map((link) => link.parentElement)).toEqual([
      note.querySelector("p:last-child"),
      note.querySelector("p:last-child"),
    ]);
    expect(note.closest("[data-line]")?.previousElementSibling?.textContent?.trim()).toBe("Appendix");
  });

  it("puts footnotes after the document body in citation order even when the definitions are out of order", () => {
    const text = "First [^a], second [^b].\n\n[^b]: Second note.\n\n[^a]: First note.\n\n## Appendix";
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(text);
    const endnotes = root.lastElementChild?.firstElementChild;
    expect(endnotes?.getAttribute("role")).toBe("doc-endnotes");
    expect(endnotes?.firstElementChild?.tagName).toBe("HR");
    expect(root.children[1]?.textContent?.trim()).toBe("Appendix");
    expect(
      [...endnotes!.querySelectorAll(':scope > [role="doc-footnote"]')].map((note) => [
        note.firstElementChild?.textContent,
        note.querySelector("p")?.textContent,
      ]),
    ).toEqual([
      ["1", "First note. ↩"],
      ["2", "Second note. ↩"],
    ]);
  });

  it("keeps code and unresolved footnotes literal and numbers each preview independently", () => {
    const render = createMarkdownRenderer();
    const text = "Known [^a], missing [^b], code `[^a]`.\n\n[^a]: A note.\n\n```md\n[^b]: Code\n```";
    const first = render(text);
    const root = document.createElement("div");
    root.innerHTML = render("Other [^c].\n\n[^c]: Other note.");
    expect(root.querySelector('[role="doc-noteref"]')?.textContent).toBe("[1]");
    expect(render(text)).toBe(first);
    root.innerHTML = first;
    expect(root.querySelector("code")?.textContent).toBe("[^a]");
    expect(root.querySelector("p")?.textContent).toBe("Known [1], missing [^b], code [^a].");
    expect(root.querySelectorAll('[role="doc-footnote"]')).toHaveLength(1);
  });

  it("tags blocks with their source line", () => {
    const html = renderMarkdown("# Title\n\nPara one\nstill one\n\n- a\n- b\n");
    const root = document.createElement("div");
    root.innerHTML = html;
    const lines = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((e) => [
      e.dataset.line,
      e.firstElementChild?.tagName,
    ]);
    expect(lines).toEqual([
      ["0", "H1"],
      ["2", "P"],
      ["5", "UL"],
    ]);
    expect(root.querySelector("h1")?.id).toBe("user-content-title");
  });

  it("sanitizes and defers image loading", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      '<script>alert(1)</script>\n\n![x](img/a.png) <a href="javascript:alert(1)">j</a>\n',
    );
    expect(root.querySelector("script")).toBeNull();
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.dataset.src).toBe("img/a.png");
    expect(root.querySelector("a")?.getAttribute("href")).toBeNull();
  });

  it.each([
    "<style>body{outline:7px solid red}</style>",
    '<form action="https://example.com/x"><button>go</button></form>',
    '<div style="position:fixed">x</div>',
    '<link rel="stylesheet" href="https://example.com/x.css">',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<base href="https://example.com/">',
    '<iframe src="https://example.com"></iframe>',
    '<button formaction="https://example.com/x">go</button>',
  ])("keeps raw markup from reaching the page: %s", (raw) => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(`text\n\n${raw}\n`);
    expect(root.querySelector("style, form, link, meta, base, iframe, [style], [formaction]")).toBeNull();
    expect(root.textContent).not.toContain("outline");
  });

  it("lets only a link name another host", () => {
    const at = (name: string) => `https://example.com/${name}`;
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      [
        `[A link](${at("link")})`,
        `<img src="a.png" srcset="b.png 1x, ${at("srcset")} 2x">`,
        `<picture><source srcset="${at("source")}"><img src="a.png"></picture>`,
        `<input type="image" src="${at("input")}">`,
        `<video poster="${at("poster")}" src="${at("video")}"></video>`,
        `<table background="${at("table")}"><tr><td background="${at("cell")}">cell</td></tr></table>`,
        '<input type="image" src="//example.com/no-scheme">',
        String.raw`<input type="image" src="/\example.com/mixed">`,
      ].join("\n\n"),
    );
    const named = [...root.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes]
        .filter((attr) => attr.value.includes("example.com"))
        .map((attr) => `${el.localName}[${attr.name}]`),
    );
    expect(named).toEqual(["a[href]"]);
    expect([...root.querySelectorAll("img")].map((img) => img.dataset.src)).toEqual(["a.png", "a.png"]);
    expect(root.querySelector("td")?.textContent).toBe("cell");
  });

  it("keeps the raw HTML READMEs rely on", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      '<div align="center"><img src="a.png" width="20"></div>\n\n<details><summary>More</summary>x</details>\n\n- [x] done\n',
    );
    expect(root.querySelector("div[align='center'] img")?.getAttribute("width")).toBe("20");
    expect(root.querySelector("details summary")).not.toBeNull();
    expect(root.querySelector("input[type='checkbox']")).not.toBeNull();
  });

  const blocks = (md: string) => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(md);
    const lines = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((e) => [
      e.dataset.line,
      e.firstElementChild?.tagName,
    ]);
    return { root, lines };
  };

  it("keeps Markdown between a container's tags inside it (#1524)", () => {
    const { root, lines } = blocks("<details>\n<summary>Summary</summary>\n\nContent\n\n</details>\n\nAfter\n");
    const details = root.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector(":scope > summary")?.textContent).toBe("Summary");
    expect(details.querySelector(":scope > p")?.textContent).toBe("Content");
    expect(root.querySelector(":scope > [data-line] > p")?.textContent).toBe("After");
    expect(lines).toEqual([
      ["0", "DETAILS"],
      ["7", "P"],
    ]);
  });

  it.each([
    ["close right after the text", "<details>\n<summary>S</summary>\n\nContent\n</details>\n", "details > p"],
    ["kept open", "<details open>\n<summary>S</summary>\n\n- a\n- b\n\n</details>\n", "details[open] > ul > li"],
    ["a centred README header", '<div align="center">\n\n# Title\n\n</div>\n', "div[align='center'] > h1"],
    [
      "an aligned mermaid container",
      '<div align="left" style="width: 960px;">\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n</div>\n',
      "div[align='left']:not([style]) > [data-mermaid]",
    ],
    ["a section", "<section>\n\n```js\nx\n```\n\n</section>\n", "section > pre > code"],
    ["upper case", "<DETAILS>\n<SUMMARY>S</SUMMARY>\n\nContent\n\n</DETAILS>\n", "details > p"],
    ["a list item", "- item\n  <details>\n  <summary>S</summary>\n\n  body\n\n  </details>\n", "li details"],
  ])("renders the content of a container: %s", (_, md, selector) => {
    expect(blocks(md).root.querySelector(selector)).not.toBeNull();
  });

  it("nests containers and ends each at its own close", () => {
    const { root, lines } = blocks(
      "<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\ninner\n\n</details>\n\nouter\n\n</details>\n\nafter\n",
    );
    const [outer, inner] = [...root.querySelectorAll("details")];
    expect(inner!.parentElement).toBe(outer);
    expect(inner!.querySelector(":scope > p")?.textContent).toBe("inner");
    expect(outer!.querySelector(":scope > p")?.textContent).toBe("outer");
    expect(lines).toEqual([
      ["0", "DETAILS"],
      ["14", "P"],
    ]);
  });

  it("leaves blocks alone when the container is closed in its own block or only mentioned", () => {
    expect(blocks("<details><summary>S</summary>x</details>\n\nNext\n").lines).toEqual([
      ["0", "DETAILS"],
      ["2", "P"],
    ]);
    expect(blocks("<!-- <details> -->\n\nOne\n\nTwo\n").lines.map(([l]) => l)).toEqual(["0", "2", "4"]);
    expect(blocks("```html\n<details>\n```\n\nOne\n\n`<div>` code\n\nTwo\n").lines.map(([l]) => l)).toEqual([
      "0",
      "4",
      "6",
      "8",
    ]);
    expect(blocks('<img src="a.png" alt="<div>">\n\n<br/>\n\nOne\n').lines.map(([l]) => l)).toEqual(["0", "2", "4"]);
  });

  it("keeps everything after a container that's never closed inside it", () => {
    const { root, lines } = blocks("Intro\n\n<details>\n<summary>S</summary>\n\nOne\n\nTwo\n");
    expect([...root.querySelectorAll("details > p")].map((p) => p.textContent)).toEqual(["One", "Two"]);
    expect(lines).toEqual([
      ["0", "P"],
      ["2", "DETAILS"],
    ]);
  });

  it("ignores a stray close", () => {
    expect(blocks("One\n\n</div>\n\nTwo\n").lines.map(([l]) => l)).toEqual(["0", "2", "4"]);
    expect(blocks("</details>\n\n<details>\n<summary>S</summary>\n\nIn\n\n</details>\n\nOut\n").lines).toEqual([
      ["0", undefined],
      ["2", "DETAILS"],
      ["9", "P"],
    ]);
  });

  it("dedupes heading anchors", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("## Same\n\n## Same\n");
    expect([...root.querySelectorAll("h2")].map((h) => h.id)).toEqual(["user-content-same", "user-content-same-1"]);
    expect(slugify("Hello, World! v2")).toBe("hello-world-v2");
  });

  it("resolves links against the file", () => {
    const file = "/repo/docs/guide.md";
    expect(resolveLink(file, "https://x.dev")).toEqual({ kind: "external", url: "https://x.dev" });
    expect(resolveLink(file, "#setup")).toEqual({ kind: "anchor", id: "setup" });
    expect(resolveLink(file, "../src/main.rs#L12")).toEqual({ kind: "file", path: "/repo/src/main.rs", line: 11 });
    expect(resolveLink(file, "other%20file.md#intro")).toEqual({
      kind: "file",
      path: "/repo/docs/other file.md",
      anchor: "intro",
    });
    expect(resolveLink(file, "javascript:alert(1)")).toBeNull();
    expect(joinPath("C:/repo/docs", "../a.md")).toBe("C:/repo/a.md");
    expect(joinPath("C:/repo/docs", "D:/shared/a.md")).toBe("D:/shared/a.md");
    expect(joinPath("/repo", "../../a.md")).toBe("/a.md");
  });

  // On Windows, opening `//server/share` signs in to that server with the user's credentials.
  it("resolves no link to a network share, however the file spells it", () => {
    const file = "C:/repo/docs/guide.md";
    for (const href of [
      "/\\evil/share/x.png",
      "/%5Cevil/share/x.png",
      "//evil/share/x.png",
      "/%2Fevil/share/x.png",
      "file:///%5Cevil/share/x.png",
      "file:////evil/share/x.png",
      "%5C%5Cevil%5Cshare%5Cx.png",
    ]) {
      expect(resolveLink(file, href), href).toBeNull();
    }
    expect(resolveLink("/guide.md", "../%5Cevil/share/x.png"), "file at the root").toBeNull();
    expect(resolveLink(file, "/docs/a.png")).toEqual({ kind: "file", path: "/docs/a.png" });
  });

  it("interpolates the preview offset between blocks", () => {
    const blocks = [
      { line: 0, top: 0 },
      { line: 10, top: 100 },
    ];
    expect(previewOffsetForLine(blocks, 5, 400)).toBe(50);
    expect(previewOffsetForLine(blocks, 10, 400)).toBe(100);
    expect(previewOffsetForLine(blocks, 10.5, 400)).toBe(250);
    expect(previewOffsetForLine([], 3, 400)).toBe(0);
  });

  it("finds the block at the top of a scrolled preview", () => {
    const blocks = [
      { line: 2, top: 0 },
      { line: 10, top: 100 },
      { line: 20, top: 300 },
    ];
    expect(previewLineAtOffset(blocks, 0)).toBe(2);
    expect(previewLineAtOffset(blocks, 99)).toBe(10);
    expect(previewLineAtOffset(blocks, 299)).toBe(20);
    expect(previewLineAtOffset(blocks, 250)).toBe(10);
    expect(previewLineAtOffset(blocks, 5000)).toBe(20);
    expect(previewLineAtOffset([], 50)).toBe(0);
  });

  it("reads only the offsets needed to locate the last block at the viewport top", () => {
    let reads = 0;
    const blocks = Array.from({ length: 1024 }, (_, line) => ({
      line,
      get top() {
        reads++;
        return Math.floor(line / 2) * 20;
      },
    }));
    expect(previewLineAtOffset(blocks, 999)).toBe(101);
    expect(reads).toBe(10);
  });

  it("renders LaTeX math blocks with source lines and inline math", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("# Heading\n\n$$\nx^2 + y^2 = z^2\n$$\n\nInline $a_1 + b_2$.\n");
    expect(root.querySelectorAll("[data-math]")).toHaveLength(2);
    renderMath(root);
    const lines = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((e) => e.dataset.line);
    expect(lines).toEqual(["0", "2", "6"]);
    expect(root.querySelector(".katex-display")).not.toBeNull();
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
  });
});

describe("markdown preview re-rendering", () => {
  afterEach(() => vi.restoreAllMocks());

  const blocks = [
    "---\ntitle: Notes\n---",
    "# Title",
    "# Title",
    "Some *text* with [a ref][r] and a footnote-ish [b].",
    "[r]: https://example.com/r\n[b]: ./b.md",
    "<details>\n<summary>More</summary>",
    "- inside\n- the container",
    "</details>",
    '<p align="center"><img src="logo.png" alt="logo"></p>',
    "```mermaid\ngraph TD; A-->B\n```",
    "```ts\nconst a = <div>x</div>;\n```",
    "| a | b |\n|---|---|\n| 1 | <b>2</b> |",
    '<span is="x-span">custom</span> and <body class="x"> and </body> text',
    "> quote\n> more",
    "$$\nx^2 + y^2 = z^2\n$$",
    "Inline $a_1 + b_2$ math.",
    "Last paragraph.",
  ];
  const doc = (parts: readonly string[]) => parts.join("\n\n") + "\n";
  /** Renders `text` with `render` and checks it against the whole-document render. */
  const same = (render: (text: string) => string, text: string) => expect(render(text)).toBe(renderMarkdown(text));

  it("renders what the whole document renders, before and after each block is edited", () => {
    const render = createMarkdownRenderer();
    same(render, doc(blocks));
    same(render, doc(blocks));
    for (const i of blocks.keys()) {
      same(render, doc(blocks.map((b, j) => (j === i ? `${b} edited` : b))));
      same(render, doc(blocks.filter((_, j) => j !== i)));
    }
    same(render, "");
    same(render, doc(blocks));
  });

  it("renders a large document as a whole, sanitizing only what an edit changed", { timeout: 20_000 }, () => {
    const asWritten = readFileSync(resolve(import.meta.dirname, "../../../../plugins/README.md"), "utf8");
    // As written, a bare `<title>` swallows the rest of the file, so it is rendered as a whole.
    for (const [readme, reuses] of [
      [asWritten.replace('"<title> failed', '"`<title>` failed'), true],
      [asWritten, false],
    ] as const) {
      const render = createMarkdownRenderer();
      same(render, readme);
      for (const at of [0.1, 0.5, 0.9]) {
        const from = Math.floor(readme.length * at);
        const i = from + readme.slice(from).search(/\n\n[A-Z][a-z]/) + 2;
        const edited = `${readme.slice(0, i)}Typed ${readme.slice(i)}`;
        const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
        const html = render(edited);
        const sanitized = parse.mock.calls.map(([dirty]) => String(dirty));
        parse.mockRestore();
        expect(html).toBe(renderMarkdown(edited));
        expect(sanitized).toHaveLength(1);
        expect(sanitized[0]!.includes("data-marker")).toBe(reuses);
        if (reuses) expect(sanitized[0]!.length).toBeLessThan(2000);
      }
    }
  });

  it("sanitizes only the blocks an edit changed", () => {
    const render = createMarkdownRenderer();
    render(doc(blocks));
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    same(render, doc(blocks.map((b) => (b === "Last paragraph." ? "Last paragraph, edited." : b))));
    const sanitized = parse.mock.calls.map(([html]) => String(html));
    expect(sanitized.filter((html) => html.includes("Last paragraph, edited."))).toHaveLength(2);
    expect(sanitized.filter((html) => html.includes("quote"))).toHaveLength(1);
  });

  // In one pass, an unclosed tag carries into the blocks after it.
  it.each([
    ["formatting", "Bold <b>starts here"],
    ["link", '<a href="https://example.com">open link'],
    ["raw text", "<textarea>"],
    ["select", "<select><option>a"],
    ["template", "<template>"],
    ["comment", "<!-- never closed"],
    ["object", "<object>"],
    ["frameset", "<frameset>"],
    ["plaintext", "<plaintext>"],
    ["early close", "</div><p>x</p><div>"],
    ["svg", "<svg><foreignObject>"],
    ["close of the wrapper", "Text with a stray </div> close."],
  ])("renders a block that leaks into the next (%s) as the whole document does", (_, leak) => {
    const render = createMarkdownRenderer();
    const parts = [...blocks.slice(0, 8), leak, ...blocks.slice(8)];
    same(render, doc(parts));
    same(render, doc(parts));
    same(render, doc([...parts, "One more."]));
    same(render, doc(blocks));
  });

  it.each([
    ["formatting", "Bold <b>starts here", "ends here</b>."],
    ["link", '<a href="https://example.com">open link', "closed</a> here."],
    ["raw text", "<textarea>", "</textarea>"],
    ["object", "<object>", "</object>"],
    ["comment", "<!-- opens here", "closes here -->"],
  ])("renders a tag that closes in a later block (%s) as the whole document does", (_, opens, closes) => {
    const render = createMarkdownRenderer();
    const parts = [...blocks.slice(0, 8), opens, "Between.", closes, ...blocks.slice(8)];
    same(render, doc(parts));
    same(render, doc(parts.map((b) => (b === "Between." ? "Between, edited." : b))));
    same(render, doc(parts.filter((b) => b !== opens)));
    same(render, doc(parts.filter((b) => b !== closes)));
    same(render, doc(parts));
  });

  it("renders forms and framesets, which change how the parser reads later blocks, as the whole document does", () => {
    const render = createMarkdownRenderer();
    same(render, doc(["Text", "<frameset>"]));
    same(render, doc(["<frameset>"]));
    same(render, doc(["<p>one<form>two", "<p>three<form>four"]));
    same(render, doc(["<p>three<form>four"]));
    same(render, doc(["Text", "<p>three<form>four"]));
  });

  it("renders the whole document in one pass while a block leaks", () => {
    const render = createMarkdownRenderer();
    const text = doc(["Bold <b>starts here", "Still bold."]);
    render(text);
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    const html = render(text);
    expect(parse.mock.calls.map(([dirty]) => String(dirty))).toEqual([
      expect.stringMatching(/starts here[\s\S]*Still bold/),
    ]);
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector('[data-line="2"] b')?.textContent).toBe("Still bold.");
  });
});
