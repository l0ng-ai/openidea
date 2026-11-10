import { describe, expect, it } from "vitest";
import {
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
    expect(joinPath("/repo", "../../a.md")).toBe("/a.md");
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
});
