import { describe, expect, it, vi } from "vitest";

// A fresh module per test: the parser is loaded lazily and cached module-wide.
async function freshMarkdown() {
  vi.resetModules();
  return import("./markdown");
}

describe("markdown rendering", () => {
  it.each([
    "<style>body{outline:7px solid red}</style>",
    '<form action="https://example.com/x"><button>go</button></form>',
    '<div style="position:fixed">x</div>',
    '<link rel="stylesheet" href="https://example.com/x.css">',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<base href="https://example.com/">',
    '<iframe src="https://example.com"></iframe>',
    '<button formaction="https://example.com/x">go</button>',
  ])("keeps raw markup from reaching the page: %s", async (raw) => {
    const md = await freshMarkdown();
    await md.loadMarkdown();
    const root = document.createElement("div");
    root.innerHTML = md.markupToHtml({ kind: "markdown", value: `text\n\n${raw}\n` });
    expect(root.querySelector("style, form, link, meta, base, iframe, [style], [formaction]")).toBeNull();
    expect(root.textContent).not.toContain("outline");
  });

  it("keeps the links and tables comments and docs rely on", async () => {
    const md = await freshMarkdown();
    await md.loadMarkdown();
    const root = document.createElement("div");
    root.innerHTML = md.markupToHtml({
      kind: "markdown",
      value: "[doc](jdt://contents/a.class) [web](https://example.com)\n\n| A |\n| - |\n| 1 |\n",
    });
    expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "jdt://contents/a.class",
      "https://example.com",
    ]);
    expect(root.querySelector("td")?.textContent).toBe("1");
  });

  it("shows plain text until the parser loads, then the rendered markup", async () => {
    const md = await freshMarkdown();
    const el = md.renderMarkup({ kind: "markdown", value: "**bold** <img src=x onerror=alert(1)>" });
    expect(el.querySelector(".cm-lsp-plain")?.textContent).toBe("**bold** <img src=x onerror=alert(1)>");
    await md.loadMarkdown();
    await vi.waitFor(() => expect(el.querySelector("strong")?.textContent).toBe("bold"));
    expect(el.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });

  it("renders synchronously once loaded", async () => {
    const md = await freshMarkdown();
    await md.loadMarkdown();
    expect(md.markupToHtml({ kind: "markdown", value: "`x`" })).toBe("<p><code>x</code></p>\n");
    expect(md.markupToHtml({ kind: "plaintext", value: "<b>" })).toBe('<p class="cm-lsp-plain">&#60;b&#62;</p>');
  });
});
