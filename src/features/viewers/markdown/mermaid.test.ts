import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./render";
import { hasMermaid, renderMermaidIn, resetMermaidForTests } from "./mermaid";

const m = vi.hoisted(() => ({
  loads: 0,
  initialize: vi.fn(),
  render: vi.fn(async (id: string, text: string) => {
    // Like mermaid: a measuring node under <body> while rendering.
    const tmp = document.createElement("div");
    tmp.id = `d${id}`;
    document.body.append(tmp);
    if (text.includes("bad")) throw new Error("Parse error on line 2:\nbad\n^");
    return { svg: `<svg id="${id}"><text>${text.split("\n")[0]}</text></svg>` };
  }),
}));

vi.mock("mermaid", () => {
  m.loads++;
  return { default: { initialize: m.initialize, render: m.render } };
});

function preview(md: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(md);
  document.body.append(root);
  return root;
}

const SEQ = "```mermaid\nsequenceDiagram\n    A->B:test\n```\n";

describe("mermaid in the markdown preview", () => {
  beforeEach(() => {
    resetMermaidForTests();
    m.render.mockClear();
    m.initialize.mockClear();
    document.body.innerHTML = "";
  });

  it("emits a placeholder holding the escaped source, other code blocks unchanged", () => {
    const root = preview(
      `# T\n\n${SEQ}\n\`\`\`js\nlet a = 1;\n\`\`\`\n\n\`\`\`Mermaid title\ngraph TD\n  a["<b>x</b>"]-->b\n\`\`\`\n`,
    );
    const blocks = root.querySelectorAll<HTMLElement>("[data-mermaid]");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.parentElement?.dataset.line).toBe("2");
    expect(blocks[0]!.querySelector("pre > code.language-mermaid")?.textContent).toBe("sequenceDiagram\n    A->B:test");
    expect(blocks[1]!.querySelector("code")?.textContent).toContain('a["<b>x</b>"]');
    expect(blocks[1]!.querySelector("b")).toBeNull();
    expect(root.querySelector("code.language-js")?.closest("[data-mermaid]")).toBeNull();
  });

  it("loads mermaid only for previews with a diagram", async () => {
    const plain = preview("# Plain\n\n```js\n1\n```\n");
    expect(hasMermaid(plain)).toBe(false);
    const pass = renderMermaidIn(plain);
    expect(pass.async).toBe(false);
    await pass.done;
    expect(m.loads).toBe(0);

    const root = preview(SEQ);
    expect(hasMermaid(root)).toBe(true);
    await renderMermaidIn(root).done;
    expect(m.loads).toBe(1);
    expect(m.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", theme: "base" }),
    );
    const block = root.querySelector<HTMLElement>("[data-mermaid]")!;
    expect(block.getAttribute("data-mermaid-state")).toBe("ok");
    expect(block.querySelector(".mermaid-output svg")).not.toBeNull();
    // Temporary nodes mermaid leaves under <body> are removed.
    expect(document.body.querySelector(":scope > [id^='d']")).toBeNull();
  });

  it("shows syntax errors inline next to the source without throwing", async () => {
    const root = preview("```mermaid\nsequenceDiagram\nbad\n```\n");
    await expect(renderMermaidIn(root).done).resolves.toBeUndefined();
    const block = root.querySelector<HTMLElement>("[data-mermaid]")!;
    expect(block.getAttribute("data-mermaid-state")).toBe("error");
    expect(block.querySelector("pre code")?.textContent).toContain("bad");
    const error = block.querySelector(".mermaid-output")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Parse error on line 2");
    expect(error.querySelector("svg")).toBeNull();
  });

  it("renders with unique ids, reuses results and keeps the old diagram while a new one renders", async () => {
    const first = preview(SEQ);
    await renderMermaidIn(first, []).done;
    const ids = new Set(m.render.mock.calls.map(([id]) => id));

    // Same source again (e.g. an edit elsewhere): drawn synchronously from the cache.
    const previous: Node[] = [];
    const again = preview(SEQ);
    const pass = renderMermaidIn(again, previous);
    expect(pass.async).toBe(false);
    expect(again.querySelector("[data-mermaid-state='ok'] svg")).not.toBeNull();
    expect(m.render).toHaveBeenCalledTimes(1);

    // Edited diagram: the previous drawing stands in until the new one is ready.
    const edited = preview(SEQ.replace("test", "edited"));
    const next = renderMermaidIn(edited, previous);
    expect(next.async).toBe(true);
    expect(edited.querySelector(".mermaid-output svg")?.textContent).toBe("sequenceDiagram");
    await next.done;
    expect(m.render).toHaveBeenCalledTimes(2);
    ids.add(m.render.mock.calls[1]![0]);
    expect(ids.size).toBe(2);
  });

  it("skips superseded renders", async () => {
    const root = preview(SEQ.replace("test", "stale"));
    const pass = renderMermaidIn(root);
    pass.cancel();
    await pass.done;
    expect(m.render).not.toHaveBeenCalled();
    expect(root.querySelector("[data-mermaid]")?.getAttribute("data-mermaid-state")).toBe("pending");
  });
});
