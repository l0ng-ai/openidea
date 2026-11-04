import { describe, expect, it } from "vitest";
import { joinPath, previewLineAtOffset, previewOffsetForLine, renderMarkdown, resolveLink, slugify } from "./render";

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
