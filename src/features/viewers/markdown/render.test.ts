import { describe, expect, it } from "vitest";
import { joinPath, previewOffsetForLine, renderMarkdown, resolveLink, slugify } from "./render";

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

  it("renders fenced excalidraw code blocks as inline SVG diagrams", () => {
    const md = [
      "# Architecture",
      "",
      "```excalidraw",
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [
          {
            id: "node-1",
            type: "rectangle",
            x: 20,
            y: 30,
            width: 140,
            height: 60,
            strokeColor: "#1e1e1e",
            backgroundColor: "#a5d8ff",
            fillStyle: "solid",
            label: { text: "Gateway" },
          },
        ],
      }),
      "```",
    ].join("\n");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(md);
    const block = root.querySelector<HTMLElement>("[data-excalidraw-block]");
    expect(block).not.toBeNull();
    expect(block?.querySelector("svg")).not.toBeNull();
    expect(block?.textContent).toContain("Gateway");
  });
});
